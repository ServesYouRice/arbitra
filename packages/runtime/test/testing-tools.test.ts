import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WritePartitions } from "@arbitra/security/write-partitions";
import { runConfigSchema } from "@arbitra/schemas/config.js";
import { featureFixture } from "./feature-fixture.js";
import { snapshotRepository } from "../src/repository.js";
import { RunStore } from "../src/run-store.js";
import { TestingWorkspace } from "../src/testing-workspace.js";
import { TestingWorktree, type TestingWorktreeHandle } from "../src/testing-worktree.js";
import { testingToolExtension } from "../src/testing-tools.js";
import { ModelHarness } from "../src/model-harness.js";
import { ModelActivities } from "../src/model-activities.js";
import { modelTestingWriter } from "../src/model-testing-writer.js";
import { planIRSchema } from "@arbitra/schemas/plan.js";
import { testingExecutionSchema } from "@arbitra/schemas/testing.js";
import { testingVerificationPolicySchema } from "@arbitra/schemas/testing-verification.js";
import { runTestingTask } from "../src/testing-task-runner.js";
import { TestingTaskVerifier } from "../src/testing-task-verifier.js";
import type { HarnessToolRuntime } from "@arbitra/harness/adapter.js";

const roots: string[] = []; const handles: TestingWorktreeHandle[] = [];
afterEach(async () => { await Promise.all([...new Map(handles.splice(0).map((handle) => [handle.directory, handle])).values()].map((handle) => TestingWorktree.recover(handle))); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const signal = () => new AbortController().signal;
const base: HarnessToolRuntime = { async invoke() { throw new Error("UNEXPECTED_BASE_TOOL"); } };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "testing-tools-")); roots.push(root);
  const f = await featureFixture(root);
  const config = runConfigSchema.parse({ ...f.config, mode: "testing", workflow: { modelExecution: f.config.workflow["modelExecution"] } });
  const snapshot = await snapshotRepository(root); const store = new RunStore(join(root, ".runs"), "run");
  const create = async () => {
    const partitions = new WritePartitions([{ id: "tests", paths: ["session.test.ts"] }]);
    const workspace = new TestingWorkspace(store, partitions); handles.push(await workspace.prepare(snapshot, signal()));
    const lease = partitions.acquire({ taskId: "TASK-001", partitionId: "tests", paths: ["session.test.ts"] });
    return { partitions, workspace, lease, extension: testingToolExtension(store, workspace, partitions, lease) };
  };
  return { root, config, snapshot, store, create, ...await create() };
}
const context = (index: number) => ({ nodeId: "writer", callId: `call-${index}`, turn: 0, callIndex: index, protect: (content: string) => content });

it("writes only live leased files and replays stable tool results after workspace recovery", async () => {
  const f = await fixture(); const runtime = f.extension.createRuntime(base, "writer", signal());
  const args = { path: "session.test.ts", expectedHash: null, content: "test('session', () => {});\n" };
  const written = await runtime.invoke("testing_write_file", args, context(0)); expect(written.ok).toBe(true);
  const read = await runtime.invoke("testing_read_file", { path: "session.test.ts" }, context(1)); expect(read.content).toContain("test('session'");
  expect(await runtime.invoke("testing_write_file", { ...args, path: "session.ts" }, context(2))).toMatchObject({ ok: false, error: { code: "WRITE_OUTSIDE_LEASE" } });
  f.partitions.release(f.lease); const restarted = await f.create();
  const next = restarted.extension.createRuntime(base, "writer", signal());
  expect(await next.invoke("testing_write_file", args, context(0))).toEqual(written);
  expect(await next.invoke("testing_read_file", { path: "session.test.ts" }, context(1))).toEqual(read);
  await expect(next.invoke("testing_write_file", { ...args, content: "changed" }, context(0))).rejects.toThrow("TESTING_TOOL_CALL_CHANGED");
  expect(await readFile(join(f.root, "session.ts"), "utf8")).toBe("export const version = 1;\n");
  restarted.partitions.release(restarted.lease); await restarted.workspace.close();
});

it("keeps read scope, cancellation and stale leases outside model control", async () => {
  const f = await fixture();
  const scoped = f.extension.createRuntime(base, "writer", signal(), []);
  expect(await scoped.invoke("testing_read_file", { path: "session.ts" }, context(0))).toMatchObject({ ok: false, error: { code: "TESTING_FILE_NOT_IN_WORKSPACE" } });
  expect(await scoped.invoke("testing_shell", {}, context(1))).toMatchObject({ ok: false, error: { code: "TESTING_TOOL_NOT_ALLOWED" } });
  const controller = new AbortController(); controller.abort();
  await expect(f.extension.createRuntime(base, "writer", controller.signal).invoke("testing_read_file", { path: "session.ts" }, context(0))).rejects.toThrow("TESTING_TOOL_CANCELLED");
  f.partitions.release(f.lease);
  await expect(scoped.invoke("testing_read_file", { path: "session.ts" }, context(0))).rejects.toThrow("STALE_OR_FORGED_WRITE_LEASE");
});

it("replays injected provider tool turns across an interruption without repeating writes", async () => {
  const f = await fixture(); let calls = 0;
  const provider = { credential: () => "fixture-key", client: { async send() {
    calls += 1;
    if (calls === 3) throw new Error("INTERRUPTED");
    const tool = calls === 1 ? { name: "testing_write_file", arguments: { path: "session.test.ts", expectedHash: null, content: "test('session', () => {});\n" } } : calls === 2 ? { name: "testing_read_file", arguments: { path: "session.test.ts" } } : null;
    return { status: 200, headers: {}, body: { ...(tool === null ? { output_text: '{"answer":"done"}' } : { output: [{ type: "function_call", call_id: `call-${calls}`, name: tool.name, arguments: JSON.stringify(tool.arguments) }] }), usage: { input_tokens: 10, output_tokens: 10 } } };
  } } };
  const input = { activityId: "writer", modelProfileId: "planner", protocol: "fixture@1", signal: signal(), messages: [{ role: "user" as const, content: "Write the test, read it, then return JSON." }], schema: { parse(value: unknown) { return value; } } };
  const harness = new ModelHarness(new ModelActivities(f.store, f.config, provider), f.config, f.snapshot, f.store, f.extension);
  await expect(harness.invoke(input)).rejects.toThrow("Provider openai failed");
  f.partitions.release(f.lease); const restarted = await f.create();
  const resumed = new ModelHarness(new ModelActivities(f.store, f.config, provider), f.config, f.snapshot, f.store, restarted.extension);
  expect(await resumed.invoke(input)).toEqual({ answer: "done" }); expect(calls).toBe(4);
  expect((await restarted.workspace.verificationInput("TASK-001")).writes).toHaveLength(1);
  const descriptor = (await f.store.listArtifacts()).find(({ kind }) => kind.startsWith("harness-")); if (descriptor === undefined) throw new Error("HARNESS_ABSENT");
  expect(await f.store.artifacts.get(descriptor.ref)).toMatchObject({ profile: { id: "arbitra-canonical-testing-writer", capabilities: { writeFiles: true, shell: false } } });
  const audit = runConfigSchema.parse({ ...f.config, mode: "audit" });
  await expect(new ModelHarness(new ModelActivities(f.store, audit, provider), audit, f.snapshot, f.store, restarted.extension).invoke(input)).rejects.toThrow("TESTING_WRITE_HARNESS_MODE_REQUIRED");
  const native = runConfigSchema.parse({ ...f.config, harness: { mode: "native" } });
  await expect(new ModelHarness(new ModelActivities(f.store, native, provider), native, f.snapshot, f.store, restarted.extension).invoke(input)).rejects.toThrow("TESTING_WRITE_HARNESS_MODE_REQUIRED");
  await expect(resumed.invoke({ ...input, activityId: "writer/discovery" })).rejects.toThrow("TESTING_WRITE_HARNESS_MODE_REQUIRED");
  restarted.partitions.release(restarted.lease); await restarted.workspace.close();
});

it("paginates long UTF-8 lines without dropping characters or separators", async () => {
  const f = await fixture(); const runtime = f.extension.createRuntime(base, "writer", signal());
  const content = `${"😀".repeat(2048)}\n${"界".repeat(3000)}\nlast\n`;
  expect((await runtime.invoke("testing_write_file", { path: "session.test.ts", expectedHash: null, content }, context(0))).ok).toBe(true);
  let startLine = 1; let startColumn = 1; let combined = ""; let calls = 0;
  while (calls < 10) {
    calls += 1;
    const result = await runtime.invoke("testing_read_file", { path: "session.test.ts", startLine, startColumn }, context(calls));
    const value = JSON.parse(result.content) as { content: string; nextLine: number | null; nextColumn: number | null };
    expect(Buffer.byteLength(value.content)).toBeLessThanOrEqual(8192); combined += value.content;
    if (value.nextLine === null || value.nextColumn === null) break;
    startLine = value.nextLine; startColumn = value.nextColumn;
  }
  expect(combined).toBe(content); expect(calls).toBeLessThan(10);
  f.partitions.release(f.lease); await f.workspace.close();
});

it("pins writer context across interrupted writes and rejects changed attempt bindings", async () => {
  const f = await fixture();
  const plan = planIRSchema.parse(JSON.parse(await readFile(new URL("../../schemas/test/golden/plan-ir.valid.json", import.meta.url), "utf8")));
  const task = plan.tasks[0]; if (task === undefined) throw new Error("TASK_ABSENT");
  task.scope.likelyFiles = ["session.test.ts"]; task.routing.capability = "fast";
  const attempt = { id: `${task.id}/attempt-1`, ordinal: 1, capability: "fast" as const, state: "reserved" as const };
  let calls = 0;
  const provider = { credential: () => "fixture-key", client: { async send() {
    calls += 1;
    if (calls === 2) throw new Error("INTERRUPTED");
    return { status: 200, headers: {}, body: { ...(calls === 1 ? { output: [{ type: "function_call", call_id: "write", name: "testing_write_file", arguments: JSON.stringify({ path: "session.test.ts", expectedHash: null, content: "test('session', () => {});\n" }) }] } : { output_text: '{"summary":"Added test","limitations":["Fixture only"]}' }), usage: { input_tokens: 10, output_tokens: 10 } } };
  } } };
  const invoke = (current: Awaited<ReturnType<typeof f.create>>, feedback: unknown, modelProfileId = "planner") => modelTestingWriter(f.store, f.config, new ModelActivities(f.store, f.config, provider), task, attempt, current.workspace, current.partitions, current.lease, { modelProfileId, feedback, signal: signal() });
  await expect(invoke(f, { initial: true })).rejects.toThrow("Provider openai failed");
  f.partitions.release(f.lease); const restarted = await f.create();
  expect(await invoke(restarted, { changedAfterRestart: true })).toEqual({ summary: "Added test", limitations: ["Fixture only"] });
  expect(calls).toBe(3);
  expect((await restarted.workspace.verificationInput(task.id)).writes).toHaveLength(1);
  const descriptor = (await f.store.listArtifacts()).find(({ kind }) => kind.startsWith("testing-writer-input-"));
  if (descriptor === undefined) throw new Error("PINNED_INPUT_ABSENT");
  const pinned = await f.store.artifacts.get<{ snapshot: { files: { path: string }[] }; feedback: unknown }>(descriptor.ref);
  expect(pinned.feedback).toEqual({ initial: true });
  expect(pinned.snapshot.files.some(({ path }) => path === "session.test.ts")).toBe(false);
  await expect(invoke(restarted, {}, "critic")).rejects.toThrow("TESTING_WRITER_INPUT_CHANGED");
  restarted.partitions.release(restarted.lease);
  await expect(invoke(restarted, {})).rejects.toThrow("STALE_OR_FORGED_WRITE_LEASE");
  await restarted.workspace.close();
});

it.each(["pass", "exhausted", "limitations"])("runs bounded writer attempts and replays terminal state: %s", async (scenario) => {
  const f = await fixture(); f.partitions.release(f.lease);
  const plan = planIRSchema.parse(JSON.parse(await readFile(new URL("../../schemas/test/golden/plan-ir.valid.json", import.meta.url), "utf8")));
  const task = plan.tasks[0]; if (task === undefined) throw new Error("TASK_ABSENT");
  task.scope.likelyFiles = ["session.test.ts"]; task.routing.capability = "fast";
  task.verification.commands = [{ command: "node --test", executionPolicy: "allowlisted", expectedExitCode: 0 }];
  const config = runConfigSchema.parse({ ...f.config, models: { ...f.config.models, critic: { ...f.config.models["critic"], capabilityTier: "frontier" } } });
  const policy = testingVerificationPolicySchema.parse({ execution: { driver: "docker", image: `local/node@sha256:${"a".repeat(64)}`, maximumRuns: 4, checks: [{ id: "tests", executable: "/usr/bin/node", arguments: ["--test"], sourcePaths: ["session.test.ts"] }] }, bindings: [{ command: "node --test", checkId: "tests", authorization: "allowlisted", expectedExitCode: 0 }] });
  let calls = 0; let checks = 0;
  const provider = { credential: () => "fixture-key", client: { async send() {
    calls += 1;
    return { status: 200, headers: {}, body: { ...(calls === 1 ? { output: [{ type: "function_call", call_id: "write", name: "testing_write_file", arguments: JSON.stringify({ path: "session.test.ts", expectedHash: null, content: "test('session', () => {});\n" }) }] } : { output_text: JSON.stringify({ summary: "Reviewed test", limitations: scenario === "limitations" ? ["Missing edge case"] : [] }) }), usage: { input_tokens: 10, output_tokens: 10 } } };
  } } };
  const settings = testingExecutionSchema.parse({ mode: "plan", goal: "Test session", roles: { analyst: "planner", planner: "planner" } });
  const verifier = new TestingTaskVerifier(f.store, f.snapshot, settings, policy, { async recover() {}, async run() {
    checks += 1;
    return { driver: "docker", image: policy.execution.image, checkId: "tests", isolation: "read_only_snapshot_no_network", status: "exited", stopped: null, cleanupCompleted: true, exitCode: scenario === "exhausted" || scenario === "pass" && checks < 3 ? 1 : 0, stdout: "assertion output", stderr: "" };
  } });
  const input = { store: f.store, config, activities: new ModelActivities(f.store, config, provider), task, policy,
    request: { taskId: task.id, partitionId: "tests", paths: ["session.test.ts"] }, partitions: f.partitions, workspace: f.workspace, verifier,
    models: { fast: "planner", balanced: "planner", frontier: "critic" }, signal: signal() };
  const result = await runTestingTask(input);
  expect(result.state).toBe(scenario === "pass" ? "completed" : "blocked");
  expect(result.attempts.map(({ capability, result: status }) => [capability, status])).toEqual(scenario === "pass" ? [["fast", "failed"], ["fast", "failed"], ["frontier", "passed"]]
    : scenario === "exhausted" ? [["fast", "failed"], ["fast", "failed"], ["frontier", "failed"], ["frontier", "failed"]]
      : [["fast", "incomplete"], ["fast", "incomplete"], ["fast", "incomplete"], ["fast", "incomplete"]]);
  const expectedChecks = scenario === "pass" ? 3 : 4;
  expect(checks).toBe(expectedChecks); expect(calls).toBe(expectedChecks + 1); expect(f.partitions.active()).toEqual([]);
  expect(await runTestingTask(input)).toEqual(result); expect(checks).toBe(expectedChecks); expect(calls).toBe(expectedChecks + 1);
  await expect(runTestingTask({ ...input, maximumAttempts: 5 })).rejects.toThrow("TESTING_TASK_RUNNER_CONFIGURATION_CHANGED");
  await f.workspace.close();
});
