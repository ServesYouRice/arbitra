import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { canonicalJson } from "@arbitra/core/config/config-store.js";
import { runConfigSchema } from "@arbitra/schemas/config.js";
import { testingVerificationPolicySchema } from "@arbitra/schemas/testing-verification.js";
import type { HttpRequest } from "@arbitra/providers/transport-contract.js";
import { featureFixture } from "./feature-fixture.js";
import { ModelActivities } from "../src/model-activities.js";
import { snapshotRepository } from "../src/repository.js";
import { RunStore } from "../src/run-store.js";
import { TestingPlanExecutor } from "../src/testing-plan-executor.js";
import { testingRepairClosure } from "../src/testing-repair.js";
import { TestingTaskAttempts } from "../src/testing-task-attempts.js";
import { TestingWorktree, type TestingWorktreeHandle } from "../src/testing-worktree.js";
import { DockerTestSandbox, type TestSandbox } from "../src/test-sandbox.js";

// Scripted provider ports throughout. The sandbox is injected by default; with
// ARBITRA_DOCKER_ACCEPTANCE=1 and ARBITRA_DOCKER_IMAGE=<name@sha256:...> every case runs its
// checks in real containers instead (completion plan P07/P04). The real check is a script in
// the snapshot that applies the same pass/fail rule to the mounted files and exits with it.
const realImage = process.env["ARBITRA_DOCKER_ACCEPTANCE"] === "1" ? process.env["ARBITRA_DOCKER_IMAGE"] : undefined;
const verifier = `import { existsSync, readFileSync } from "node:fs";
const [number, layout] = process.argv.slice(2);
const read = (path) => existsSync(path) ? readFileSync(path, "utf8") : "";
const failed = number === "001" && (layout === "shared" ? read("tests/fixture.ts").includes("broken") : existsSync("tests/002.ts") && !read("tests/001.ts").includes("repaired"));
console.log(failed ? "assertion failed" : "ok");
process.exit(failed ? 1 : 0);
`;

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
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const hash = (value: unknown) => digest(canonicalJson(value));

type Scenario = "repair" | "shared" | "oscillation" | "rounds" | "unrecoverable" | "budget" | "interrupted" | "cancelled" | "reopen-interrupted" | "tool-loop";
interface Write { path: string; content: string }

/** TASK-001 -> TASK-002. A later TASK-002 write breaks TASK-001's check, which only
 * a repaired TASK-001 (or repaired shared fixture) makes pass again. */
async function fixture(scenario: Scenario) {
  const root = await mkdtemp(join(tmpdir(), "testing-repair-"));
  const store = new RunStore(join(root, ".runs"), "run"); fixtures.push({ root, store });
  const f = await featureFixture(root);
  const shared = scenario === "shared" || scenario === "oscillation";
  if (shared) { await mkdir(join(root, "tests"), { recursive: true }); await writeFile(join(root, "tests/fixture.ts"), "export const fixture = 'base';\n"); }
  if (realImage !== undefined) { await mkdir(join(root, "checks"), { recursive: true }); await writeFile(join(root, "checks/verify.mjs"), verifier); }
  const config = runConfigSchema.parse({ ...f.config, mode: "testing", models: { ...f.config.models, planner: { ...f.config.models["planner"], capabilityTier: "frontier" } },
    workflow: { modelExecution: f.config.workflow["modelExecution"], testing: { mode: "plan", goal: "Test sessions", roles: { analyst: "planner", planner: "planner" } } } });
  const snapshot = await snapshotRepository(root);
  const plan = f.plan; plan.mode = "testing";
  const first = plan.tasks[0]; if (first === undefined) throw new Error("TASK_ABSENT");
  const scope = (number: string) => shared ? [`tests/${number}.ts`, "tests/fixture.ts"] : [`tests/${number}.ts`];
  plan.tasks = ["001", "002"].map((number) => ({ ...structuredClone(first), id: `TASK-${number}`, scope: { likelyFiles: scope(number), components: [], interfaces: [] },
    dependencies: { dependsOn: number === "002" ? ["TASK-001"] : [], blocks: number === "001" ? ["TASK-002"] : [], conflictsWith: [] },
    verification: { ...first.verification, commands: [{ command: `check ${number}`, executionPolicy: "allowlisted" as const, expectedExitCode: 0 }] } }));
  plan.taskGraph = [{ from: "TASK-001", to: "TASK-002" }];
  plan.routingRecommendations = plan.tasks.map(({ id, routing }) => ({ taskId: id, capability: routing.capability, effort: routing.effort, reason: routing.reason }));
  const link = plan.traceability.requirementLinks.links[0]; if (link === undefined) throw new Error("LINK_ABSENT");
  link.taskIds = plan.tasks.map(({ id }) => id);
  await store.publish("plan-ir", plan, "testing");
  await store.publish("testing-outcome", { passed: true, reasons: [], testsExecuted: false, selectedGaps: 1, planFingerprint: hash(plan) }, "testing");
  const policy = testingVerificationPolicySchema.parse({ execution: { driver: "docker", image: realImage ?? `local/node@sha256:${"a".repeat(64)}`, maximumRuns: scenario === "budget" ? 5 : 12,
    checks: ["001", "002"].map((number) => ({ id: number, executable: realImage === undefined ? "/usr/bin/node" : "/usr/local/bin/node", arguments: realImage === undefined ? ["--test", `tests/${number}.ts`] : ["checks/verify.mjs", number, shared ? "shared" : "separate"], sourcePaths: scope(number) })) },
    bindings: ["001", "002"].map((number) => ({ command: `check ${number}`, checkId: number, authorization: "allowlisted", expectedExitCode: 0 })) });
  const options = { authorization: { maximumParallelTasks: 2, partitions: [{ id: "tests", paths: ["tests/001.ts", "tests/002.ts", ...(shared ? ["tests/fixture.ts"] : [])] }],
    tasks: plan.tasks.map(({ id }) => ({ taskId: id, partitionId: "tests", exclusive: false })) },
    verification: policy, models: { fast: "planner", balanced: "planner", frontier: "planner" }, maximumAttempts: 2,
    ...(scenario === "rounds" ? { maximumRepairRounds: 0 } : {}) };

  // Writer script: (task, attempt ordinal) -> writes for the attempt's first turn.
  const script = (number: string, ordinal: number): Write[] => {
    if (number === "001") {
      if (ordinal === 1) return [{ path: "tests/001.ts", content: "test('001', () => {});\n" }];
      if (shared) return [{ path: "tests/fixture.ts", content: "export const fixture = 'fixed';\n" }];
      // Every repair also probes authority: TASK-001 may never write TASK-002's file.
      return [{ path: "tests/002.ts", content: "hijacked\n" }, { path: "tests/001.ts", content: scenario === "unrecoverable" ? "test('001 still', () => {});\n" : "test('001 repaired', () => {});\n" }];
    }
    if (ordinal === 1) return [{ path: "tests/002.ts", content: "test('002', () => {});\n" }, ...(shared ? [{ path: "tests/fixture.ts", content: "export const fixture = 'broken';\n" }] : [])];
    return scenario === "oscillation" ? [{ path: "tests/fixture.ts", content: "export const fixture = 'broken';\n" }] : [];
  };
  let calls = 0; const checks: { id: string; files: Map<string, string> }[] = [];
  const failures = { interrupt: scenario === "interrupted", cancel: scenario === "cancelled" };
  const controller = { current: new AbortController() };
  const provider = { credential: () => "fixture-key", client: { async send(request: HttpRequest) {
    calls += 1;
    const body = request.body as { input: { role: string; content: string; type?: string }[] };
    const user = body.input.find(({ role }) => role === "user")?.content ?? "";
    const layers = user.split("\n").map((line) => JSON.parse(line) as { value: { artifacts?: string[] } });
    const framed = layers.flatMap(({ value }) => value.artifacts ?? [])[0] ?? "";
    const content = /-->\n([\s\S]*)\n<\/repository_content>$/u.exec(framed)?.[1] ?? "{}";
    const payload = JSON.parse(content.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")) as
      { task: { id: string }; attempt: { ordinal: number }; repository: { path: string; content: string }[] };
    const number = payload.task.id === "TASK-002" ? "002" : "001";
    // Derive the turn from the conversation itself, so a cancelled call is simply retried.
    const turn = body.input.some(({ type }) => type === "function_call_output") ? 1 : 0;
    if (number === "001" && payload.attempt.ordinal === 2) {
      // Interrupt after the repair's tool work was durably recorded.
      if (failures.interrupt && turn === 1) { failures.interrupt = false; throw new Error("REPAIR_WRITER_INTERRUPTED"); }
      if (failures.cancel && turn === 0) { failures.cancel = false; controller.current.abort(); }
    }
    // A writer that never stops calling tools: it rewrites its file on every turn.
    if (scenario === "tool-loop" && number === "001" && payload.attempt.ordinal === 1) {
      const current = new Map(payload.repository.map(({ path, content: text }) => [path, text]));
      const written = body.input.filter(({ type }) => type === "function_call_output").length > 0;
      return { status: 200, headers: {}, body: { output: [{ type: "function_call", call_id: `loop-${String(body.input.length)}`, name: "testing_write_file",
        arguments: JSON.stringify({ path: "tests/001.ts", expectedHash: written ? digest("test('001', () => {});\n") : current.has("tests/001.ts") ? digest(current.get("tests/001.ts") ?? "") : null, content: "test('001', () => {});\n" }) }], usage: { input_tokens: 10, output_tokens: 10 } } };
    }
    const writes = turn === 0 ? script(number, payload.attempt.ordinal) : [];
    const current = new Map(payload.repository.map(({ path, content: text }) => [path, text]));
    return { status: 200, headers: {}, body: { ...(writes.length > 0 ? { output: writes.map(({ path, content: text }, index) => ({ type: "function_call", call_id: `write-${index}`, name: "testing_write_file",
      arguments: JSON.stringify({ path, expectedHash: current.has(path) ? digest(current.get(path) ?? "") : null, content: text }) })) } : { output_text: '{"summary":"Updated tests","limitations":[]}' }),
      usage: { input_tokens: 10, output_tokens: 10 } } };
  } } };
  const docker = new DockerTestSandbox();
  const sandbox: TestSandbox = realImage !== undefined ? { recover: (handle) => docker.recover(handle), async run(current, execution, check, runSignal, lifecycle) {
    checks.push({ id: check.id, files: new Map(current.files.map(({ path, lines }) => [path, lines.join("\n")])) });
    const result = await docker.run(current, execution, check, runSignal, lifecycle);
    if (result.status !== "exited" || !result.cleanupCompleted) throw new Error(`REAL_SANDBOX_${result.status.toUpperCase()}:${result.stderr}`);
    return result;
  } } : { async recover() {}, async run(current, execution, check) {
    const files = new Map(current.files.map(({ path, lines }) => [path, lines.join("\n")]));
    checks.push({ id: check.id, files });
    const failed = check.id === "001" && (shared ? (files.get("tests/fixture.ts") ?? "").includes("broken")
      : files.has("tests/002.ts") && !(files.get("tests/001.ts") ?? "").includes("repaired"));
    return { driver: "docker", image: execution.image, checkId: check.id, isolation: "read_only_snapshot_no_network", status: "exited", stopped: null, cleanupCompleted: true, exitCode: failed ? 1 : 0, stdout: failed ? "assertion failed" : "ok", stderr: "" };
  } };
  const executor = () => new TestingPlanExecutor(store, config, snapshot, new ModelActivities(store, config, provider), options, sandbox);
  const ledger = (taskId: string) => {
    const task = plan.tasks.find(({ id }) => id === taskId); if (task === undefined) throw new Error("TASK_ABSENT");
    return new TestingTaskAttempts(store, task, policy, options.maximumAttempts);
  };
  const workspaceWrites = async () => {
    const descriptor = (await store.listArtifacts()).find(({ kind }) => kind === "testing-workspace"); if (descriptor === undefined) throw new Error("WORKSPACE_ABSENT");
    return (await store.artifacts.get<{ writes: { operationId: string; taskId: string; path: string; state: string }[] }>(descriptor.ref)).writes;
  };
  return { root, store, executor, checks, controller, ledger, workspaceWrites, calls: () => calls };
}

async function expectSourceUnchanged(root: string) {
  expect(await readFile(join(root, "session.ts"), "utf8")).toBe("export const version = 1;\n");
}
async function expectNoDuplicateOrWidenedWrites(f: Awaited<ReturnType<typeof fixture>>) {
  const writes = await f.workspaceWrites();
  expect(new Set(writes.map(({ operationId }) => operationId)).size).toBe(writes.length);
  expect(writes.some(({ taskId, path }) => taskId === "TASK-001" && path === "tests/002.ts")).toBe(false);
  return writes;
}

it("repairs an earlier task invalidated by a later task and exports only the exact final verified bytes", async () => {
  const f = await fixture("repair"); const executor = f.executor();
  const result = await executor.run(signal());
  expect(result.passed).toBe(true); expect(result.reasons).toEqual([]);
  expect(result.repair).toEqual([{ round: 1, snapshotFingerprint: expect.any(String) as string, failedTaskIds: ["TASK-001"], reopenedTaskIds: ["TASK-001"], staleTaskIds: ["TASK-002"] }]);
  const invalidated = result.repair[0]?.snapshotFingerprint;
  if (invalidated === undefined) throw new Error("ROUND_ABSENT");
  expect(invalidated).not.toBe(result.snapshotFingerprint);
  // Task checks 001/002, failed final pass, repaired task check, fresh final pass.
  expect(f.checks.map(({ id }) => id)).toEqual(["001", "002", "001", "002", "001", "001", "002"]);
  expect(f.calls()).toBe(6);
  const status = await f.ledger("TASK-001").status();
  expect(status.state).toBe("completed");
  expect(status.attempts.map(({ result: value, repairVerificationArtifactId }) => ({ value, repair: repairVerificationArtifactId !== undefined }))).toEqual([{ value: "passed", repair: false }, { value: "passed", repair: true }]);
  // The rejected out-of-scope probe left no write; the lease was never widened.
  const writes = await expectNoDuplicateOrWidenedWrites(f);
  expect(writes.filter(({ taskId }) => taskId === "TASK-001").map(({ path }) => path)).toEqual(["tests/001.ts", "tests/001.ts"]);
  const probe = (await f.store.listArtifacts()).filter(({ kind }) => kind.startsWith("testing-tool-call-"));
  const rejected = await Promise.all(probe.map(async ({ ref }) => f.store.artifacts.get<{ result: { error?: { code: string } } }>(ref)));
  expect(rejected.some(({ result: value }) => value.error?.code === "WRITE_OUTSIDE_LEASE")).toBe(true);
  // Stale completion: the superseded final failure cannot reopen or complete the repaired task.
  const stale = [];
  for (const { kind, ref, artifactId } of await f.store.listArtifacts()) {
    if (!kind.startsWith("testing-task-verification-")) continue;
    const value = await f.store.artifacts.get<{ taskId: string; attemptId: string; snapshotFingerprint: string; status: string }>(ref);
    if (value.taskId === "TASK-001" && value.attemptId.startsWith("final/") && value.snapshotFingerprint === invalidated) stale.push({ artifactId, status: value.status });
  }
  expect(stale).toEqual([{ artifactId: expect.any(String) as string, status: "failed" }]);
  await expect(f.ledger("TASK-001").invalidateFinal(stale[0]?.artifactId ?? "", invalidated ?? "")).rejects.toThrow("TESTING_FINAL_INVALIDATION_STALE");
  expect(result.finalVerification.map(({ artifactId }) => artifactId)).not.toContain(stale[0]?.artifactId);
  const calls = f.calls(); const checks = f.checks.length;
  expect(await f.executor().run(signal())).toEqual(result);
  const handoff = await f.executor().finalize(signal());
  expect(handoff.changes.snapshotFingerprint).toBe(result.snapshotFingerprint);
  expect(handoff.changes.verificationArtifactIds).toEqual(result.finalVerification.map(({ artifactId }) => artifactId));
  expect(result.finalVerification.every(({ status: value, snapshotFingerprint }) => value === "passed" && snapshotFingerprint === result.snapshotFingerprint)).toBe(true);
  expect(handoff.changes.files.map(({ path, content, expectedHash }) => ({ path, content, expectedHash }))).toEqual([
    { path: "tests/001.ts", content: "test('001 repaired', () => {});\n", expectedHash: null },
    { path: "tests/002.ts", content: "test('002', () => {});\n", expectedHash: null },
  ]);
  for (const file of handoff.changes.files) expect(digest(file.content)).toBe(file.contentHash);
  expect(f.calls()).toBe(calls); expect(f.checks).toHaveLength(checks);
  await expectSourceUnchanged(f.root);
});

it("reopens every writer of a shared fixture in the dependency/conflict closure", async () => {
  const f = await fixture("shared");
  const result = await f.executor().run(signal());
  expect(result.passed).toBe(true);
  expect(result.repair.map(({ failedTaskIds, reopenedTaskIds, staleTaskIds }) => ({ failedTaskIds, reopenedTaskIds, staleTaskIds })))
    .toEqual([{ failedTaskIds: ["TASK-001"], reopenedTaskIds: ["TASK-001", "TASK-002"], staleTaskIds: [] }]);
  // The related writer received the failing task's final evidence as repair feedback.
  const second = await f.ledger("TASK-002").status();
  expect(second.attempts).toHaveLength(2);
  expect(second.attempts[1]?.repairVerificationArtifactId).toBe((await f.ledger("TASK-001").status()).attempts[1]?.repairVerificationArtifactId);
  const handoff = await f.executor().finalize(signal());
  expect(handoff.changes.files.map(({ path, content }) => ({ path, content }))).toEqual([
    { path: "tests/001.ts", content: "test('001', () => {});\n" },
    { path: "tests/002.ts", content: "test('002', () => {});\n" },
    { path: "tests/fixture.ts", content: "export const fixture = 'fixed';\n" },
  ]);
  expect(handoff.changes.files.find(({ path }) => path === "tests/fixture.ts")?.expectedHash).toBe(digest("export const fixture = 'base';\n"));
  await expectNoDuplicateOrWidenedWrites(f);
  await expectSourceUnchanged(f.root);
});

it.each(["oscillation", "rounds", "unrecoverable", "budget"] as const)("blocks without a handoff when repair cannot restore the workspace: %s", async (scenario) => {
  const f = await fixture(scenario);
  const result = await f.executor().run(signal());
  expect(result.passed).toBe(false);
  const expected = {
    oscillation: ["final_verification_failed:TASK-001", "repair_oscillation"],
    rounds: ["final_verification_failed:TASK-001", "repair_rounds_exhausted"],
    unrecoverable: ["task_attempts_exhausted:TASK-001"],
    budget: ["final_verification_incomplete:TASK-001", "final_verification_incomplete:TASK-002"],
  }[scenario];
  expect(result.reasons).toEqual(expected);
  expect(result.repair).toHaveLength(scenario === "rounds" ? 0 : 1);
  // Model calls: initial two tasks (4); repairs add two per reopened attempt.
  expect(f.calls()).toBe({ oscillation: 8, rounds: 4, unrecoverable: 6, budget: 6 }[scenario]);
  // The sandbox run budget is shared across initial, repair and final checks.
  if (scenario === "budget") expect(f.checks).toHaveLength(5);
  if (scenario === "oscillation") expect(result.snapshotFingerprint).toBe(result.repair[0]?.snapshotFingerprint);
  const calls = f.calls(); const checks = f.checks.length;
  expect(await f.executor().run(signal())).toEqual(result);
  await expect(f.executor().handoff(signal())).rejects.toThrow("TESTING_VERIFIED_CHANGE_SET_REQUIRED");
  expect(f.calls()).toBe(calls); expect(f.checks).toHaveLength(checks);
  expect((await f.store.listArtifacts()).some(({ kind }) => kind.startsWith("testing-change-set-") || kind === "testing-execution-completion")).toBe(false);
  await expectNoDuplicateOrWidenedWrites(f);
  await expectSourceUnchanged(f.root);
});

it.each(["interrupted", "cancelled", "reopen-interrupted"] as const)("resumes a %s repair from durable lineage without duplicate work", async (scenario) => {
  const f = await fixture(scenario);
  const publish = f.store.publish.bind(f.store);
  const spy = scenario !== "reopen-interrupted" ? undefined : vi.spyOn(f.store, "publish").mockImplementation(async (...args) => {
    const value = await publish(...args);
    const rounds = (args[1] as { rounds?: { state: string }[] }).rounds;
    if (args[0] === "testing-repair-lineage" && rounds?.at(-1)?.state === "reopening") throw new Error("CRASH_AFTER_REOPEN_INTENT");
    return value;
  });
  const first = f.executor().run(f.controller.current.signal);
  await expect(first).rejects.toThrow({ interrupted: "Provider openai failed", cancelled: "CANCELLED", "reopen-interrupted": "CRASH_AFTER_REOPEN_INTENT" }[scenario]);
  spy?.mockRestore();
  if (scenario === "reopen-interrupted") expect((await f.ledger("TASK-001").status()).state).toBe("completed");
  const result = await f.executor().run(signal());
  expect(result.reasons).toEqual([]);
  expect(result.repair).toHaveLength(1);
  const attempts = (await f.ledger("TASK-001").status()).attempts;
  expect(attempts).toHaveLength(2);
  const writes = await expectNoDuplicateOrWidenedWrites(f);
  expect(writes.filter(({ taskId, state }) => taskId === "TASK-001" && state === "completed")).toHaveLength(2);
  const handoff = await f.executor().finalize(signal());
  expect(handoff.changes.files.find(({ path }) => path === "tests/001.ts")?.content).toBe("test('001 repaired', () => {});\n");
  expect(handoff.changes.snapshotFingerprint).toBe(result.snapshotFingerprint);
  await expectSourceUnchanged(f.root);
});

it("derives the dependency/conflict closure without widening any task's authority", () => {
  const task = (id: string, files: string[], conflictsWith: string[] = []) => ({ id, scope: { likelyFiles: files }, dependencies: { conflictsWith }, verification: { commands: [{ command: `check ${id}` }] } });
  const plan = { tasks: [task("A", ["tests/a.ts"]), task("B", ["tests/b.ts"]), task("C", ["tests/c.ts"], ["A"]), task("D", ["tests/d.ts"]), task("E", ["tests/e.ts"])],
    taskGraph: [{ from: "A", to: "B" }, { from: "B", to: "D" }] } as unknown as Parameters<typeof testingRepairClosure>[0];
  const policy = testingVerificationPolicySchema.parse({ execution: { driver: "docker", image: `local/node@sha256:${"a".repeat(64)}`, maximumRuns: 4,
    checks: ["A", "B", "C", "D", "E"].map((id) => ({ id, executable: "/usr/bin/node", arguments: [], sourcePaths: id === "A" ? ["tests/a.ts", "tests/shared.ts"] : [`tests/${id.toLowerCase()}.ts`] })) },
    bindings: ["A", "B", "C", "D", "E"].map((id) => ({ command: `check ${id}`, checkId: id, authorization: "allowlisted", expectedExitCode: 0 })) });
  // E wrote a file A's check reads; C declared a conflict; B and D are transitive dependents.
  const written = new Map([["A", ["tests/a.ts"]], ["B", ["tests/b.ts"]], ["C", ["tests/c.ts"]], ["D", ["tests/d.ts"]], ["E", ["tests/e.ts", "tests/shared.ts"]]]);
  expect(testingRepairClosure(plan, policy, [{ taskId: "A", artifactId: "fail-a" }], written)).toEqual({
    reopened: [{ taskId: "A", causeTaskId: "A", verificationArtifactId: "fail-a" }, { taskId: "C", causeTaskId: "A", verificationArtifactId: "fail-a" }, { taskId: "E", causeTaskId: "A", verificationArtifactId: "fail-a" }],
    staleTaskIds: ["B", "D"],
  });
});

it("ends a writer attempt at the tool-turn limit as an incomplete attempt instead of failing the run", async () => {
  const f = await fixture("tool-loop");
  const result = await f.executor().run(signal());
  const first = (await f.ledger("TASK-001").status()).attempts[0];
  // The limited attempt is judged incomplete; the next attempt completes the plan.
  expect(first).toMatchObject({ ordinal: 1, result: "incomplete", state: "verified" });
  expect(result).toMatchObject({ passed: true, reasons: [] });
  await expectNoDuplicateOrWidenedWrites(f);
  await expectSourceUnchanged(f.root);
});

