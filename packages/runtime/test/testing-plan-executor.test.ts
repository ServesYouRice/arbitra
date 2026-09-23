import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { canonicalJson } from "@arbitra/core/config/config-store.js";
import { runConfigSchema } from "@arbitra/schemas/config.js";
import { testingVerificationPolicySchema } from "@arbitra/schemas/testing-verification.js";
import { featureFixture } from "./feature-fixture.js";
import { ModelActivities } from "../src/model-activities.js";
import { snapshotRepository } from "../src/repository.js";
import { RunStore } from "../src/run-store.js";
import { TestingPlanExecutor } from "../src/testing-plan-executor.js";
import { TestingWorktree, type TestingWorktreeHandle } from "../src/testing-worktree.js";
import type { TestSandbox } from "../src/test-sandbox.js";
import type { HttpRequest } from "@arbitra/providers/transport-contract.js";

const fixtures: { root: string; store: RunStore }[] = [];
afterEach(async () => {
  for (const { root, store } of fixtures.splice(0)) {
    const record = (await store.listArtifacts()).find(({ kind }) => kind === "testing-workspace");
    if (record !== undefined) {
      const { handle } = await store.artifacts.get<{ handle?: TestingWorktreeHandle }>(record.ref);
      if (handle !== undefined) await TestingWorktree.recover(handle);
    }
    await rm(root, { recursive: true, force: true });
  }
});
const signal = () => new AbortController().signal;
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

async function fixture(scenario = "pass") {
  const root = await mkdtemp(join(tmpdir(), "testing-executor-"));
  const store = new RunStore(join(root, ".runs"), "run"); fixtures.push({ root, store });
  const f = await featureFixture(root);
  const config = runConfigSchema.parse({ ...f.config, mode: "testing", models: { ...f.config.models, planner: { ...f.config.models["planner"], capabilityTier: "frontier" } },
    workflow: { modelExecution: f.config.workflow["modelExecution"], testing: { mode: "plan", goal: "Test sessions", roles: { analyst: "planner", planner: "planner" } } } });
  const snapshot = await snapshotRepository(root);
  const plan = f.plan; plan.mode = "testing";
  const first = plan.tasks[0]; if (first === undefined) throw new Error("TASK_ABSENT");
  plan.tasks = ["001", "002"].map((number) => ({ ...structuredClone(first), id: `TASK-${number}`, scope: { likelyFiles: [`tests/${number}.ts`], components: [], interfaces: [] },
    dependencies: { dependsOn: number === "002" ? ["TASK-001"] : [], blocks: number === "001" ? ["TASK-002"] : [], conflictsWith: [] },
    verification: { ...first.verification, commands: [{ command: `check ${number}`, executionPolicy: "allowlisted" as const, expectedExitCode: 0 }] } }));
  plan.taskGraph = [{ from: "TASK-001", to: "TASK-002" }];
  if (scenario.startsWith("parallel")) {
    plan.taskGraph = [];
    for (const task of plan.tasks) task.dependencies = { dependsOn: [], blocks: [], conflictsWith: [] };
  }
  plan.routingRecommendations = plan.tasks.map(({ id, routing }) => ({ taskId: id, capability: routing.capability, effort: routing.effort, reason: routing.reason }));
  const link = plan.traceability.requirementLinks.links[0]; if (link === undefined) throw new Error("LINK_ABSENT");
  link.taskIds = plan.tasks.map(({ id }) => id);
  const savePlan = async (passed = true) => {
    await store.publish("plan-ir", plan, "testing");
    await store.publish("testing-outcome", { passed, reasons: passed ? [] : ["planning_limit"], testsExecuted: false, selectedGaps: 1, planFingerprint: hash(plan) }, "testing");
  };
  await savePlan();
  const policy = testingVerificationPolicySchema.parse({ execution: { driver: "docker", image: `local/node@sha256:${"a".repeat(64)}`, maximumRuns: scenario === "budget" ? 2 : 6,
    checks: ["001", "002"].map((number) => ({ id: number, executable: "/usr/bin/node", arguments: ["--test", `tests/${number}.ts`], sourcePaths: [`tests/${number}.ts`] })) },
    bindings: ["001", "002"].map((number) => ({ command: `check ${number}`, checkId: number, authorization: "allowlisted", expectedExitCode: 0 })) });
  const options = { authorization: { maximumParallelTasks: 2, partitions: [{ id: "tests", paths: ["tests/001.ts", "tests/002.ts"] }], tasks: plan.tasks.map(({ id }) => ({ taskId: id, partitionId: "tests", exclusive: false })) },
    verification: policy, models: { fast: "planner", balanced: "planner", frontier: "planner" }, maximumAttempts: 1 };
  let calls = 0; const checks: { id: string; paths: string[] }[] = [];
  const turns = new Map<string, number>(); let arrivals = 0; let release: () => void = () => {}; let interrupted = false;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const provider = { credential: () => "fixture-key", client: { async send(request: HttpRequest) {
    calls += 1;
    const body = request.body as { input: { role: string; content: string }[] };
    const user = body.input.find(({ role }) => role === "user")?.content ?? "";
    const layers = user.split("\n").map((line) => JSON.parse(line) as { value: { artifacts?: string[] } });
    const framed = layers.flatMap(({ value }) => value.artifacts ?? [])[0] ?? "";
    const content = /-->\n([\s\S]*)\n<\/repository_content>$/u.exec(framed)?.[1] ?? "{}";
    const payload = JSON.parse(content.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")) as { task: { id: string } };
    const number = payload.task.id === "TASK-002" ? "002" : "001";
    const turn = turns.get(number) ?? 0;
    if (scenario.startsWith("parallel") && turn === 0) { arrivals += 1; if (arrivals >= 2) release(); await barrier; }
    if (scenario === "parallel-interrupted" && number === "001" && !interrupted) { interrupted = true; throw new Error("WRITER_INTERRUPTED"); }
    turns.set(number, turn + 1);
    return { status: 200, headers: {}, body: { ...(turn === 0 ? { output: [{ type: "function_call", call_id: "write", name: "testing_write_file", arguments: JSON.stringify({ path: `tests/${number}.ts`, expectedHash: null, content: `test('${number}', () => {});\n` }) }] } : { output_text: '{"summary":"Added test","limitations":[]}' }), usage: { input_tokens: 10, output_tokens: 10 } } };
  } } };
  const sandbox: TestSandbox = { async recover() {}, async run(current, execution, check) {
    const paths = current.files.map(({ path }) => path); checks.push({ id: check.id, paths });
    if (scenario.startsWith("parallel")) { expect(paths).toContain("tests/001.ts"); expect(paths).toContain("tests/002.ts"); expect(turns.get("001")).toBe(2); expect(turns.get("002")).toBe(2); }
    const failed = scenario === "blocked" || scenario === "invalidated" && check.id === "001" && paths.includes("tests/002.ts");
    return { driver: "docker", image: execution.image, checkId: check.id, isolation: "read_only_snapshot_no_network", status: "exited", stopped: null, cleanupCompleted: true, exitCode: failed ? 1 : 0, stdout: "assertion result", stderr: "" };
  } };
  const executor = () => new TestingPlanExecutor(store, config, snapshot, new ModelActivities(store, config, provider), options, sandbox);
  return { root, store, plan, options, savePlan, executor, checks, calls: () => calls };
}

it.each(["pass", "invalidated", "budget", "blocked"])("coordinates whole-plan execution and replays %s", async (scenario) => {
  const f = await fixture(scenario); const executor = f.executor();
  const result = await executor.run(signal());
  expect(result.passed).toBe(scenario === "pass");
  expect(result.tasks.map(({ state }) => state)).toEqual(scenario === "blocked" ? ["blocked"] : ["completed", "completed"]);
  expect(f.checks[0]?.paths).not.toContain("tests/002.ts");
  if (scenario !== "blocked") expect(f.checks[1]?.paths).toContain("tests/002.ts");
  if (scenario === "invalidated") expect(result.reasons).toEqual(["final_verification_failed:TASK-001"]);
  if (scenario === "budget") expect(result.finalVerification.every(({ status }) => status === "incomplete")).toBe(true);
  expect(result.finalVerification).toHaveLength(scenario === "blocked" ? 0 : 2);
  expect(f.calls()).toBe(scenario === "blocked" ? 2 : 4);
  expect(f.checks.map(({ id }) => id)).toEqual(scenario === "blocked" ? ["001"] : scenario === "budget" ? ["001", "002"] : ["001", "002", "001", "002"]);
  const calls = f.calls(); const checks = f.checks.length;
  expect(await f.executor().run(signal())).toEqual(result);
  expect(f.calls()).toBe(calls); expect(f.checks).toHaveLength(checks);
  if (scenario === "pass") {
    const handoff = await executor.handoff(signal());
    expect(handoff.changes.files.map(({ path, expectedHash }) => ({ path, expectedHash }))).toEqual([{ path: "tests/001.ts", expectedHash: null }, { path: "tests/002.ts", expectedHash: null }]);
    for (const file of handoff.changes.files) expect(createHash("sha256").update(file.content).digest("hex")).toBe(file.contentHash);
    expect(await f.executor().handoff(signal())).toEqual(handoff);
    await executor.close();
    expect(JSON.parse((await f.store.readArtifact(handoff.artifactId)).content)).toEqual(handoff.changes);
  } else {
    await expect(executor.handoff(signal())).rejects.toThrow("TESTING_VERIFIED_CHANGE_SET_REQUIRED");
    await executor.close();
  }
  expect(f.calls()).toBe(calls); expect(f.checks).toHaveLength(checks);
  expect(await readFile(join(f.root, "session.ts"), "utf8")).toBe("export const version = 1;\n");
});

it.each(["parallel", "parallel-interrupted"])("settles the parallel writer barrier before checking or releasing a failed batch: %s", async (scenario) => {
  const f = await fixture(scenario); let executor = f.executor();
  if (scenario === "parallel-interrupted") {
    await expect(executor.run(signal())).rejects.toThrow("Provider openai failed");
    expect(f.calls()).toBe(3); expect(f.checks).toHaveLength(0);
    executor = f.executor();
  }
  const result = await executor.run(signal());
  expect(result.passed).toBe(true); expect(f.checks).toHaveLength(4);
  expect(f.calls()).toBe(scenario === "parallel" ? 4 : 5);
  expect(await executor.run(signal())).toEqual(result);
  await executor.close();
});

it("rejects changed execution authority after a completed run", async () => {
  const f = await fixture(); await f.executor().run(signal());
  const calls = f.calls(); const checks = f.checks.length;
  f.options.maximumAttempts = 2;
  await expect(f.executor().run(signal())).rejects.toThrow("TESTING_EXECUTION_CONFIGURATION_CHANGED");
  expect(f.calls()).toBe(calls); expect(f.checks).toHaveLength(checks);
});

it.each([false, true])("finalizes durably across cleanup and acknowledgement loss: %s", async (interrupt) => {
  const f = await fixture(); const executor = f.executor();
  const publish = f.store.publish.bind(f.store);
  let failed = false;
  const spy = vi.spyOn(f.store, "publish").mockImplementation(async (...args) => {
    const result = await publish(...args);
    if (interrupt && !failed && args[0] === "testing-workspace" && (args[1] as { state?: string }).state === "closed") {
      failed = true; throw new Error("CLOSE_ACK_LOST");
    }
    return result;
  });
  if (interrupt) await expect(executor.finalize(signal())).rejects.toThrow("CLOSE_ACK_LOST");
  else await executor.finalize(signal());
  spy.mockRestore();
  const calls = f.calls(); const checks = f.checks.length;
  const result = await f.executor().finalize(signal());
  expect(await f.executor().finalize(signal())).toEqual(result);
  expect(f.calls()).toBe(calls); expect(f.checks).toHaveLength(checks);
  expect(JSON.parse((await f.store.readArtifact(result.artifactId)).content)).toEqual(result.changes);
  f.options.maximumAttempts = 2;
  await expect(f.executor().finalize(signal())).rejects.toThrow("TESTING_EXECUTION_CONFIGURATION_CHANGED");
});

it.each(["gate", "fingerprint", "scope", "command"])("rejects %s before any worktree or model dispatch", async (scenario) => {
  const f = await fixture();
  if (scenario === "gate") await f.savePlan(false);
  if (scenario === "fingerprint") { f.plan.title = "Changed"; await f.store.publish("plan-ir", f.plan, "testing"); }
  if (scenario === "scope") {
    const partition = f.options.authorization.partitions[0]; if (partition === undefined) throw new Error("PARTITION_ABSENT");
    partition.paths = ["tests/001.ts"];
  }
  if (scenario === "command") {
    const command = f.plan.tasks[1]?.verification.commands[0]; if (command === undefined) throw new Error("COMMAND_ABSENT");
    command.command = "unauthorized"; await f.savePlan();
  }
  await expect(f.executor().run(signal())).rejects.toThrow(scenario === "scope" ? "WRITE_SCOPE_REQUIRES_APPROVAL" : scenario === "command" ? "TESTING_COMMAND_NOT_AUTHORIZED" : "TESTING_PASSED_PLAN_REQUIRED");
  expect(f.calls()).toBe(0); expect(f.checks).toEqual([]);
  expect((await f.store.listArtifacts()).some(({ kind }) => kind === "testing-workspace")).toBe(false);
});
