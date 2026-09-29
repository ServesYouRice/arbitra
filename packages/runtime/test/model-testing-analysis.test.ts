import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runConfigSchema } from "@arbitra/schemas/config.js";
import { modelTestingAnalysis } from "../src/model-testing-analysis.js";
import { snapshotRepository } from "../src/repository.js";
import { RunStore } from "../src/run-store.js";
import { TestingPipeline } from "../src/testing-pipeline.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it.each(["complete", "limited", "restart", "invalid-selection", "fabricated-evidence", "non-frontier", "empty"])("runs read-only grounded Testing analysis: %s", async (scenario) => {
  const root = await mkdtemp(join(tmpdir(), "model-testing-")); roots.push(root);
  await writeFile(join(root, "auth.ts"), "export const authorized = false;\n");
  await writeFile(join(root, "auth.unit.test.ts"), "test('unrelated', () => {});\n");
  await writeFile(join(root, "package.json"), '{"scripts":{"test":"vitest run"}}');
  const snapshot = await snapshotRepository(root, 10, { includeTestMetadata: true });
  const example = runConfigSchema.parse(JSON.parse(await readFile(new URL("../../../examples/audit-balanced.json", import.meta.url), "utf8")));
  const profile = example.models["auditor-a"];
  if (profile === undefined) throw new Error("FIXTURE_PROFILE_ABSENT");
  const config = runConfigSchema.parse({ ...example, mode: "testing", scope: { kind: "repository" }, models: { analyst: { ...profile, capabilityTier: scenario === "non-frontier" ? "fast" : "frontier" } }, workflow: {
    testing: { mode: "plan", goal: "Prevent auth failures", roles: { analyst: "analyst", planner: "analyst" } },
    modelExecution: { endpoints: [{ id: "primary", providerId: profile.provider, transport: profile.transport, endpoint: "https://fixture.example/v1", apiKeyEnvVar: "FIXTURE_KEY" }],
      modelEndpoints: { analyst: "primary" }, maximumOutputTokens: 2000, maximumTokens: 1000000, maximumRetries: 0, timeoutMs: 30_000,
      rateLimits: { [profile.provider]: { rpm: 100, tpm: 1000000, maxConcurrent: 4 } } },
  } });
  const risk = { summary: "Auth tests need assertions", surfaces: scenario === "empty" ? [] : [{ id: "auth", paths: ["auth.ts"], categories: ["unit"], severity: "high", failureModes: ["unauthorized access"], evidence: [{ path: "auth.ts", startLine: 1, endLine: 1, text: scenario === "fabricated-evidence" ? "invented" : "export const authorized = false;" }] }],
    reviewedSourcePaths: ["auth.ts"], reviewedTestPaths: scenario === "limited" ? [] : ["auth.unit.test.ts"], limitations: [] };
  const selection = { selectedGapIds: scenario === "empty" || scenario === "invalid-selection" ? [] : ["GAP-auth-1"], rejected: [], limitations: [] };
  const responses: unknown[] = [risk, ...(scenario === "restart" ? [new Error("FIXTURE_INTERRUPTED")] : []), selection];
  let calls = 0;
  const options = { signal: new AbortController().signal, transport: { credential: () => "fixture-credential", client: { async send() {
    calls += 1;
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (response === undefined) throw new Error("UNEXPECTED_PROVIDER_CALL");
    return { status: 200, headers: {}, body: { output_text: JSON.stringify(response), usage: { input_tokens: 20, output_tokens: 30 } } };
  } } } };
  const store = () => new RunStore(join(root, ".runs"), "run");
  if (scenario === "non-frontier") {
    await expect(modelTestingAnalysis(store(), config, snapshot, options)).rejects.toThrow("TESTING_FRONTIER_ANALYST_REQUIRED"); expect(calls).toBe(0); return;
  }
  if (scenario === "fabricated-evidence" || scenario === "invalid-selection") {
    await expect(modelTestingAnalysis(store(), config, snapshot, options)).rejects.toThrow(scenario === "fabricated-evidence" ? "TESTING_EVIDENCE_UNGROUNDED" : "TESTING_SELECTION_INCOMPLETE_OR_INVALID");
    expect((await store().listArtifacts()).some(({ kind }) => kind === "testing-analysis")).toBe(false); return;
  }
  if (scenario === "restart") await expect(modelTestingAnalysis(store(), config, snapshot, options)).rejects.toThrow("Provider openai failed");
  const result = await modelTestingAnalysis(store(), config, snapshot, options);
  expect(result.gaps.map(({ id }) => id)).toEqual(scenario === "empty" ? [] : ["GAP-auth-1"]);
  expect(result.coverageComplete).toBe(scenario !== "limited");
  expect(result.limitations).toEqual(scenario === "limited" ? ["test_not_reviewed:auth.unit.test.ts"] : []);
  expect(result.testsExecuted).toBe(false);
  expect(result.commands[0]?.command).toBe("npm run test");
  expect(await modelTestingAnalysis(store(), config, snapshot, options)).toEqual(result);
  expect(calls).toBe(scenario === "restart" ? 3 : 2);
  expect((await snapshotRepository(root, 10, { includeTestMetadata: true })).files).toEqual(snapshot.files);
});

it("stops Testing planning when analysis finds documentation that the code contradicts", async () => {
  // Observed live: a Testing writer pinned a seeded expiry bug as correct.
  const root = await mkdtemp(join(tmpdir(), "model-testing-conflict-")); roots.push(root);
  const code = "export const isExpired = (expiresAt: number, now: number) => now > expiresAt;";
  await writeFile(join(root, "session.ts"), `/** A session is valid strictly before its expiry instant. */\n${code}\n`);
  await writeFile(join(root, "session.unit.test.ts"), "test('unrelated', () => {});\n");
  await writeFile(join(root, "package.json"), '{"scripts":{"test":"vitest run"}}');
  const snapshot = await snapshotRepository(root, 10, { includeTestMetadata: true });
  const example = runConfigSchema.parse(JSON.parse(await readFile(new URL("../../../examples/audit-balanced.json", import.meta.url), "utf8")));
  const profile = example.models["auditor-a"];
  if (profile === undefined) throw new Error("FIXTURE_PROFILE_ABSENT");
  const config = runConfigSchema.parse({ ...example, mode: "testing", scope: { kind: "repository" }, models: { analyst: { ...profile, capabilityTier: "frontier" } }, workflow: {
    testing: { mode: "plan", goal: "Protect session expiry", roles: { analyst: "analyst", planner: "analyst" } },
    modelExecution: { endpoints: [{ id: "primary", providerId: profile.provider, transport: profile.transport, endpoint: "https://fixture.example/v1", apiKeyEnvVar: "FIXTURE_KEY" }],
      modelEndpoints: { analyst: "primary" }, maximumOutputTokens: 2000, maximumTokens: 1000000, maximumRetries: 0, timeoutMs: 30_000,
      rateLimits: { [profile.provider]: { rpm: 100, tpm: 1000000, maxConcurrent: 4 } } },
  } });
  const risk = { summary: "Session expiry", reviewedSourcePaths: ["session.ts"], reviewedTestPaths: ["session.unit.test.ts"], limitations: [],
    surfaces: [{ id: "expiry", paths: ["session.ts"], categories: ["unit"], severity: "high", failureModes: ["an expired session is accepted"], evidence: [{ path: "session.ts", startLine: 2, endLine: 2, text: code }] }],
    documentedBehaviourConflicts: [{ documentation: { path: "session.ts", startLine: 1, endLine: 1, text: "A session is valid strictly before its expiry instant." },
      code: { path: "session.ts", startLine: 2, endLine: 2, text: "now > expiresAt" }, explanation: "At now === expiresAt the doc comment says expired and the code says valid." }] };
  const responses: unknown[] = [risk, { selectedGapIds: ["GAP-expiry-1"], rejected: [], limitations: [] }];
  let calls = 0;
  const transport = { credential: () => "fixture-credential", client: { async send() {
    calls += 1;
    const response = responses.shift();
    if (response === undefined) throw new Error("UNEXPECTED_PROVIDER_CALL");
    return { status: 200, headers: {}, body: { output_text: JSON.stringify(response), usage: { input_tokens: 20, output_tokens: 30 } } };
  } } };
  const outcome = await new TestingPipeline(new RunStore(join(root, ".runs"), "run"), config, snapshot, transport).run(new AbortController().signal);
  expect(outcome).toMatchObject({ passed: false, reasons: ["documented_behaviour_conflict:session.ts:2"], selectedGaps: 1, planFingerprint: null });
  // No planner call: a test planned against the contradiction would pin one side of it.
  expect(calls).toBe(2);
});
