import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runConfigSchema } from "@arbitra/schemas/config.js";
import { planIRSchema, type PlanIR } from "@arbitra/schemas/plan.js";
import type { HttpRequest } from "@arbitra/providers/transport-contract.js";
import { Orchestrator } from "../src/orchestrator.js";
import { taskOutline } from "../src/planner-context.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const ACCEPTANCE = [1, 2].map((index) => ({ id: `acc-${index}`, assertion: `Exact acceptance ${index}: ` + `Preference ${index} must survive session renewal without widening access. `.repeat(420) }));

function decode(request: HttpRequest): { system: string; input: Record<string, unknown> } {
  const body = request.body as { input?: { role: string; content: string }[]; messages?: { content: string }[] };
  const user = body.input?.find(({ role }) => role === "user")?.content ?? body.messages?.[0]?.content ?? "";
  const layers = user.split("\n").map((line) => JSON.parse(line) as { layer: string; value: { instruction?: string; artifacts?: string[] } });
  const framed = layers.flatMap(({ value }) => value.artifacts ?? [])[0] ?? "";
  const content = /-->\n([\s\S]*)\n<\/repository_content>$/u.exec(framed)?.[1] ?? "{}";
  return { system: layers.find(({ layer }) => layer === "instruction")?.value.instruction ?? "",
    input: JSON.parse(content.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")) as Record<string, unknown> };
}

async function fixture(failExpansion: boolean) {
  const root = await mkdtemp(join(tmpdir(), "feature-staged-")); roots.push(root);
  await writeFile(join(root, "session.ts"), "export const version = 1;\n");
  const example = runConfigSchema.parse(JSON.parse(await readFile(new URL("../../../examples/audit-balanced.json", import.meta.url), "utf8")));
  const profile = example.models["auditor-a"];
  if (profile === undefined) throw new Error("FIXTURE_PROFILE_ABSENT");
  // Reviewers, the planner and the plan critic cannot read all requirement records in one request.
  const limited = { ...profile.limits, contextTokens: 80_000 };
  const models = {
    analyst: { ...profile, independenceGroup: "analyst" },
    planner: { ...profile, independenceGroup: "planner", limits: limited },
    reviewer: { ...profile, provider: "anthropic", transport: "anthropic-messages", structuredOutputDialect: "anthropic_tool", independenceGroup: "reviewer", limits: limited },
    critic: { ...profile, independenceGroup: "critic", limits: limited },
    "plan-critic": { ...profile, independenceGroup: "plan-critic", limits: limited },
  };
  const config = runConfigSchema.parse({ ...example, mode: "feature", scope: { kind: "repository" }, models, maxConsensusRounds: 1, workflow: {
    preset: "feature-simple", feature: { request: "Add session preferences", mode: "automatic", maximumRequirementsRevisions: 0,
      roles: { requirements: "analyst", exploration: "analyst", planner: "planner", reviewers: ["reviewer", "critic"], critic: "plan-critic" } },
    modelExecution: {
      endpoints: [{ id: "primary", providerId: profile.provider, transport: profile.transport, endpoint: "https://fixture.example/v1", apiKeyEnvVar: "FIXTURE_KEY" }, { id: "anthropic", providerId: "anthropic", transport: "anthropic-messages", endpoint: "https://anthropic.fixture.example/v1", apiKeyEnvVar: "FIXTURE_KEY" }],
      modelEndpoints: { analyst: "primary", planner: "primary", critic: "primary", "plan-critic": "primary", reviewer: "anthropic" }, maximumOutputTokens: 2000, maximumTokens: 100_000_000, maximumRetries: 0, timeoutMs: 5000,
      rateLimits: { [profile.provider]: { rpm: 10_000, tpm: 100_000_000, maxConcurrent: 4 }, anthropic: { rpm: 10_000, tpm: 100_000_000, maxConcurrent: 4 } },
    },
  } });
  const draft = { assumptions: [{ id: "assumption", statement: "Keep existing sessions", confidence: "high" }], ambiguities: [{ id: "migration", question: "Migrate?", proposedDefault: "Keep sessions", blastRadius: "high" }], acceptance: ACCEPTANCE, outOfScope: [] };
  const template = planIRSchema.parse(JSON.parse(await readFile(new URL("../../schemas/test/golden/plan-ir.valid.json", import.meta.url), "utf8")));
  const base = template.tasks[0]; const route = template.routingRecommendations[0];
  if (base === undefined || route === undefined) throw new Error("FIXTURE_PLAN_ABSENT");
  const tasks = ACCEPTANCE.map(({ id }, index) => ({ ...base, id: `TASK-00${index + 1}`, addresses: { issues: [], validation: [`VAL-00${index + 1}`], requirements: [id] } }));
  const plan: PlanIR = { ...template, mode: "feature", acceptedIssueIds: [], tasks, taskGraph: [], unresolvedQuestions: [],
    premiseReport: { status: "unavailable", interpretation: "smoke_test_only_not_proof", limitations: ["real_model_premise_requires_ground_truth_evaluation"] },
    validationContract: { schemaVersion: 1, validation: ACCEPTANCE.map(({ id }, index) => ({ id: `VAL-00${index + 1}`, assertion: `${id} holds`, evidence: ["regression test"] })) },
    traceability: { issueToValidation: [], requirementLinks: { schemaVersion: 1, links: ACCEPTANCE.map(({ id }, index) => ({ requirementId: id, taskIds: [`TASK-00${index + 1}`], validationIds: [`VAL-00${index + 1}`] })) } },
    routingRecommendations: tasks.map(({ id }) => ({ ...route, taskId: id })) };
  const calls: { stage: string; key: string; input: Record<string, unknown> }[] = [];
  let failNext = failExpansion;
  const providerOptions = { credential: () => "fixture-credential", client: { async send(request: HttpRequest) {
    const { system, input } = decode(request);
    let stage: string; let output: unknown;
    if (system.startsWith("Derive a requirements")) { stage = "requirements"; output = draft; }
    else if (system.startsWith("Explore affected")) {
      stage = "exploration"; output = { summary: "Session preferences", preflight: { affectedSurfaces: [{ id: "sessions", paths: ["session.ts"], riskCategories: ["security"], relevantTo: ACCEPTANCE.map(({ id }) => id) }], securitySensitiveSurfaceCount: 1, migrationInvolvement: true, architectureBreadth: 2, testingComplexity: 2 },
        evidence: [{ surfaceId: "sessions", path: "session.ts", startLine: 1, endLine: 1, text: "export const version = 1;" }], limitations: [] };
    } else if (system.startsWith("Independently review every")) {
      stage = "review"; const contract = input["requirements"] as { assumptions: { id: string }[]; ambiguities: { id: string }[]; acceptance: { id: string }[] };
      output = { summary: "Reviewed", decisions: [...contract.assumptions, ...contract.ambiguities, ...contract.acceptance].map(({ id }) => ({ requirementId: id, disposition: "accept", reason: "Source checked", proposedChange: null, evidence: [] })), limitations: [] };
    } else if (system.startsWith("Create one coherent")) { stage = "planner-full"; output = plan; }
    else if (system.startsWith("Read the complete requirement records")) {
      stage = "planner-brief"; const scope = input["planningScope"] as { recordIds: string[] };
      output = { issues: scope.recordIds.map((issueId) => ({ issueId, summary: `Brief ${issueId}`, affectedPaths: ["session.ts"], behavioralAssertions: [`${issueId} holds`], integrationConstraints: [], unresolvedQuestions: [] })) };
    } else if (system.startsWith("Produce the single global feature plan outline")) { stage = "planner-outline"; output = { ...plan, tasks: tasks.map(taskOutline) }; }
    else if (system.startsWith("Expand the selected task")) {
      stage = "planner-expand"; const id = (input["selectedTask"] as { id: string }).id;
      if (failNext && id === "TASK-002") { failNext = false; calls.push({ stage, key: "interrupted", input }); throw new Error("FIXTURE_EXPANSION_INTERRUPTED"); }
      output = { task: tasks.find((task) => task.id === id), unresolvedQuestions: [] };
    } else if (system.startsWith("Independently critique")) {
      stage = input["revisionContext"] === undefined ? "critic" : "critic-revision";
      const scope = input["reviewScope"] as { kind: string; recordIds: string[] } | undefined;
      const blocking = stage === "critic" && scope?.kind === "review" && scope.recordIds.includes("task:TASK-001");
      output = { summary: "Reviewed batch", items: blocking ? [{ id: "critique", category: "weak_verification", blocking: true, summary: "Missing renewal regression", taskIds: ["TASK-001"], issueIds: [] }] : [] };
    } else if (system.startsWith("Apply one atomic revision")) {
      stage = "revision-patch"; const selected = input["selectedTasks"] as PlanIR["tasks"];
      const globalPlan: Partial<PlanIR> = { ...plan }; delete globalPlan.tasks;
      output = { critiqueItemId: (input["critique"] as { id: string }).id, resolution: "Added renewal regression", globalPlan,
        tasks: selected.map((task) => task.id === "TASK-001" ? { ...task, acceptanceCriteria: [...task.acceptanceCriteria, "Renewal keeps preferences."] } : task), retiredTaskIds: [],
        lineage: selected.map(({ id }) => ({ previousTaskId: id, nextTaskIds: [id], rationale: "Updated in place" })) };
    } else throw new Error(`UNEXPECTED_FEATURE_PROMPT:${system.slice(0, 80)}`);
    calls.push({ stage, key: createHash("sha256").update(request.url).update(system).update(JSON.stringify(input)).digest("hex"), input });
    return { status: 200, headers: {}, body: request.url.includes("anthropic.fixture")
      ? { content: [{ type: "text", text: JSON.stringify(output) }], stop_reason: "end_turn", usage: { input_tokens: 20, output_tokens: 30 } }
      : { output_text: JSON.stringify(output), usage: { input_tokens: 20, output_tokens: 30 } } };
  } } };
  return { root, config, calls, orchestrator: () => new Orchestrator({ repository: root, providerOptions }) };
}

it.each([false, true])("plans, critiques and revises oversized Feature requirements through staged durable paths (interrupted: %s)", async (interrupted) => {
  const f = await fixture(interrupted); const core = f.orchestrator();
  let result: { readonly runId: string; readonly state: string } = await core.run(f.config);
  if (interrupted) {
    expect(result.state).toBe("FAILED");
    const restarted = f.orchestrator(); await restarted.resume(result.runId);
    result = await restarted.wait(result.runId);
  }
  expect(result.state).toBe("COMPLETED");
  const stages = f.calls.map(({ stage }) => stage);
  // The mandatory one-call planner, critic and revision contexts could not fit.
  expect(stages).not.toContain("planner-full");
  // Each of the two independent reviewers decided every requirement across several batches.
  expect(stages.filter((stage) => stage === "review").length).toBeGreaterThan(2);
  expect(stages.filter((stage) => stage === "planner-outline")).toHaveLength(1);
  expect(stages.filter((stage) => stage === "planner-expand")).toHaveLength(interrupted ? 3 : 2);
  expect(stages.filter((stage) => stage === "revision-patch")).toHaveLength(1);
  expect(stages.filter((stage) => stage === "critic").length).toBeGreaterThan(1);
  expect(stages.filter((stage) => stage === "critic-revision").length).toBeGreaterThan(1);
  // Resume repeated no completed model work: only the interrupted expansion was re-sent.
  const keys = f.calls.filter(({ key }) => key !== "interrupted").map(({ key }) => key);
  expect(new Set(keys).size).toBe(keys.length);
  // Every complete requirement record was read verbatim in a brief and in its task expansion.
  const contains = (value: unknown, text: string) => JSON.stringify(value).includes(JSON.stringify(text).slice(1, -1));
  for (const { assertion } of ACCEPTANCE) {
    expect(f.calls.some(({ stage, input }) => stage === "review" && contains(input, assertion))).toBe(true);
    expect(f.calls.some(({ stage, input }) => stage === "planner-brief" && contains(input, assertion))).toBe(true);
    expect(f.calls.some(({ stage, input }) => stage === "planner-expand" && contains(input, assertion))).toBe(true);
    expect(f.calls.some(({ stage, input }) => stage === "critic" && contains(input, assertion))).toBe(true);
    expect(f.calls.some(({ stage, input }) => stage === "critic-revision" && contains(input, assertion))).toBe(true);
  }
  expect(f.calls.some(({ stage, input }) => stage === "revision-patch" && contains(input, ACCEPTANCE[0]?.assertion ?? "missing"))).toBe(true);
  // Critic batches cover every record pair, including requirement and exploration records.
  const artifacts = await core.artifacts(result.runId);
  const read = async (kind: string) => JSON.parse((await core.artifact(result.runId, artifacts.filter((entry) => entry.kind === kind).at(-1)?.artifactId ?? "") as { content: string }).content) as unknown;
  for (const kind of ["feature-critic-context-batches", "feature-critic-revision-context-batches"]) {
    const batches = await read(kind) as { kind: string; recordIds: string[] }[];
    const records = batches.filter((batch) => batch.kind === "review").flatMap(({ recordIds }) => recordIds);
    expect(records).toEqual(expect.arrayContaining(["task:TASK-001", "requirements:acc-2", "requirements:migration", "explorationSurfaces:sessions", "validation:VAL-002"]));
    // The two large requirement records cannot share a context; one is read in exact segments.
    const segmented = batches.filter((batch) => (batch as { segment?: unknown }).segment !== undefined);
    expect(segmented.length).toBeGreaterThan(1);
    expect(segmented.every(({ recordIds }) => recordIds.includes("requirements:acc-1") && recordIds.includes("requirements:acc-2"))).toBe(true);
    for (const left of records) for (const right of records) expect(batches.some(({ recordIds }) => recordIds.includes(left) && recordIds.includes(right))).toBe(true);
  }
  const final = await read("plan-ir") as PlanIR;
  expect(final.traceability.requirementLinks.links.map(({ requirementId }) => requirementId)).toEqual(ACCEPTANCE.map(({ id }) => id));
  expect(final.tasks.find(({ id }) => id === "TASK-001")?.acceptanceCriteria).toContain("Renewal keeps preferences.");
  expect(await core.gate(result.runId)).toEqual({ gateStatus: "passed", reasons: [] });
}, 120_000);
