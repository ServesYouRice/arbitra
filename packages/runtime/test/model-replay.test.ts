import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runConfigSchema } from "@arbitra/schemas/config.js";
import { featureFixture } from "./feature-fixture.js";
import { budget, cleanup, report, runDigest, stage, testingReplayFixture, workspace } from "./replay-fixture.js";
import { orchestratorCore } from "../src/cli-core.js";
import { RunStore } from "../src/run-store.js";
import { Orchestrator } from "../src/orchestrator.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function root(prefix: string) { const path = await mkdtemp(join(tmpdir(), prefix)); roots.push(path); return path; }

it("reuses every compatible Feature stage without provider calls or budget and leaves the source byte-identical", async () => {
  const path = await root("feature-replay-");
  const f = await featureFixture(path, { highRisk: true }); const core = f.orchestrator();
  const source = await core.run(f.config); expect(source.state).toBe("COMPLETED");
  const calls = f.calls.length; const before = await runDigest(path, source.runId);

  const replayed = await f.orchestrator().replay(source.runId, { mode: "feature" });
  expect(replayed.state).toBe("COMPLETED");
  expect(replayed.runId).not.toBe(source.runId);
  expect(f.calls).toHaveLength(calls);
  expect(await core.gate(replayed.runId)).toEqual({ gateStatus: "passed", reasons: [] });
  const value = await report(core, replayed.runId);
  expect(value.stages.map(({ stage: name, decision }) => [name, decision])).toEqual([["requirements", "reuse"], ["exploration", "reuse"], ["review", "reuse"], ["requirements-revision", "reuse"], ["planning", "reuse"]]);
  for (const name of ["requirements", "exploration", "review", "planning"]) {
    expect(stage(value, name).reused.length).toBeGreaterThan(0);
    expect(stage(value, name).regenerated).toEqual([]);
  }
  // Reused stages consume no new budget and carry provenance to the source artifacts.
  expect(await budget(path, replayed.runId)).toEqual([]);
  expect(await budget(path, source.runId)).not.toEqual([]);
  const sourceArtifacts = new Set((await core.artifacts(source.runId)).map(({ artifactId }) => artifactId));
  for (const { sourceArtifactId } of value.stages.flatMap(({ reused }) => reused)) expect(sourceArtifacts.has(sourceArtifactId ?? "")).toBe(true);
  expect(await core.summary(replayed.runId)).toMatchObject({ mode: "feature", outcome: { passed: true }, replay: { sourceRunId: source.runId, mode: "feature" } });
  expect((await core.artifacts(replayed.runId)).some(({ kind }) => kind === "implementation")).toBe(true);
  expect(await runDigest(path, source.runId)).toBe(before);
});

it("regenerates changed-model stages and their dependents, charges only them, and resumes a failed replay as the same run", async () => {
  const path = await root("feature-replay-model-");
  const f = await featureFixture(path, { highRisk: true });
  const source = await f.orchestrator().run(f.config); expect(source.state).toBe("COMPLETED");
  const before = await runDigest(path, source.runId);
  // A second provider over the same state directory; its first planner call fails.
  const g = await featureFixture(path, { highRisk: true, failPlanner: true });
  const critic = f.config.models["critic"];
  if (critic === undefined) throw new Error("CRITIC_ABSENT");
  const configuration = runConfigSchema.parse({ ...f.config, models: { ...f.config.models, critic: { ...critic, modelId: `${critic.modelId}-next` } } });
  const failed = await g.orchestrator().replay(source.runId, { mode: "feature", configuration });
  expect(failed.state).toBe("FAILED");
  const resumed = g.orchestrator(); await resumed.resume(failed.runId);
  expect((await resumed.wait(failed.runId)).state).toBe("COMPLETED");
  expect(await resumed.gate(failed.runId)).toMatchObject({ gateStatus: "passed" });
  // Requirements and exploration were reused; review and planning were regenerated once.
  expect(g.calls.map(({ stage: name }) => name).sort()).toEqual(["critic", "planner", "planner", "review", "review"]);
  const value = await report(resumed, failed.runId);
  expect(value.stages.map(({ stage: name, decision }) => [name, decision])).toEqual([["requirements", "reuse"], ["exploration", "reuse"], ["review", "regenerate"], ["requirements-revision", "regenerate"], ["planning", "regenerate"]]);
  expect(stage(value, "review").reasons).toContain("changed:models");
  expect(stage(value, "planning").reasons).toEqual(expect.arrayContaining(["changed:models", "changed:upstream"]));
  expect(stage(value, "review").regenerated.every(({ reason }) => reason === "stage_invalidated")).toBe(true);
  const charged = await budget(path, failed.runId);
  expect(charged.length).toBeGreaterThan(0);
  expect(charged.every((activityId) => activityId.startsWith("feature/review/") || activityId.startsWith("feature/planner/") || activityId.startsWith("feature/critic/"))).toBe(true);
  expect(await runDigest(path, source.runId)).toBe(before);
});

it("reuses an explicitly named approved requirements contract and rejects stale or incompatible ones", async () => {
  const path = await root("feature-replay-approved-");
  const f = await featureFixture(path, { interactive: true }); const core = f.orchestrator();
  const source = await core.run(f.config); expect(source.state).toBe("BLOCKED");
  const initial = await core.requirements(source.runId); if (initial === null) throw new Error("CHECKPOINT_ABSENT");
  const revised = await core.reviseRequirements(source.runId, initial.artifactId, { ...f.draft, assumptions: [{ id: "assumption", statement: "Keep existing sessions for a day", confidence: "high" }] });
  // A replay cannot adopt a contract that is not approved.
  await expect(core.replay(source.runId, { mode: "feature", requirements: { decision: "reuse_approved", artifactId: revised.artifactId } })).rejects.toThrow("REPLAY_REQUIREMENTS_NOT_APPROVED");
  await core.approveRequirements(source.runId, { artifactId: revised.artifactId, ambiguityIds: ["migration"] });
  await core.resume(source.runId); expect((await core.wait(source.runId)).state).toBe("COMPLETED");
  const approved = await core.requirements(source.runId); if (approved === null) throw new Error("CHECKPOINT_ABSENT");
  const calls = f.calls.length; const before = await runDigest(path, source.runId);

  // Superseded versions, including the unapproved revision, are stale.
  for (const stale of [initial.artifactId, revised.artifactId]) {
    await expect(core.replay(source.runId, { mode: "feature", requirements: { decision: "reuse_approved", artifactId: stale } })).rejects.toThrow("REPLAY_REQUIREMENTS_CONTRACT_STALE");
  }
  const changed = runConfigSchema.parse({ ...f.config, workflow: { ...f.config.workflow, feature: { ...f.config.workflow["feature"] as object, request: "Add session preferences and themes" } } });
  await expect(core.replay(source.runId, { mode: "feature", configuration: changed, requirements: { decision: "reuse_approved", artifactId: approved.artifactId } })).rejects.toThrow("REPLAY_REQUIREMENTS_CONTRACT_INCOMPATIBLE");

  const reused = await core.replay(source.runId, { mode: "feature", requirements: { decision: "reuse_approved", artifactId: approved.artifactId } });
  expect(reused.state).toBe("COMPLETED");
  expect(f.calls).toHaveLength(calls);
  expect(await core.requirements(reused.runId)).toMatchObject({ artifactId: approved.artifactId, pendingAmbiguityIds: [], contract: approved.contract });
  expect(await core.gate(reused.runId)).toMatchObject({ gateStatus: "passed" });

  // Without that explicit decision, the reused draft needs fresh operator approval.
  const reapproval = await core.replay(source.runId, { mode: "feature" });
  expect(reapproval.state).toBe("BLOCKED");
  expect(f.calls).toHaveLength(calls);
  expect((await core.requirements(reapproval.runId))?.pendingAmbiguityIds).toEqual(["migration"]);
  expect(await runDigest(path, source.runId)).toBe(before);
});

it("regenerates from a changed request and from missing or corrupt source artifacts, never reusing them silently", async () => {
  const path = await root("feature-replay-missing-");
  const f = await featureFixture(path); const core = f.orchestrator();
  const source = await core.run(f.config); expect(source.state).toBe("COMPLETED");
  const calls = f.calls.length;

  const changed = runConfigSchema.parse({ ...f.config, workflow: { ...f.config.workflow, feature: { ...f.config.workflow["feature"] as object, request: "Add session preferences and themes" } } });
  const regenerated = await core.replay(source.runId, { mode: "feature", configuration: changed });
  expect(regenerated.state).toBe("COMPLETED");
  expect(f.calls.slice(calls).map(({ stage: name }) => name)).toEqual(["requirements", "exploration", "planner"]);
  expect((await report(core, regenerated.runId)).stages.map(({ decision, reasons }) => [decision, reasons.includes("changed:settings") || reasons.includes("changed:upstream")]))
    .toEqual(Array.from({ length: 5 }, () => ["regenerate", true]));

  // Delete the saved exploration output and corrupt the saved planner output.
  const store = new RunStore(join(path, ".runs", "runs"), source.runId);
  const outputs = (await store.listArtifacts()).filter(({ kind }) => kind.startsWith("model-activity-") && !kind.endsWith("-input") && !kind.endsWith("-trace"));
  const exploration = outputs.find(({ nodeId }) => nodeId?.startsWith("feature/exploration/"));
  const planner = outputs.find(({ nodeId }) => nodeId?.startsWith("feature/planner/"));
  if (exploration === undefined || planner === undefined) throw new Error("SOURCE_OUTPUT_ABSENT");
  await unlink(join(store.directory, exploration.ref.relativePath));
  const plannerPath = join(store.directory, planner.ref.relativePath);
  await writeFile(plannerPath, "{}");
  const before = await runDigest(path, source.runId);
  const count = f.calls.length;
  const recovered = await core.replay(source.runId, { mode: "feature" });
  expect(recovered.state).toBe("COMPLETED");
  expect(f.calls.slice(count).map(({ stage: name }) => name)).toEqual(["exploration", "planner"]);
  const value = await report(core, recovered.runId);
  expect(stage(value, "requirements").reused).toHaveLength(1);
  expect(stage(value, "exploration").regenerated).toEqual([expect.objectContaining({ reason: "source_artifact_unreadable" })]);
  expect(stage(value, "planning").regenerated).toEqual([expect.objectContaining({ reason: "source_artifact_unreadable" })]);
  expect(await budget(path, recovered.runId)).toEqual(expect.arrayContaining([expect.stringMatching(/^feature\/exploration\//u), expect.stringMatching(/^feature\/planner\//u)]));
  expect(await runDigest(path, source.runId)).toBe(before);
});

it("fails incompatible replay requests explicitly before creating a run", async () => {
  const path = await root("feature-replay-invalid-");
  const f = await featureFixture(path); const core = f.orchestrator();
  const source = await core.run(f.config);
  const runs = (await core.runIds()).length;
  await expect(core.replay(source.runId, { mode: "testing", execution: { mode: "plan" } })).rejects.toThrow("REPLAY_MODE_MISMATCH:feature:testing");
  await expect(core.replay(source.runId, { consensusPolicy: "full", maximumRounds: 1, criticEnabled: true })).rejects.toThrow("FEATURE_AUDIT_REPLAY_NOT_SUPPORTED");
  await expect(core.startReplay(source.runId, { mode: "feature", unexpected: true })).rejects.toThrow("INVALID_REPLAY_REQUEST");
  const testing = (await testingReplayFixture(await root("feature-replay-testing-config-"))).config;
  await expect(core.replay(source.runId, { mode: "feature", configuration: testing })).rejects.toThrow("REPLAY_CONFIGURATION_MODE_MISMATCH");
  await expect(core.replay("run-absent", { mode: "feature" })).rejects.toThrow("RUN_ABSENT");
  expect((await core.runIds()).length).toBe(runs);
});

it("replays Testing planning without dispatching writers or checks, even from an execution run", async () => {
  const path = await root("testing-replay-plan-");
  const f = await testingReplayFixture(path); const core = f.orchestrator();
  const source = await core.run(f.config); expect(source.state).toBe("COMPLETED");
  expect(f.checks()).toBe(2);
  await cleanup(core, source.runId);
  const before = await runDigest(path, source.runId); const sent = f.sent.length;
  // Analysis and planning were bound to the execution grant, so a plan-only replay of an
  // execution run regenerates them; it still never reaches a writer or a check.
  f.responses.push(...f.analysis, f.plan);
  const replayed = await core.replay(source.runId, { mode: "testing", execution: { mode: "plan" } });
  expect(replayed.state).toBe("COMPLETED");
  expect(f.sent.slice(sent)).toEqual(["planning", "planning", "planning"]);
  expect(f.checks()).toBe(2);
  expect((await core.status(replayed.runId)).workflow?.id).toBe("testing-plan");
  expect(await core.summary(replayed.runId)).toMatchObject({ outcome: { passed: true, testsExecuted: false }, execution: null, replay: { execution: { mode: "plan" } } });
  expect((await core.artifacts(replayed.runId)).some(({ kind }) => kind === "testing-workspace" || kind.startsWith("testing-execution"))).toBe(false);
  const value = await report(core, replayed.runId);
  expect(value.stages.map(({ stage: name, decision }) => [name, decision])).toEqual([["analysis", "regenerate"], ["planning", "regenerate"]]);
  expect(stage(value, "planning").reasons).toEqual(expect.arrayContaining(["changed:settings", "changed:upstream"]));
  expect(await budget(path, replayed.runId)).toHaveLength(3);
  expect(await runDigest(path, source.runId)).toBe(before);

  // The planning replay is itself a compatible source for another planning replay.
  const again = await core.replay(replayed.runId, { mode: "testing", execution: { mode: "plan" } });
  expect(again.state).toBe("COMPLETED");
  expect(f.sent.slice(sent)).toHaveLength(3);
  expect((await report(core, again.runId)).stages.map(({ decision }) => decision)).toEqual(["reuse", "reuse"]);
});

it("requires fresh explicit write authority and runs execution replay in its own worktree with fresh evidence", async () => {
  const path = await root("testing-replay-execute-");
  const f = await testingReplayFixture(path); const core = f.orchestrator();
  const source = await core.run(f.config); expect(source.state).toBe("COMPLETED");
  const sourceWorkspace = await workspace(core, source.runId);
  await cleanup(core, source.runId);
  const before = await runDigest(path, source.runId); const sent = f.sent.length;

  await expect(core.replay(source.runId, { mode: "testing" } as never)).rejects.toThrow("INVALID_REPLAY_REQUEST");
  await expect(core.replay(source.runId, { mode: "testing", execution: { mode: "execute" } } as never)).rejects.toThrow("INVALID_REPLAY_REQUEST");

  f.responses.push(...f.writer);
  const replayed = await core.replay(source.runId, { mode: "testing", execution: { mode: "execute", authorization: f.authorization } });
  expect(replayed.state).toBe("COMPLETED");
  // Analysis and planning are reused; the writer runs again and checks produce new evidence.
  expect(f.sent.slice(sent)).toEqual(["writer", "writer"]);
  expect(f.checks()).toBe(4);
  expect(await core.gate(replayed.runId)).toMatchObject({ gateStatus: "passed" });
  const value = await report(core, replayed.runId);
  expect(value.stages.map(({ stage: name, decision }) => [name, decision])).toEqual([["analysis", "reuse"], ["planning", "reuse"], ["execution", "regenerate"]]);
  expect(stage(value, "execution").reasons).toContain("side_effecting_stage_requires_fresh_evidence");
  expect(stage(value, "execution").reused).toEqual([]);
  expect(await core.summary(replayed.runId)).toMatchObject({ replay: { execution: { mode: "execute", authority: "replay_request" } } });
  const replayWorkspace = await workspace(core, replayed.runId);
  expect(replayWorkspace).not.toBe(sourceWorkspace);
  await cleanup(core, replayed.runId);
  const sourceEvidence = (await core.artifacts(source.runId)).filter(({ kind }) => kind.startsWith("testing-change-set-")).map(({ artifactId }) => artifactId);
  expect((await core.artifacts(replayed.runId)).some(({ kind }) => kind === "testing-execution-completion")).toBe(true);
  expect(await readFile(join(path, "session.unit.test.ts"), "utf8")).toBe("test('unrelated', () => {});\n");
  expect(sourceEvidence.length).toBeGreaterThan(0);
  expect(await runDigest(path, source.runId)).toBe(before);

  // Changing the write grant invalidates analysis and planning as well as execution.
  f.responses.push(...f.analysis, f.plan, ...f.writer);
  const widened = await core.replay(source.runId, { mode: "testing", execution: { mode: "execute", authorization: { ...f.authorization, maximumParallelTasks: 2 } } });
  expect(widened.state).toBe("COMPLETED");
  expect(stage(await report(core, widened.runId), "planning")).toMatchObject({ decision: "regenerate", reasons: ["changed:settings", "changed:upstream"] });
  await cleanup(core, widened.runId);
  expect(await runDigest(path, source.runId)).toBe(before);
});

it("refuses an execution replay of a planning run unless execution settings are supplied", async () => {
  const path = await root("testing-replay-plan-source-");
  const f = await testingReplayFixture(path, { execute: false }); const core = f.orchestrator();
  const source = await core.run(f.config); expect(source.state).toBe("COMPLETED");
  await expect(core.replay(source.runId, { mode: "testing", execution: { mode: "execute", authorization: f.authorization } })).rejects.toThrow("REPLAY_EXECUTION_CONFIGURATION_REQUIRED");
  // The CLI request path reaches the same orchestrator decision.
  const requestPath = join(path, "replay.json");
  await writeFile(requestPath, JSON.stringify({ mode: "testing", execution: { mode: "plan" } }));
  const result = await orchestratorCore(core).replayRequest(source.runId, requestPath);
  expect(result).toMatchObject({ disposition: "passed", value: { state: "COMPLETED", summary: { replay: { sourceRunId: source.runId } } } });
  expect(f.checks()).toBe(0);
});

it("refuses a model replay through preflight before creating a run when a credential is missing", async () => {
  const path = await root("replay-preflight-");
  const f = await featureFixture(path);
  const source = await f.orchestrator().run(f.config); expect(source.state).toBe("COMPLETED");
  const runs = () => readdir(join(path, ".runs", "runs"));
  const before = await runs();
  const missing = new Orchestrator({ repository: path, providerOptions: { ...f.providerOptions, credential: () => undefined } });
  await expect(missing.replay(source.runId, { mode: "feature" })).rejects.toThrow("PROVIDER_CREDENTIAL_MISSING:primary at workflow.modelExecution.endpoints.0.apiKeyEnvVar");
  expect(await runs()).toEqual(before);
});
