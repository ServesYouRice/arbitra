import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runConfigSchema } from "@arbitra/schemas/config.js";
import type { HttpRequest } from "@arbitra/providers/transport-contract.js";
import { modelFeatureExploration } from "../src/model-feature-exploration.js";
import { modelRequirements } from "../src/model-requirements.js";
import { snapshotRepository } from "../src/repository.js";
import { RunStore } from "../src/run-store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function decode(request: HttpRequest): { system: string; input: Record<string, unknown> } {
  const body = request.body as { input?: { role: string; content: string }[] };
  const user = body.input?.find(({ role }) => role === "user")?.content ?? "";
  const layers = user.split("\n").map((line) => JSON.parse(line) as { layer: string; value: { instruction?: string; artifacts?: string[] } });
  const framed = layers.flatMap(({ value }) => value.artifacts ?? [])[0] ?? "";
  const content = /-->\n([\s\S]*)\n<\/repository_content>$/u.exec(framed)?.[1] ?? "{}";
  return { system: layers.find(({ layer }) => layer === "instruction")?.value.instruction ?? "",
    input: JSON.parse(content.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")) as Record<string, unknown> };
}

// Three acceptance records that cannot share one exploration context, and whose complete draft
// exceeds one response.
const ACCEPTANCE = [1, 2, 3].map((index) => ({ id: `acc-${index}`, assertion: `Exact acceptance ${index}: ` + `Preference ${index} survives session renewal without widening access. `.repeat(330) }));
const RECORDS = new Map<string, Record<string, unknown>>([
  ["assumption", { id: "assumption", statement: "Keep existing sessions", confidence: "high" }],
  ["migration", { id: "migration", question: "Migrate stored sessions?", proposedDefault: "Keep sessions", blastRadius: "high" }],
  ...ACCEPTANCE.map((record) => [record.id, record] as const),
]);
const INDEX = { requirements: [{ id: "assumption", kind: "assumption", title: "Existing sessions" }, { id: "migration", kind: "ambiguity", title: "Session migration" }, ...ACCEPTANCE.map(({ id }) => ({ id, kind: "acceptance", title: `Preference ${id}` }))], outOfScope: ["Billing changes"] };

it.each(["complete", "interrupted"] as const)("drafts and explores oversized Feature requirements through durable staged paths: %s", async (scenario) => {
  const root = await mkdtemp(join(tmpdir(), "feature-drafting-")); roots.push(root);
  await writeFile(join(root, "session.ts"), "export const version = 1;\n");
  const snapshot = await snapshotRepository(root);
  const example = runConfigSchema.parse(JSON.parse(await readFile(new URL("../../../examples/audit-balanced.json", import.meta.url), "utf8")));
  const profile = example.models["auditor-a"];
  if (profile === undefined) throw new Error("FIXTURE_PROFILE_ABSENT");
  const config = runConfigSchema.parse({ ...example, mode: "feature", scope: { kind: "repository" }, models: { analyst: { ...profile, limits: { ...profile.limits, contextTokens: 60_000 } } }, workflow: {
    modelExecution: { endpoints: [{ id: "primary", providerId: profile.provider, transport: profile.transport, endpoint: "https://fixture.example/v1", apiKeyEnvVar: "FIXTURE_KEY" }],
      modelEndpoints: { analyst: "primary" }, maximumOutputTokens: 2000, maximumTokens: 100_000_000, maximumRetries: 0, timeoutMs: 30_000,
      rateLimits: { [profile.provider]: { rpm: 100_000, tpm: 100_000_000, maxConcurrent: 4 } } },
  } });
  const calls: { stage: string; input: Record<string, unknown> }[] = [];
  let interrupt = scenario === "interrupted";
  const transport = { credential: () => "fixture-credential", client: { async send(request: HttpRequest) {
    const { system, input } = decode(request);
    const respond = (stage: string, output: unknown) => { calls.push({ stage, input }); return { status: 200, headers: {}, body: { output_text: JSON.stringify(output), usage: { input_tokens: 20, output_tokens: 30 } } }; };
    const truncated = (stage: string) => { calls.push({ stage, input }); return { status: 200, headers: {}, body: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output_text: '{"assumptions":[', usage: { input_tokens: 20, output_tokens: 2000 } } }; };
    // The complete draft and any record batch of more than two records exceed the output ceiling.
    if (system.startsWith("Derive a requirements draft")) return truncated("requirements-full");
    if (system.startsWith("The complete requirements draft")) return respond("requirements-index", INDEX);
    if (system.startsWith("Write the complete requirement records")) {
      const ids = (input["draftScope"] as { requirementIds: string[] }).requirementIds;
      if (ids.length > 2) return truncated("requirements-records");
      if (interrupt && ids.includes("acc-1")) { interrupt = false; calls.push({ stage: "interrupted", input }); throw new Error("FIXTURE_INTERRUPTED"); }
      const kind = (id: string) => INDEX.requirements.find((entry) => entry.id === id)?.kind;
      return respond("requirements-records", { assumptions: ids.filter((id) => kind(id) === "assumption").map((id) => RECORDS.get(id)), ambiguities: ids.filter((id) => kind(id) === "ambiguity").map((id) => RECORDS.get(id)), acceptance: ids.filter((id) => kind(id) === "acceptance").map((id) => RECORDS.get(id)) });
    }
    if (system.startsWith("Explore affected surfaces for the approved")) return respond("exploration-full", {});
    if (system.startsWith("Explore affected surfaces for one batch")) {
      const ids = (input["requirements"] as { requirementScope: { requirementIds: string[] } }).requirementScope.requirementIds;
      return respond("exploration-batch", { summary: `Batch ${ids.join(",")}`, limitations: [],
        preflight: { affectedSurfaces: [{ id: "sessions", paths: ["session.ts"], riskCategories: [`risk-${ids[0] ?? ""}`], relevantTo: ids }], securitySensitiveSurfaceCount: 1, migrationInvolvement: ids.includes("migration"), architectureBreadth: 1, testingComplexity: 1 },
        evidence: [{ surfaceId: "sessions", path: "session.ts", startLine: 1, endLine: 1, text: "export const version = 1;" }] });
    }
    throw new Error(`UNEXPECTED_FEATURE_PROMPT:${system.slice(0, 80)}`);
  } } };
  const options = { modelProfileId: "analyst", mode: "automatic" as const, signal: new AbortController().signal, transport };
  const store = () => new RunStore(join(root, ".runs"), "run");
  const run = async () => {
    const requirements = await modelRequirements(store(), config, snapshot, options);
    await requirements.open("Add session preferences");
    return modelFeatureExploration(store(), config, snapshot, requirements.checkpoint, options);
  };
  if (scenario === "interrupted") await expect(run()).rejects.toThrow("Provider openai failed");
  const { exploration, routing } = await run();
  const stages = calls.map(({ stage }) => stage);
  // The one-call draft was output-limited once and never repeated; oversized record batches split.
  expect(stages.filter((stage) => stage === "requirements-full")).toHaveLength(1);
  expect(stages.filter((stage) => stage === "requirements-index")).toHaveLength(1);
  const written = calls.filter(({ stage }) => stage === "requirements-records").map(({ input }) => (input["draftScope"] as { requirementIds: string[] }).requirementIds).filter((ids) => ids.length <= 2);
  expect(written.flat().sort()).toEqual([...RECORDS.keys()].sort());
  const artifacts = await store().listArtifacts();
  const read = async (kind: string) => JSON.parse((await store().readArtifact(artifacts.filter((entry) => entry.kind === kind).at(-1)?.artifactId ?? "")).content) as Record<string, unknown>;
  // Every indexed record reached the contract verbatim, in index order, with the scope exclusions.
  const contract = await (await modelRequirements(store(), config, snapshot, options)).checkpoint.requireResolved();
  expect(contract).toMatchObject({ assumptions: [RECORDS.get("assumption")], ambiguities: [RECORDS.get("migration")], acceptance: ACCEPTANCE, outOfScope: ["Billing changes"] });
  // Exploration could not read every requirement in one context; each record was explored exactly once.
  expect(stages).not.toContain("exploration-full");
  const explored = calls.filter(({ stage }) => stage === "exploration-batch");
  expect(explored.length).toBeGreaterThan(1);
  for (const { assertion } of ACCEPTANCE) expect(explored.filter(({ input }) => JSON.stringify(input).includes(JSON.stringify(assertion).slice(1, -1)))).toHaveLength(1);
  // One surface merges by identity: requirement links, categories and metrics are never dropped.
  expect(exploration.preflight.affectedSurfaces).toHaveLength(1);
  expect([...exploration.preflight.affectedSurfaces[0]?.relevantTo ?? []].sort()).toEqual([...RECORDS.keys()].sort());
  expect(exploration.preflight.affectedSurfaces[0]?.riskCategories).toHaveLength(explored.length);
  expect(exploration.evidence).toHaveLength(1);
  expect(exploration.preflight).toMatchObject({ securitySensitiveSurfaceCount: 1, migrationInvolvement: true, architectureBreadth: explored.length, testingComplexity: explored.length });
  expect(routing.recommended).toBe("DEEP");
  expect(await read("feature-exploration-batches")).toHaveLength(explored.length);
  // Resume repeats no completed model work; only the interrupted batch was re-sent.
  const before = calls.length;
  expect(await run()).toEqual({ exploration, routing });
  expect(calls).toHaveLength(before);
  const keys = calls.filter(({ stage }) => stage !== "interrupted").map(({ stage, input }) => `${stage}:${JSON.stringify(input)}`);
  expect(new Set(keys).size).toBe(keys.length);
});
