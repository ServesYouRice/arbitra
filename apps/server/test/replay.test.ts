import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runConfigSchema } from "@arbitra/schemas/config.js";
import { planIRSchema } from "@arbitra/schemas/plan.js";
import { Orchestrator } from "@arbitra/runtime/orchestrator.js";
import { controlPlaneCore } from "@arbitra/runtime/control-plane-core.js";
import { orchestratorCore } from "@arbitra/runtime/cli-core.js";
import { RunStore } from "@arbitra/runtime/run-store.js";
import { buildServer } from "../src/main.js";
import { scriptedRuntime } from "../fixtures/scripted-runs.js";

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

type TestingReport = Report & { execution: { mode: string; authority?: string } };

it("serves Testing plan, execution and changed-configuration replay over HTTP with the CLI port's decisions and fresh evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "replay-http-testing-"));
  const runtime = scriptedRuntime(root);
  const app = buildServer(controlPlaneCore(runtime.orchestrator));
  const cli = orchestratorCore(runtime.orchestrator);
  const runs = join(root, "state", "runs");
  const shape = (report: Report) => report.stages.map(({ stage, decision, reasons, reused, regenerated }) => ({ stage, decision, reasons, reused: reused.map(({ activityId }) => activityId), regenerated }));
  // Both interfaces receive the same request body: HTTP as JSON, the CLI as a request file.
  let requests = 0;
  const replay = async (sourceRunId: string, body: Record<string, unknown>) => {
    const started = await app.inject({ method: "POST", url: `/runs/${sourceRunId}/replay`, payload: body });
    expect(started.statusCode, started.body).toBe(200);
    const { runId } = started.json<{ runId: string }>();
    expect((await runtime.orchestrator.wait(runId)).state).toBe("COMPLETED");
    const http = (await app.inject({ method: "GET", url: `/runs/${runId}/replay` })).json<TestingReport>();
    requests += 1;
    const requestPath = join(root, `replay-${requests}.json`);
    await writeFile(requestPath, JSON.stringify(body));
    const result = await cli.replayRequest(sourceRunId, requestPath);
    const value = result.value as { runId: string; gateStatus: string; summary: { replay: TestingReport } };
    expect(result.disposition).toBe("passed");
    expect(shape(value.summary.replay)).toEqual(shape(http));
    expect(value.summary.replay.execution).toEqual(http.execution);
    expect((await runtime.orchestrator.gate(runId)).gateStatus).toBe(value.gateStatus);
    return { http: runId, cli: value.runId, report: http };
  };
  const workspace = async (runId: string) => {
    const artifact = (await runtime.orchestrator.artifacts(runId)).find(({ kind }) => kind === "testing-workspace");
    return artifact === undefined ? null : (JSON.parse((await runtime.orchestrator.artifact(runId, artifact.artifactId) as { content: string }).content) as { handle?: { directory: string } }).handle?.directory ?? null;
  };
  try {
    const source = await runtime.start("testing-pass");
    expect(source.state).toBe("COMPLETED");
    const before = await runDigest(join(runs, source.runId));
    const sourceWorkspace = await workspace(source.runId);
    const authorization = (source.config.workflow["testing"] as { execution: { authorization: unknown } }).execution.authorization;

    // Planning replay: no writer and no check, through either interface.
    let calls = runtime.calls.length; let checks = runtime.checks();
    const plan = await replay(source.runId, { mode: "testing", execution: { mode: "plan" } });
    expect(plan.report.execution).toEqual({ mode: "plan" });
    expect(plan.report.stages.map(({ stage, decision }) => [stage, decision])).toEqual([["analysis", "regenerate"], ["planning", "regenerate"]]);
    expect(runtime.calls.slice(calls)).not.toContain("writer");
    expect(runtime.checks()).toBe(checks);
    for (const runId of [plan.http, plan.cli]) expect(await workspace(runId)).toBeNull();

    // Execution replay: reused analysis and planning, a new worktree and fresh checks per replay.
    calls = runtime.calls.length; checks = runtime.checks();
    const execute = await replay(source.runId, { mode: "testing", execution: { mode: "execute", authorization } });
    expect(execute.report.execution).toMatchObject({ mode: "execute", authority: "replay_request" });
    expect(execute.report.stages.map(({ stage, decision }) => [stage, decision])).toEqual([["analysis", "reuse"], ["planning", "reuse"], ["execution", "regenerate"]]);
    expect(runtime.calls.slice(calls)).toEqual(["writer", "writer"]);
    expect(runtime.checks()).toBeGreaterThan(checks);
    expect(new Set([sourceWorkspace, await workspace(execute.http), await workspace(execute.cli)]).size).toBe(3);
    for (const runId of [execute.http, execute.cli]) {
      const view = (await app.inject({ method: "GET", url: `/runs/${runId}/testing` })).json<{ tasks: { attempts: { result: string; verification: { status: string } }[] }[]; execution: { passed: boolean } }>();
      expect(view.execution.passed).toBe(true);
      expect(view.tasks[0]?.attempts).toMatchObject([{ result: "passed", verification: { status: "passed" } }]);
    }

    // A changed planner protocol and a changed scope make the same decisions through both interfaces.
    const protocol = await replay(source.runId, { mode: "testing", configuration: { ...source.config, promptOverrides: { planner: { after: "Name every assertion." } } }, execution: { mode: "execute", authorization } });
    expect(protocol.report.stages.map(({ stage, decision, reasons }) => [stage, decision, reasons])).toEqual([["analysis", "reuse", []], ["planning", "regenerate", ["changed:protocols"]], ["execution", "regenerate", ["side_effecting_stage_requires_fresh_evidence", "changed:upstream"]]]);
    const scoped = await replay(source.runId, { mode: "testing", configuration: { ...source.config, scope: { kind: "repository", exclude: ["docs"] } }, execution: { mode: "plan" } });
    expect(scoped.report.stages.every(({ decision, reasons }) => decision === "regenerate" && reasons.includes("changed:scope"))).toBe(true);

    // Both interfaces refuse an execution replay without fresh authority, before creating a run.
    const count = (await runtime.orchestrator.runIds()).length;
    const unauthorized = await app.inject({ method: "POST", url: `/runs/${source.runId}/replay`, payload: { mode: "testing", execution: { mode: "execute" } } });
    expect(unauthorized.statusCode).toBe(400);
    const requestPath = join(root, "unauthorized.json");
    await writeFile(requestPath, JSON.stringify({ mode: "testing", execution: { mode: "execute" } }));
    await expect(cli.replayRequest(source.runId, requestPath)).rejects.toThrow("INVALID_REPLAY_REQUEST");
    expect((await runtime.orchestrator.runIds()).length).toBe(count);

    // A replay run whose contract was lost is reported as such, never as a plain run.
    const store = new RunStore(runs, plan.http);
    const contract = (await store.listArtifacts()).find(({ kind }) => kind === "replay-contract");
    if (contract === undefined) throw new Error("CONTRACT_ABSENT");
    await unlink(join(store.directory, contract.ref.relativePath));
    const lost = await app.inject({ method: "GET", url: `/runs/${plan.http}/replay` });
    expect(lost.statusCode).toBe(409);
    expect(lost.json()).toMatchObject({ message: `REPLAY_CONTRACT_UNREADABLE:${plan.http}` });
    expect(await runDigest(join(runs, source.runId))).toBe(before);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
  // Eleven complete durable Testing runs with worktrees and checks take 20–30 s on a laptop, longer in a parallel suite.
}, 120_000);
