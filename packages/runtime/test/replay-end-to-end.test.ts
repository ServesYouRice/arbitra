import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runConfigSchema, type RunConfig } from "@arbitra/schemas/config.js";
import { featureFixture } from "./feature-fixture.js";
import { budget, cleanup, report, runDigest, stage, testingReplayFixture, workspace, type Report } from "./replay-fixture.js";
import { RunStore } from "../src/run-store.js";

// Feature and Testing replay through the public Orchestrator with changed protocol, model,
// scope, requirements, authorization and verification. Scripted providers and sandbox only.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function root(prefix: string) { const path = await mkdtemp(join(tmpdir(), prefix)); roots.push(path); return path; }

const decisions = (value: Report) => value.stages.map(({ stage: name, decision }) => [name, decision]);
const store = (path: string, runId: string) => new RunStore(join(path, ".runs", "runs"), runId);
const charged = (activityIds: readonly string[], ...prefixes: readonly string[]) => activityIds.length > 0 && activityIds.every((id) => prefixes.some((prefix) => id.startsWith(prefix)));
async function sourceOutput(path: string, runId: string, prefix: string): Promise<string> {
  const run = store(path, runId);
  const output = (await run.listArtifacts()).find(({ kind, nodeId }) => kind.startsWith("model-activity-") && !kind.endsWith("-input") && !kind.endsWith("-trace") && nodeId?.startsWith(prefix) === true);
  if (output === undefined) throw new Error(`SOURCE_OUTPUT_ABSENT:${prefix}`);
  return join(run.directory, output.ref.relativePath);
}
const withTesting = (config: RunConfig, change: (testing: Record<string, unknown>) => Record<string, unknown>) => runConfigSchema.parse({ ...config, workflow: { ...config.workflow, testing: change(config.workflow["testing"] as Record<string, unknown>) } });

describe("Feature replay end to end", () => {
  it("regenerates only planning under a changed planner protocol and charges only it", async () => {
    const path = await root("e2e-feature-protocol-");
    const f = await featureFixture(path, { highRisk: true }); const core = f.orchestrator();
    const source = await core.run(f.config); expect(source.state).toBe("COMPLETED");
    const before = await runDigest(path, source.runId); const calls = f.calls.length;
    const configuration = runConfigSchema.parse({ ...f.config, promptOverrides: { planner: { before: "Prefer the smallest coherent change." } } });
    const replayed = await core.replay(source.runId, { mode: "feature", configuration });
    expect(replayed.state).toBe("COMPLETED");
    expect(f.calls.slice(calls).map(({ stage: name }) => name).sort()).toEqual(["critic", "planner"]);
    const value = await report(core, replayed.runId);
    expect(decisions(value)).toEqual([["requirements", "reuse"], ["exploration", "reuse"], ["review", "reuse"], ["requirements-revision", "reuse"], ["planning", "regenerate"]]);
    expect(stage(value, "planning").reasons).toEqual(["changed:protocols"]);
    expect(stage(value, "planning").regenerated.map(({ reason }) => reason)).toEqual(["stage_invalidated", "stage_invalidated"]);
    expect(stage(value, "review").reused.length).toBeGreaterThan(0);
    expect(charged(await budget(path, replayed.runId), "feature/planner/", "feature/critic/")).toBe(true);
    expect(await core.gate(replayed.runId)).toMatchObject({ gateStatus: "passed" });
    expect((await store(path, replayed.runId).loadContext()).modelConfiguration?.promptOverrides).toEqual(configuration.promptOverrides);
    expect(await runDigest(path, source.runId)).toBe(before);
  });

  it("regenerates review and its dependents when a reviewer moves to another wire protocol", async () => {
    const path = await root("e2e-feature-transport-");
    const f = await featureFixture(path, { highRisk: true }); const core = f.orchestrator();
    const source = await core.run(f.config); expect(source.state).toBe("COMPLETED");
    const before = await runDigest(path, source.runId); const calls = f.calls.length;
    expect(f.calls.filter(({ stage: name }) => name === "review").some(({ url }) => url.includes("anthropic.fixture"))).toBe(true);
    const execution = f.config.workflow["modelExecution"] as { modelEndpoints: Record<string, string> };
    const configuration = runConfigSchema.parse({ ...f.config, models: { ...f.config.models, reviewer: { ...f.config.models["planner"], independenceGroup: "reviewer" } },
      workflow: { ...f.config.workflow, modelExecution: { ...execution, modelEndpoints: { ...execution.modelEndpoints, reviewer: "primary" } } } });
    const replayed = await core.replay(source.runId, { mode: "feature", configuration });
    expect(replayed.state).toBe("COMPLETED");
    const fresh = f.calls.slice(calls);
    expect(fresh.map(({ stage: name }) => name).sort()).toEqual(["critic", "planner", "review", "review"]);
    expect(fresh.some(({ url }) => url.includes("anthropic.fixture"))).toBe(false);
    const value = await report(core, replayed.runId);
    expect(decisions(value)).toEqual([["requirements", "reuse"], ["exploration", "reuse"], ["review", "regenerate"], ["requirements-revision", "regenerate"], ["planning", "regenerate"]]);
    expect(stage(value, "review").reasons).toEqual(["changed:models"]);
    expect(stage(value, "planning").reasons).toEqual(["changed:upstream"]);
    expect(charged(await budget(path, replayed.runId), "feature/review/", "feature/planner/", "feature/critic/")).toBe(true);
    expect(await runDigest(path, source.runId)).toBe(before);
  });

  it("regenerates every stage under a changed scope and snapshots only the new scope", async () => {
    const path = await root("e2e-feature-scope-");
    const f = await featureFixture(path); const core = f.orchestrator();
    await mkdir(join(path, "notes")); await writeFile(join(path, "notes", "draft.ts"), "export const draft = true;\n");
    const source = await core.run(f.config); expect(source.state).toBe("COMPLETED");
    const before = await runDigest(path, source.runId); const calls = f.calls.length;
    const scope = { kind: "repository" as const, exclude: ["notes"] };
    const replayed = await core.replay(source.runId, { mode: "feature", configuration: runConfigSchema.parse({ ...f.config, scope }) });
    expect(replayed.state).toBe("COMPLETED");
    expect(f.calls.slice(calls).map(({ stage: name }) => name)).toEqual(["requirements", "exploration", "planner"]);
    const value = await report(core, replayed.runId);
    expect(value.stages.every(({ decision, reasons }) => decision === "regenerate" && reasons.includes("changed:scope") && reasons.includes("changed:repository"))).toBe(true);
    expect(value.stages.flatMap(({ reused }) => reused)).toEqual([]);
    const context = await store(path, replayed.runId).loadContext();
    expect(context.scope).toEqual(scope);
    expect(context.repositoryDigest).not.toBe((await store(path, source.runId).loadContext()).repositoryDigest);
    expect(await core.gate(replayed.runId)).toMatchObject({ gateStatus: "passed" });

    // A changed source under the unchanged scope also regenerates everything; replay never reuses stale source analysis.
    await writeFile(join(path, "notes", "draft.ts"), "export const draft = false;\n");
    const count = f.calls.length;
    const changed = await core.replay(source.runId, { mode: "feature" });
    expect(changed.state).toBe("COMPLETED");
    expect(f.calls.slice(count).map(({ stage: name }) => name)).toEqual(["requirements", "exploration", "planner"]);
    expect((await report(core, changed.runId)).stages.map(({ reasons }) => reasons.includes("changed:repository") && !reasons.includes("changed:scope"))).toEqual(Array.from({ length: 5 }, () => true));
    expect(await runDigest(path, source.runId)).toBe(before);
  });

  it("reuses through a missing source protocol pin only under the saved activity identity, and records it", async () => {
    const path = await root("e2e-feature-pin-");
    const f = await featureFixture(path); const core = f.orchestrator();
    const source = await core.run(f.config); expect(source.state).toBe("COMPLETED");
    const run = store(path, source.runId);
    const pinned = (await run.listArtifacts()).find(({ kind }) => kind === "model-protocol-planner");
    if (pinned === undefined) throw new Error("PIN_ABSENT");
    await unlink(join(run.directory, pinned.ref.relativePath));
    const before = await runDigest(path, source.runId); const calls = f.calls.length;
    const started = await core.startReplay(source.runId, { mode: "feature" });
    expect(started.stages?.find(({ stage: name }) => name === "planning")).toMatchObject({ decision: "reuse", sourceUnpinnedProtocols: ["planner", "plan-critic"] });
    expect((await core.wait(started.runId)).state).toBe("COMPLETED");
    expect(f.calls).toHaveLength(calls);
    // The new run pins its own intact copy.
    expect((await store(path, started.runId).listArtifacts()).some(({ kind }) => kind === "model-protocol-planner")).toBe(true);
    expect(await runDigest(path, source.runId)).toBe(before);
  });

  it("refuses to resume a replay run whose replay contract is missing or names another source, without dispatching models", async () => {
    const path = await root("e2e-feature-contract-");
    const f = await featureFixture(path);
    const source = await f.orchestrator().run(f.config); expect(source.state).toBe("COMPLETED");
    const g = await featureFixture(path, { failPlanner: true });
    const configuration = runConfigSchema.parse({ ...f.config, workflow: { ...f.config.workflow, feature: { ...f.config.workflow["feature"] as object, request: "Add session preferences and themes" } } });
    const failed = await g.orchestrator().replay(source.runId, { mode: "feature", configuration });
    expect(failed.state).toBe("FAILED");
    const calls = g.calls.length;
    const run = store(path, failed.runId); const core = g.orchestrator();
    // A contract that names another source than the run's own is not resumed either.
    const contextPath = join(run.directory, "context.json"); const context = await readFile(contextPath, "utf8");
    await writeFile(contextPath, JSON.stringify({ ...JSON.parse(context) as object, replaySourceRunId: "run-other" }));
    await expect(core.resume(failed.runId)).rejects.toThrow(`REPLAY_CONTRACT_MISMATCH:${failed.runId}`);
    await writeFile(contextPath, context);
    const contract = (await run.listArtifacts()).find(({ kind }) => kind === "replay-contract");
    if (contract === undefined) throw new Error("CONTRACT_ABSENT");
    await unlink(join(run.directory, contract.ref.relativePath));
    await expect(core.resume(failed.runId)).rejects.toThrow(`REPLAY_CONTRACT_UNREADABLE:${failed.runId}`);
    await expect(core.replayReport(failed.runId)).rejects.toThrow(`REPLAY_CONTRACT_UNREADABLE:${failed.runId}`);
    expect((await core.status(failed.runId)).state).toBe("FAILED");
    expect(g.calls).toHaveLength(calls);
  });
});

describe("Testing replay end to end", () => {
  it("regenerates only planning under a changed planner protocol, and everything under a changed model or scope, never dispatching writers or checks", async () => {
    const path = await root("e2e-testing-plan-");
    const f = await testingReplayFixture(path, { execute: false }); const core = f.orchestrator();
    await mkdir(join(path, "docs")); await writeFile(join(path, "docs", "guide.md"), "# Sessions\n");
    const source = await core.run(f.config); expect(source.state).toBe("COMPLETED");
    expect(await core.summary(source.runId)).toMatchObject({ outcome: { passed: true } });
    const before = await runDigest(path, source.runId);

    f.responses.push(f.plan);
    const protocol = await core.replay(source.runId, { mode: "testing", configuration: runConfigSchema.parse({ ...f.config, promptOverrides: { planner: { after: "Name every assertion." } } }), execution: { mode: "plan" } });
    expect(protocol.state).toBe("COMPLETED");
    const protocolReport = await report(core, protocol.runId);
    expect(decisions(protocolReport)).toEqual([["analysis", "reuse"], ["planning", "regenerate"]]);
    expect(stage(protocolReport, "planning").reasons).toEqual(["changed:protocols"]);
    expect(stage(protocolReport, "analysis").reused).toHaveLength(2);
    expect(charged(await budget(path, protocol.runId), "testing/planner/")).toBe(true);

    f.responses.push(...f.analysis, f.plan);
    const planner = f.config.models["planner"];
    const model = await core.replay(source.runId, { mode: "testing", configuration: runConfigSchema.parse({ ...f.config, models: { ...f.config.models, planner: { ...planner, modelId: `${planner?.modelId ?? ""}-next` } } }), execution: { mode: "plan" } });
    expect(model.state).toBe("COMPLETED");
    const modelReport = await report(core, model.runId);
    expect(modelReport.stages.map(({ stage: name, decision, reasons }) => [name, decision, reasons])).toEqual([["analysis", "regenerate", ["changed:models"]], ["planning", "regenerate", ["changed:models", "changed:upstream"]]]);
    expect(await budget(path, model.runId)).toHaveLength(3);

    f.responses.push(...f.analysis, f.plan);
    const scoped = await core.replay(source.runId, { mode: "testing", configuration: runConfigSchema.parse({ ...f.config, scope: { kind: "repository", exclude: ["docs"] } }), execution: { mode: "plan" } });
    expect(scoped.state).toBe("COMPLETED");
    expect((await report(core, scoped.runId)).stages.every(({ decision, reasons }) => decision === "regenerate" && reasons.includes("changed:scope"))).toBe(true);

    expect(f.responses).toEqual([]);
    expect(f.sent.every((kind) => kind === "planning")).toBe(true);
    expect(f.checks()).toBe(0);
    for (const runId of [protocol.runId, model.runId, scoped.runId]) {
      expect((await core.artifacts(runId)).some(({ kind }) => kind === "testing-workspace" || kind.startsWith("testing-execution"))).toBe(false);
      expect(await core.summary(runId)).toMatchObject({ outcome: { testsExecuted: false }, replay: { sourceRunId: source.runId, execution: { mode: "plan" } } });
    }
    expect(await runDigest(path, source.runId)).toBe(before);
  });

  it("takes execution authority only from the request and regenerates a missing planning output with fresh evidence in a new worktree", async () => {
    const path = await root("e2e-testing-missing-");
    const f = await testingReplayFixture(path); const core = f.orchestrator();
    const source = await core.run(f.config); expect(source.state).toBe("COMPLETED");
    const sourceWorkspace = await workspace(core, source.runId); await cleanup(core, source.runId);
    await unlink(await sourceOutput(path, source.runId, "testing/planner/"));
    const before = await runDigest(path, source.runId); const checks = f.checks();

    // A configuration cannot widen write authority: the request's grant replaces it.
    const widened = withTesting(f.config, (testing) => ({ ...testing, execution: { ...testing["execution"] as object, authorization: { ...f.authorization, maximumParallelTasks: 2 } } }));
    f.responses.push(f.plan, ...f.writer);
    const replayed = await core.replay(source.runId, { mode: "testing", configuration: widened, execution: { mode: "execute", authorization: f.authorization } });
    expect(replayed.state).toBe("COMPLETED");
    expect((await store(path, replayed.runId).loadContext()).modelConfiguration?.workflow["testing"]).toMatchObject({ execution: { authorization: f.authorization } });
    const value = await report(core, replayed.runId);
    expect(decisions(value)).toEqual([["analysis", "reuse"], ["planning", "reuse"], ["execution", "regenerate"]]);
    expect(stage(value, "planning").regenerated).toEqual([expect.objectContaining({ reason: "source_artifact_unreadable" })]);
    expect(charged(await budget(path, replayed.runId), "testing/planner/", "testing/writer/")).toBe(true);
    expect(f.checks()).toBe(checks + 2);
    expect(await core.gate(replayed.runId)).toMatchObject({ gateStatus: "passed" });
    const replayWorkspace = await workspace(core, replayed.runId);
    expect(replayWorkspace).not.toBe(sourceWorkspace);
    await cleanup(core, replayed.runId);
    expect(await runDigest(path, source.runId)).toBe(before);
  });

  it("regenerates every stage under changed verification and runs fresh checks", async () => {
    const path = await root("e2e-testing-verification-");
    const f = await testingReplayFixture(path); const core = f.orchestrator();
    const source = await core.run(f.config); expect(source.state).toBe("COMPLETED");
    await cleanup(core, source.runId);
    const before = await runDigest(path, source.runId); const checks = f.checks(); const sent = f.sent.length;
    const verification = withTesting(f.config, (testing) => {
      const execution = testing["execution"] as { verification: { execution: Record<string, unknown> } };
      return { ...testing, execution: { ...execution, verification: { ...execution.verification, execution: { ...execution.verification.execution, maximumRuns: 8 } } } };
    });
    f.responses.push(...f.analysis, f.plan, ...f.writer);
    const replayed = await core.replay(source.runId, { mode: "testing", configuration: verification, execution: { mode: "execute", authorization: f.authorization } });
    expect(replayed.state).toBe("COMPLETED");
    expect(f.sent.slice(sent)).toEqual(["planning", "planning", "planning", "writer", "writer"]);
    const value = await report(core, replayed.runId);
    expect(value.stages.map(({ stage: name, decision, reasons }) => [name, decision, reasons])).toEqual([
      ["analysis", "regenerate", ["changed:settings"]], ["planning", "regenerate", ["changed:upstream"]],
      ["execution", "regenerate", ["side_effecting_stage_requires_fresh_evidence", "changed:settings", "changed:upstream"]],
    ]);
    expect(f.checks()).toBe(checks + 2);
    expect(await core.summary(replayed.runId)).toMatchObject({ replay: { execution: { mode: "execute", authority: "replay_request" } } });
    await cleanup(core, replayed.runId);
    expect(await runDigest(path, source.runId)).toBe(before);
  });

  it("resumes an interrupted execution replay as the same run under its contract, distinct from a new replay", async () => {
    const path = await root("e2e-testing-resume-");
    const f = await testingReplayFixture(path); const core = f.orchestrator();
    const source = await core.run(f.config); expect(source.state).toBe("COMPLETED");
    await cleanup(core, source.runId);
    const before = await runDigest(path, source.runId); const checks = f.checks();
    // No writer response is queued, so the replay's writer fails after analysis and planning were reused.
    const failed = await core.replay(source.runId, { mode: "testing", execution: { mode: "execute", authorization: f.authorization } });
    expect(failed.state).toBe("FAILED");
    const runs = (await core.runIds()).length;
    f.responses.push(...f.writer);
    const resumed = f.orchestrator(); await resumed.resume(failed.runId);
    expect((await resumed.wait(failed.runId)).state).toBe("COMPLETED");
    expect((await resumed.runIds()).length).toBe(runs);
    const value = await report(resumed, failed.runId);
    expect(decisions(value)).toEqual([["analysis", "reuse"], ["planning", "reuse"], ["execution", "regenerate"]]);
    expect(stage(value, "planning").reused).toHaveLength(1);
    expect(charged(await budget(path, failed.runId), "testing/writer/")).toBe(true);
    expect(f.checks()).toBe(checks + 2);
    expect(await resumed.gate(failed.runId)).toMatchObject({ gateStatus: "passed" });
    await cleanup(resumed, failed.runId);
    expect(await runDigest(path, source.runId)).toBe(before);
  });
});
