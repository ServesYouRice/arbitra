import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Orchestrator, type RunnerGraph } from "@arbitra/runtime/orchestrator.js";
import type { TestSandbox } from "@arbitra/runtime/test-sandbox.js";
import { runConfigSchema, type RunConfig } from "@arbitra/schemas/config.js";

/**
 * Credential-free runs produced by the real orchestrator. Providers and the test sandbox
 * are scripted at their ports; every other layer (runner, stores, gates, checkpoints,
 * Testing executor and repair, HTTP routes) is the shipped code. Used by the server's
 * route tests and by the web browser scenarios, which start the real control plane.
 *
 * Each scenario gets its own repository and a unique endpoint/image key, so one
 * orchestrator can serve every scenario concurrently and resume any of them.
 */
export const SCRIPTED_SCENARIOS = ["audit", "checkpoint", "feature-blocked", "feature-proposal", "feature-slow", "testing-pass", "testing-failed", "testing-repair", "testing-empty", "testing-wide"] as const;
export type ScriptedScenario = typeof SCRIPTED_SCENARIOS[number];

/** Model-authored text that must be rendered as inert text by every interface. */
export const UNTRUSTED_TEXT = `<img src=x onerror="window.__arbitraInjected=1"><script>window.__arbitraInjected=2</script>`;
const WIDE_TASKS = 12;

interface Write { readonly path: string; readonly content: string }
interface ScenarioState { readonly scenario: ScriptedScenario; readonly tasks: number; slowPending: boolean; reviewBlocked: boolean; readonly slowStarted: { readonly promise: Promise<void>; readonly resolve: () => void } }

const profile = (independenceGroup: string, overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1, provider: "openai", modelId: "fixture-model", transport: "openai-responses", servedBy: null, family: "fixture", independenceGroup, capabilityTier: "frontier",
  supports: { tools: true, parallelToolCalls: true, structuredOutput: true, reasoning: true, promptCaching: true, batch: false, vision: false },
  limits: { contextTokens: null, maxOutputTokens: null }, effort: { supported: ["low", "medium", "high"], collapse: {}, params: {} },
  quirks: { systemPromptSupport: "full", fewShotPolicy: "neutral", promptStyle: "markdown", documentPlacement: "leading", historyPolicy: "strip_reasoning", samplingDefaults: { temperature: null, topP: null, topK: null }, greedyDecodingSafe: true, toolLoopLimit: 8, prefillSupported: false },
  structuredOutputDialect: "openai_strict", ...overrides,
});
const base = { schemaVersion: 1, scope: { kind: "repository" }, auditDepth: "balanced", consensusPolicy: "risk_weighted", maxConsensusRounds: 1, verification: {}, harness: { mode: "canonical" }, budgets: {}, security: {}, protocols: {}, promptOverrides: {}, contextPolicies: {} };
const modelExecution = (key: string, timeoutMs = 5_000) => ({
  endpoints: [{ id: "primary", providerId: "openai", transport: "openai-responses", endpoint: `https://fixture.example/${key}/v1`, apiKeyEnvVar: "FIXTURE_KEY" },
    { id: "anthropic", providerId: "anthropic", transport: "anthropic-messages", endpoint: `https://anthropic.fixture.example/${key}/v1`, apiKeyEnvVar: "FIXTURE_KEY" }],
  modelEndpoints: { planner: "primary", critic: "primary", reviewer: "anthropic" }, maximumOutputTokens: 2000, maximumTokens: 1_000_000, maximumRetries: 0, timeoutMs,
  rateLimits: { openai: { rpm: 1000, tpm: 10_000_000, maxConcurrent: 4 }, anthropic: { rpm: 1000, tpm: 10_000_000, maxConcurrent: 4 } },
});
const models = {
  planner: profile("planner"),
  reviewer: profile("reviewer", { provider: "anthropic", transport: "anthropic-messages", structuredOutputDialect: "anthropic_tool" }),
  critic: profile("critic"),
};
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const taskNumber = (index: number): string => String(index + 1).padStart(3, "0");

/** The graph a generic interactive checkpoint is exercised through. */
const node = (id: string, kind: RunnerGraph["nodes"][number]["kind"], label: string, config?: { readonly prompt: string }): RunnerGraph["nodes"][number] => ({ id, kind, label, goal: label, ...(config === undefined ? {} : { config }) });
export const CHECKPOINT_GRAPH: RunnerGraph = {
  schemaVersion: 1, id: "e2e-checkpoint", entryNodeId: "preflight",
  nodes: [node("preflight", "deterministic", "Preflight"), node("auditor-a", "model", "Auditor A"), node("auditor-b", "model", "Auditor B"), node("consensus", "loop", "Consensus"),
    node("verification", "subgraph", "Verification"), node("approval", "human", "Release approval", { prompt: `Release the plan? ${UNTRUSTED_TEXT}` }), node("planner", "model", "Planner")],
  edges: [{ id: "p-a", from: "preflight", to: "auditor-a" }, { id: "p-b", from: "preflight", to: "auditor-b" }, { id: "a-c", from: "auditor-a", to: "consensus" },
    { id: "b-c", from: "auditor-b", to: "consensus" }, { id: "c-v", from: "consensus", to: "verification" }, { id: "v-h", from: "verification", to: "approval" }, { id: "h-p", from: "approval", to: "planner" }],
};

export interface ScriptedRuntime {
  readonly orchestrator: Orchestrator;
  /** Create a scenario's repository and configuration, start it, and wait for it to settle (except `feature-slow`). */
  start(scenario: ScriptedScenario): Promise<{ readonly runId: string; readonly state: string; readonly repository: string; readonly config: RunConfig }>;
}

export function scriptedRuntime(root: string, options: { newRunId?: () => string } = {}): ScriptedRuntime {
  const scenarios = new Map<string, ScenarioState>();
  let sequence = 0;
  const providerOptions = { credential: () => "fixture-credential", client: { send: async (request: { url: string; body: unknown; signal: AbortSignal }) => respond(request) } };
  const testSandbox: TestSandbox = {
    async recover() {},
    async run(snapshot, execution, check) {
      const key = /^local\/([A-Za-z0-9.-]+)@/u.exec(execution.image)?.[1] ?? "";
      const state = scenarios.get(key);
      const files = new Map(snapshot.files.map(({ path, lines }) => [path, lines.join("\n")]));
      const failed = state?.scenario === "testing-failed"
        || state?.scenario === "testing-repair" && check.id === "t001" && files.has("tests/002.test.ts") && !(files.get("tests/001.test.ts") ?? "").includes("repaired");
      return { driver: "docker", image: execution.image, checkId: check.id, isolation: "read_only_snapshot_no_network", status: "exited", stopped: null, cleanupCompleted: true,
        exitCode: failed ? 1 : 0, stdout: failed ? `assertion failed ${UNTRUSTED_TEXT}` : "ok", stderr: "" };
    },
  };
  const orchestrator = new Orchestrator({ repository: root, stateDirectory: join(root, "state"), providerOptions, testSandbox, graphs: { "e2e-checkpoint": CHECKPOINT_GRAPH }, ...(options.newRunId === undefined ? {} : { newRunId: options.newRunId }) });

  async function respond(request: { url: string; body: unknown; signal: AbortSignal }) {
    const key = /fixture\.example\/([A-Za-z0-9.-]+)\//u.exec(request.url)?.[1] ?? "";
    const state = scenarios.get(key);
    if (state === undefined) throw new Error(`UNKNOWN_FIXTURE_ENDPOINT:${request.url}`);
    const body = request.body as { input?: { role?: string; content?: string; type?: string }[]; messages?: { content: unknown }[] };
    const user = body.input?.find(({ role }) => role === "user")?.content ?? (typeof body.messages?.[0]?.content === "string" ? body.messages[0].content : "");
    const layers = user.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as { layer: string; value: { instruction?: string; artifacts?: string[] } });
    const system = layers.find(({ layer }) => layer === "instruction")?.value.instruction ?? "";
    const framed = layers.flatMap(({ value }) => value.artifacts ?? [])[0] ?? "";
    const content = /-->\n([\s\S]*)\n<\/repository_content>$/u.exec(framed)?.[1] ?? "{}";
    const input = JSON.parse(content.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")) as Record<string, unknown>;
    const anthropic = request.url.includes("anthropic.fixture");
    const reply = (output: unknown) => ({ status: 200, headers: {}, body: anthropic
      ? { content: [{ type: "text", text: JSON.stringify(output) }], stop_reason: "end_turn", usage: { input_tokens: 20, output_tokens: 30 } }
      : { output_text: JSON.stringify(output), usage: { input_tokens: 20, output_tokens: 30 } } });

    if (system.startsWith("Derive a requirements")) {
      if (state.slowPending) {
        state.slowPending = false;
        state.slowStarted.resolve();
        // Hold the call until the operator cancels, so cancellation is observable.
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 120_000);
          request.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("FIXTURE_CALL_CANCELLED")); }, { once: true });
        });
      }
      return reply(featureDraft());
    }
    if (system.startsWith("Explore affected")) return reply({ summary: "Session preferences", preflight: { affectedSurfaces: [{ id: "sessions", paths: ["session.ts"], riskCategories: [], relevantTo: ["acceptance"] }], securitySensitiveSurfaceCount: 0, migrationInvolvement: false, architectureBreadth: 1, testingComplexity: 1 }, evidence: [{ surfaceId: "sessions", path: "session.ts", startLine: 1, endLine: 1, text: "export const version = 1;" }], limitations: [] });
    if (system.startsWith("Independently review every")) {
      const contract = input["requirements"] as { assumptions: { id: string }[]; ambiguities: { id: string }[]; acceptance: { id: string }[] };
      const blocked = state.reviewBlocked && input["revisionContext"] === undefined;
      return reply({ summary: "Review requirements", decisions: [...contract.assumptions, ...contract.ambiguities, ...contract.acceptance].map(({ id }) => ({ requirementId: id, disposition: blocked ? "uncertain" : "accept", reason: "Source checked", proposedChange: null, evidence: [] })), limitations: [] });
    }
    if (system.startsWith("Propose a revised Feature requirements")) {
      const contract = input["requirements"] as { assumptions: { id: string; statement: string; confidence: string }[]; ambiguities: { id: string; question: string; proposedDefault: string; blastRadius: string }[]; acceptance: { id: string; assertion: string }[]; outOfScope: string[] };
      return reply({ draft: { assumptions: contract.assumptions.map((item) => ({ ...item, statement: `${item.statement} Clarified.` })), ambiguities: contract.ambiguities.map((item) => ({ ...item, proposedDefault: `${item.proposedDefault} (revised)` })), acceptance: contract.acceptance, outOfScope: contract.outOfScope },
        lineage: [...contract.assumptions, ...contract.ambiguities, ...contract.acceptance].map(({ id }) => ({ previousRequirementId: id, nextRequirementIds: [id], rationale: "Retain responsibility with clarified defaults" })), addedRequirementIds: [],
        resolutions: (input["blockingRequirementIds"] as string[]).map((requirementId) => ({ requirementId, resolution: "Clarified defaults against source" })) });
    }
    if (system.startsWith("Create one coherent Testing Plan IR")) return reply(testingPlan(state));
    if (system.startsWith("Create one coherent")) return reply(featurePlan());
    if (system.startsWith("Independently critique")) return reply({ summary: "Plan reviewed", items: [] });
    if (system.startsWith("Identify production-risk")) {
      const empty = state.scenario === "testing-empty";
      return reply({ summary: `Session coverage ${UNTRUSTED_TEXT}`, surfaces: empty ? [] : [{ id: "session", paths: ["session.ts"], categories: ["unit"], severity: "high", failureModes: ["session loss"], evidence: [{ path: "session.ts", startLine: 1, endLine: 1, text: "export const version = 1;" }] }],
        reviewedSourcePaths: ["session.ts"], reviewedTestPaths: ["session.unit.test.ts"], limitations: [] });
    }
    if (system.startsWith("Select Testing gaps")) return reply({ selectedGapIds: state.scenario === "testing-empty" ? [] : ["GAP-session-1"], rejected: [], limitations: [] });
    if (system.startsWith("Implement the assigned Testing task")) {
      const payload = input as unknown as { task: { id: string }; attempt: { ordinal: number }; repository: { path: string; content: string }[] };
      const turn = body.input?.some(({ type }) => type === "function_call_output") === true ? 1 : 0;
      const writes = turn === 0 ? writerScript(state, payload.task.id, payload.attempt.ordinal) : [];
      const current = new Map(payload.repository.map(({ path, content: text }) => [path, text]));
      if (writes.length === 0) return reply({ summary: "Updated tests", limitations: [] });
      return { status: 200, headers: {}, body: { output: writes.map(({ path, content: text }, index) => ({ type: "function_call", call_id: `write-${index}`, name: "testing_write_file",
        arguments: JSON.stringify({ path, expectedHash: current.has(path) ? digest(current.get(path) ?? "") : null, content: text }) })), usage: { input_tokens: 10, output_tokens: 10 } } };
    }
    throw new Error(`UNEXPECTED_FIXTURE_PROMPT:${system.slice(0, 80)}`);
  }

  async function start(scenario: ScriptedScenario) {
    sequence += 1;
    const key = `${scenario}-${sequence}`;
    const repository = join(root, "repositories", key);
    await mkdir(repository, { recursive: true });
    const state: ScenarioState = { scenario, tasks: scenario === "testing-wide" ? WIDE_TASKS : scenario === "testing-repair" ? 2 : 1, slowPending: scenario === "feature-slow", reviewBlocked: scenario === "feature-proposal", slowStarted: signal() };
    scenarios.set(key, state);
    const config = await prepare(repository, key, state);
    const resource = await orchestrator.start(config, repository);
    // A slow run is returned while its first model call is outstanding, so it is live.
    const settled = scenario === "feature-slow" ? await state.slowStarted.promise.then(() => orchestrator.status(resource.runId)) : await orchestrator.wait(resource.runId);
    return { runId: resource.runId, state: settled.state, repository, config };
  }

  return { orchestrator, start };
}

async function prepare(repository: string, key: string, state: ScenarioState): Promise<RunConfig> {
  await writeFile(join(repository, "session.ts"), "export const version = 1;\n");
  if (state.scenario === "audit" || state.scenario === "checkpoint") {
    await mkdir(join(repository, "src"), { recursive: true });
    await writeFile(join(repository, "src/handlers.ts"), [
      "export function parse(value: unknown): string {",
      "  try { return JSON.stringify(value); } catch {}",
      "  return (value as " + "any).label!.trim();",
      "}",
      `// ${"TO" + "DO"} replace legacy parser ${UNTRUSTED_TEXT}`,
      "export const retry = (callback: () => void, pause: number) => setTimeout(callback, pause);",
    ].join("\n") + "\n");
    return runConfigSchema.parse({ ...base, mode: "audit", models: {}, workflow: state.scenario === "audit" ? { preset: "audit-deep" } : { preset: "e2e-checkpoint", checkpoints: { mode: "interactive" } } });
  }
  if (state.scenario.startsWith("feature-")) {
    return runConfigSchema.parse({ ...base, mode: "feature", models, workflow: {
      preset: "feature-simple",
      feature: { request: "Add session preferences", mode: state.scenario === "feature-slow" ? "automatic" : "interactive", maximumRequirementsRevisions: state.scenario === "feature-proposal" ? 1 : 0,
        roles: { requirements: "planner", exploration: "planner", planner: "planner", reviewers: ["reviewer", "critic"], critic: "critic" } },
      modelExecution: modelExecution(key, state.scenario === "feature-slow" ? 180_000 : 5_000),
    } });
  }
  // Testing: one package script and one sandbox check per planned task.
  await writeFile(join(repository, "session.unit.test.ts"), "test('unrelated', () => {});\n");
  const numbers = Array.from({ length: state.tasks }, (_, index) => taskNumber(index));
  await writeFile(join(repository, "package.json"), JSON.stringify({ scripts: Object.fromEntries(numbers.map((number) => [`test:${number}`, `node --test tests/${number}.test.ts`])) }, null, 2));
  const execution = {
    authorization: { maximumParallelTasks: 1, partitions: [{ id: "tests", paths: numbers.map((number) => `tests/${number}.test.ts`) }], tasks: numbers.map((number) => ({ taskId: `TASK-${number}`, partitionId: "tests", exclusive: false })) },
    verification: { execution: { driver: "docker", image: `local/${key}@sha256:${"a".repeat(64)}`, maximumRuns: Math.min(50, state.tasks * 3 + 4),
      checks: numbers.map((number) => ({ id: `t${number}`, executable: "/usr/bin/node", arguments: ["--test", `tests/${number}.test.ts`], sourcePaths: [`tests/${number}.test.ts`] })) },
    bindings: numbers.map((number) => ({ command: `npm run test:${number}`, checkId: `t${number}`, expectedExitCode: 0, authorization: "repository_script" })) },
    models: { fast: "planner", balanced: "planner", frontier: "planner" }, maximumAttempts: state.scenario === "testing-repair" ? 2 : 1,
    ...(state.scenario === "testing-repair" ? { maximumRepairRounds: 2 } : {}),
  };
  return runConfigSchema.parse({ ...base, mode: "testing", models, workflow: {
    preset: "testing-execute", testing: { mode: "execute", execution, goal: "Protect session behavior", roles: { analyst: "planner", planner: "planner" } },
    modelExecution: modelExecution(key),
  } });
}

function signal(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve: () => resolve() };
}

function writerScript(state: ScenarioState, taskId: string, ordinal: number): readonly Write[] {
  const number = taskId.replace("TASK-", "");
  if (state.scenario === "testing-repair" && number === "001" && ordinal > 1) return [{ path: "tests/001.test.ts", content: "test('001 repaired', () => {});\n" }];
  return [{ path: `tests/${number}.test.ts`, content: `test('${number}', () => {});\n` }];
}

function featureDraft() {
  return { assumptions: [{ id: "assumption", statement: `Keep existing sessions ${UNTRUSTED_TEXT}`, confidence: "high" }],
    ambiguities: [{ id: "migration", question: "Migrate existing sessions?", proposedDefault: "Keep sessions", blastRadius: "high" }, { id: "naming", question: "Preference key naming?", proposedDefault: "camelCase", blastRadius: "low" }],
    acceptance: [{ id: "acceptance", assertion: "New sessions keep preferences" }], outOfScope: ["Session storage redesign"] };
}

function basePlan(mode: "feature" | "testing", tasks: readonly { id: string; title: string; files: readonly string[]; command: string; dependsOn: readonly string[]; requirement: string }[]) {
  return {
    schemaVersion: 1, id: `plan-${mode}`, title: mode === "feature" ? "Session preferences" : "Session regression tests", mode,
    reasoningOutcome: "Scripted plan for browser acceptance.", implementationStrategy: ["Keep each change with its verification."], dependencies: [], acceptedIssueIds: [], unresolvedQuestions: [],
    validationContract: { schemaVersion: 1, validation: [{ id: "VAL-001", assertion: "Session behavior stays covered.", evidence: ["regression test"] }] },
    tasks: tasks.map((task) => ({
      schemaVersion: 1, id: task.id, title: task.title,
      goal: { objective: task.title, doneWhen: ["Assertions pass."], stopWhen: ["Checks pass."], blockedWhen: ["Source is unavailable."] },
      addresses: { issues: [], validation: ["VAL-001"], requirements: [task.requirement] },
      routing: { capability: "frontier", effort: "medium", advisor: null, advisorMaxUses: null, reason: ["fixture"] },
      dependencies: { dependsOn: [...task.dependsOn], blocks: tasks.filter(({ dependsOn }) => dependsOn.includes(task.id)).map(({ id }) => id), conflictsWith: [] },
      scope: { likelyFiles: [...task.files], components: ["sessions"], interfaces: [] }, filesNotToTouch: [], readFirst: ["session.ts"], context: [], invariants: ["Existing sessions stay valid."], outOfScope: [],
      implementationGuidance: ["Keep assertions specific."], acceptanceCriteria: ["Checks pass."],
      verification: { preconditions: [], commands: [{ command: task.command, expectedExitCode: 0, executionPolicy: "derived_repository_script" }], checks: ["Deterministic."] },
      rollbackPlan: ["Revert the change."], escalateIf: [], expectedEvidence: ["Passing check output."], estimatedTurns: 2,
    })),
    taskGraph: tasks.flatMap(({ id, dependsOn }) => dependsOn.map((from) => ({ from, to: id }))),
    traceability: { issueToValidation: [], requirementLinks: { schemaVersion: 1, links: [{ requirementId: tasks[0]?.requirement ?? "acceptance", taskIds: tasks.map(({ id }) => id), validationIds: ["VAL-001"] }] } },
    routingRecommendations: tasks.map(({ id }) => ({ taskId: id, capability: "frontier", effort: "medium", reason: ["fixture"] })),
    rolloutConcerns: [], migrationConcerns: [],
    premiseReport: { status: "unavailable", interpretation: "smoke_test_only_not_proof", limitations: ["real_model_premise_requires_ground_truth_evaluation"] },
  };
}

function featurePlan() {
  return basePlan("feature", [{ id: "TASK-001", title: `Persist session preferences ${UNTRUSTED_TEXT}`, files: ["session.ts", "session.test.ts"], command: "pnpm test", dependsOn: [], requirement: "acceptance" }]);
}

function testingPlan(state: ScenarioState) {
  return basePlan("testing", Array.from({ length: state.tasks }, (_, index) => {
    const number = taskNumber(index);
    return { id: `TASK-${number}`, title: `Session regression ${number}`, files: [`tests/${number}.test.ts`], command: `npm run test:${number}`, dependsOn: state.scenario === "testing-repair" && index > 0 ? [`TASK-${taskNumber(index - 1)}`] : [], requirement: "GAP-session-1" };
  }));
}
