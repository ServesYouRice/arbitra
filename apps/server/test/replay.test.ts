import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runConfigSchema } from "@arbitra/schemas/config.js";
import { planIRSchema } from "@arbitra/schemas/plan.js";
import { Orchestrator } from "@arbitra/runtime/orchestrator.js";
import { controlPlaneCore } from "@arbitra/runtime/control-plane-core.js";
import { orchestratorCore } from "@arbitra/runtime/cli-core.js";
import { buildServer } from "../src/main.js";

/** A low-risk automatic Feature over a fake provider: requirements, exploration, planner. */
async function featureFixture(root: string) {
  await writeFile(join(root, "session.ts"), "export const version = 1;\n");
  const example = runConfigSchema.parse(JSON.parse(await readFile(new URL("../../../examples/audit-balanced.json", import.meta.url), "utf8")));
  const profile = example.models["auditor-a"];
  if (profile === undefined) throw new Error("FIXTURE_PROFILE_ABSENT");
  const config = runConfigSchema.parse({ ...example, mode: "feature", scope: { kind: "repository" }, models: { planner: { ...profile, independenceGroup: "planner" } }, maxConsensusRounds: 1, workflow: {
    preset: "feature-simple", feature: { request: "Add session preferences", mode: "automatic", maximumRequirementsRevisions: 0, roles: { requirements: "planner", exploration: "planner", planner: "planner" } },
    modelExecution: { endpoints: [{ id: "primary", providerId: profile.provider, transport: profile.transport, endpoint: "https://fixture.example/v1", apiKeyEnvVar: "FIXTURE_KEY" }],
      modelEndpoints: { planner: "primary" }, maximumOutputTokens: 2000, maximumTokens: 1000000, maximumRetries: 0, timeoutMs: 2000, rateLimits: { [profile.provider]: { rpm: 100, tpm: 1000000, maxConcurrent: 4 } } },
  } });
  const draft = { assumptions: [{ id: "assumption", statement: "Keep existing sessions", confidence: "high" }], ambiguities: [], acceptance: [{ id: "acceptance", assertion: "New sessions work" }], outOfScope: [] };
  const plan = planIRSchema.parse(JSON.parse(await readFile(new URL("../../../packages/schemas/test/golden/plan-ir.valid.json", import.meta.url), "utf8")));
  plan.mode = "feature"; plan.acceptedIssueIds = []; plan.traceability.issueToValidation = [];
  plan.premiseReport = { status: "unavailable", interpretation: "smoke_test_only_not_proof", limitations: ["real_model_premise_requires_ground_truth_evaluation"] };
  for (const task of plan.tasks) { task.addresses.issues = []; task.addresses.requirements = ["acceptance"]; }
  plan.traceability.requirementLinks.links = [{ requirementId: "acceptance", taskIds: ["TASK-001"], validationIds: ["VAL-001"] }];
  const exploration = { summary: "Session preferences", preflight: { affectedSurfaces: [{ id: "sessions", paths: ["session.ts"], riskCategories: [], relevantTo: ["acceptance"] }], securitySensitiveSurfaceCount: 0, migrationInvolvement: false, architectureBreadth: 1, testingComplexity: 1 },
    evidence: [{ surfaceId: "sessions", path: "session.ts", startLine: 1, endLine: 1, text: "export const version = 1;" }], limitations: [] };
  const calls: string[] = [];
  const providerOptions = { credential: () => "fixture-credential", client: { async send(request: { body: unknown }) {
    const body = request.body as { input?: { role: string; content: string }[] };
    const user = body.input?.find(({ role }) => role === "user")?.content ?? "";
    const system = user.split("\n").map((line) => JSON.parse(line) as { layer: string; value: { instruction?: string } }).find(({ layer }) => layer === "instruction")?.value.instruction ?? "";
    const [stage, output] = system.startsWith("Derive a requirements") ? ["requirements", draft] : system.startsWith("Explore affected") ? ["exploration", exploration] : system.startsWith("Create one coherent") ? ["planner", plan] : ["unexpected", null];
    calls.push(stage);
    if (output === null) throw new Error(`UNEXPECTED_FEATURE_PROMPT:${system}`);
    return { status: 200, headers: {}, body: { output_text: JSON.stringify(output), usage: { input_tokens: 20, output_tokens: 30 } } };
  } } };
  return { config, calls, orchestrator: () => new Orchestrator({ repository: root, providerOptions }) };
}

async function runDigest(directory: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (path: string, relative: string): Promise<void> => {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) await walk(join(path, entry.name), `${relative}${entry.name}/`);
      else hash.update(`${relative}${entry.name}\0`).update(await readFile(join(path, entry.name))).update("\0");
    }
  };
  await walk(directory, "");
  return hash.digest("hex");
}

type Report = { sourceRunId: string; stages: { stage: string; decision: string; reasons: string[]; reused: { activityId: string }[]; regenerated: unknown[] }[] };

it("serves Feature replay over HTTP with the same contract, reuse and gate as the CLI port", async () => {
  const root = await mkdtemp(join(tmpdir(), "replay-http-"));
  const f = await featureFixture(root);
  const orchestrator = f.orchestrator();
  const app = buildServer(controlPlaneCore(orchestrator));
  try {
    const source = await orchestrator.run(f.config);
    expect(source.state).toBe("COMPLETED");
    expect(f.calls).toEqual(["requirements", "exploration", "planner"]);
    const sourceDirectory = join(root, ".runs", "runs", source.runId);
    const before = await runDigest(sourceDirectory);

    const started = await app.inject({ method: "POST", url: `/runs/${source.runId}/replay`, payload: { mode: "feature" } });
    expect(started.statusCode, started.body).toBe(200);
    const resource = started.json<{ runId: string; sourceRunId: string; mode: string; stages: { stage: string; decision: string }[] }>();
    expect(resource).toMatchObject({ sourceRunId: source.runId, mode: "feature" });
    expect(resource.stages.every(({ decision }) => decision === "reuse")).toBe(true);
    expect((await orchestrator.wait(resource.runId)).state).toBe("COMPLETED");
    const http = (await app.inject({ method: "GET", url: `/runs/${resource.runId}/replay` })).json<Report>();

    const requestPath = join(root, "replay.json");
    await writeFile(requestPath, JSON.stringify({ mode: "feature" }));
    const cli = await orchestratorCore(orchestrator).replayRequest(source.runId, requestPath);
    const cliValue = cli.value as { runId: string; gateStatus: string; summary: { replay: Report } };
    expect(cli.disposition).toBe("passed");
    // One orchestrator, one contract: both interfaces make identical reuse decisions.
    const shape = (report: Report) => report.stages.map(({ stage, decision, reasons, reused, regenerated }) => ({ stage, decision, reasons, reused: reused.map(({ activityId }) => activityId), regenerated }));
    expect(shape(cliValue.summary.replay)).toEqual(shape(http));
    expect(http.stages.flatMap(({ reused }) => reused).length).toBe(3);
    expect(f.calls).toHaveLength(3);
    expect((await orchestrator.gate(resource.runId)).gateStatus).toBe(cliValue.gateStatus);

    const mismatch = await app.inject({ method: "POST", url: `/runs/${source.runId}/replay`, payload: { mode: "testing", execution: { mode: "plan" } } });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json()).toMatchObject({ message: "REPLAY_MODE_MISMATCH:feature:testing" });
    expect((await app.inject({ method: "POST", url: `/runs/${source.runId}/replay`, payload: { consensusPolicy: "full" } })).statusCode).toBe(400);
    const stale = await app.inject({ method: "POST", url: `/runs/${source.runId}/replay`, payload: { mode: "feature", requirements: { decision: "reuse_approved", artifactId: "requirements-contract-version-stale" } } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ message: "REPLAY_REQUIREMENTS_CONTRACT_STALE" });
    expect((await app.inject({ method: "GET", url: `/runs/${source.runId}/replay` })).statusCode).toBe(404);
    expect(await runDigest(sourceDirectory)).toBe(before);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
  // Three complete durable Feature runs took 3–6 s alone on a loaded laptop, and longer
  // in a fully parallel suite, so the 5 s default is too tight for this workflow test.
}, 30_000);
