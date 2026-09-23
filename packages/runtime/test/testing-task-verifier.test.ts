import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WritePartitions } from "@arbitra/security/write-partitions";
import { planIRSchema } from "@arbitra/schemas/plan.js";
import { testingExecutionSchema } from "@arbitra/schemas/testing.js";
import { testingVerificationPolicySchema, testingTaskVerificationSchema } from "@arbitra/schemas/testing-verification.js";
import { snapshotRepository } from "../src/repository.js";
import { RunStore } from "../src/run-store.js";
import { TestingWorkspace } from "../src/testing-workspace.js";
import { TestingWorktree, type TestingWorktreeHandle } from "../src/testing-worktree.js";
import { TestingTaskVerifier } from "../src/testing-task-verifier.js";
import { TestingTaskAttempts } from "../src/testing-task-attempts.js";
import type { TestSandbox, SandboxTestResult } from "../src/test-sandbox.js";

const roots: string[] = []; const handles: TestingWorktreeHandle[] = [];
afterEach(async () => { await Promise.all(handles.splice(0).map((handle) => TestingWorktree.recover(handle))); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const signal = () => new AbortController().signal;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "testing-task-verifier-")); roots.push(root);
  await writeFile(join(root, "source.ts"), "source\n");
  await writeFile(join(root, "package.json"), '{"scripts":{"test":"node --test"}}');
  const snapshot = await snapshotRepository(root, 10, { includeTestMetadata: true });
  const store = new RunStore(join(root, ".runs"), "run");
  const partitions = new WritePartitions([{ id: "tests", paths: ["new.test.ts", "other.test.ts", "package.json"] }]);
  const workspace = new TestingWorkspace(store, partitions); handles.push(await workspace.prepare(snapshot, signal()));
  const plan = planIRSchema.parse(JSON.parse(await readFile(new URL("../../schemas/test/golden/plan-ir.valid.json", import.meta.url), "utf8")));
  const task = plan.tasks[0]; if (task === undefined) throw new Error("TASK_ABSENT");
  task.scope.likelyFiles = ["new.test.ts"]; task.verification.commands = [{ command: "npm run test", executionPolicy: "derived_repository_script", expectedExitCode: 0 }];
  const settings = testingExecutionSchema.parse({ mode: "plan", goal: "Add tests", roles: { analyst: "model", planner: "model" } });
  const policy = testingVerificationPolicySchema.parse({ execution: { driver: "docker", image: `local/node@sha256:${"a".repeat(64)}`, maximumRuns: 4, checks: [{ id: "tests", executable: "/usr/bin/npm", arguments: ["run", "test"], sourcePaths: ["new.test.ts"] }] }, bindings: [{ command: "npm run test", checkId: "tests", authorization: "repository_script", expectedExitCode: 0 }] });
  const write = async (taskId = task.id, path = "new.test.ts", content = "test('new', () => {});\n", expectedHash: string | null = null) => {
    const lease = partitions.acquire({ taskId, partitionId: "tests", paths: [path] });
    try { return await workspace.write(`${taskId}/${content}`, lease, { path, content, expectedHash }); } finally { partitions.release(lease); }
  };
  const result: SandboxTestResult = { driver: "docker", image: policy.execution.image, checkId: "tests", isolation: "read_only_snapshot_no_network", status: "exited", stopped: null, cleanupCompleted: true, exitCode: 0, stdout: "ok", stderr: "" };
  return { root, snapshot, store, partitions, workspace, task, settings, policy, write, result };
}

it("verifies newly written bytes, reuses the same attempt and executes fresh attempts after restart", async () => {
  const f = await fixture(); await f.write(); let calls = 0;
  const sandbox: TestSandbox = { async recover() {}, async run(snapshot, execution, check) {
    calls += 1; expect(snapshot.files.find(({ path }) => path === "new.test.ts")?.lines[0]).toBe("test('new', () => {});");
    expect(execution.checks).toHaveLength(1); expect(check.arguments).toEqual(["run", "test"]); return f.result;
  } };
  const verifier = () => new TestingTaskVerifier(f.store, f.snapshot, f.settings, f.policy, sandbox);
  const first = await verifier().verify(f.task, "one", f.workspace, signal());
  expect(first).toMatchObject({ status: "passed", deterministicFailure: false, reasons: [], checks: [{ status: "passed", expectedExitCode: 0, actualExitCode: 0 }] });
  expect(await verifier().verify(f.task, "one", f.workspace, signal())).toEqual(first); expect(calls).toBe(1);
  const second = await verifier().verify(f.task, "two", f.workspace, signal());
  expect(second.status).toBe("passed"); expect(second.checks[0]?.executionId).not.toBe(first.checks[0]?.executionId); expect(calls).toBe(2);
});

it.each(["failure", "timeout", "unavailable", "cleanup", "budget"])("classifies %s without promoting infrastructure failures", async (scenario) => {
  const f = await fixture(); await f.write(); let calls = 0;
  const sandbox: TestSandbox = { async recover() {}, async run() { calls += 1; return { ...f.result, exitCode: 1,
    ...(scenario === "timeout" ? { stopped: "timeout" as const, status: "interrupted" as const } : {}),
    ...(scenario === "unavailable" ? { status: "unavailable" as const } : {}), ...(scenario === "cleanup" ? { cleanupCompleted: false } : {}) }; } };
  const policy = { ...f.policy, execution: { ...f.policy.execution, maximumRuns: scenario === "budget" ? 0 : 4 } };
  const result = await new TestingTaskVerifier(f.store, f.snapshot, f.settings, policy, sandbox).verify(f.task, "one", f.workspace, signal());
  expect(result.status).toBe(scenario === "failure" ? "failed" : "incomplete"); expect(result.deterministicFailure).toBe(scenario === "failure");
  expect(calls).toBe(scenario === "budget" ? 0 : 1);
});

it.each(["unbound", "expected-exit", "approval", "uncovered", "manifest"])("rejects %s authorization changes before sandbox dispatch", async (scenario) => {
  const f = await fixture(); await f.write(); let calls = 0;
  if (scenario === "unbound") f.task.verification.commands[0] = { command: "invented command", executionPolicy: "derived_repository_script", expectedExitCode: 0 };
  if (scenario === "expected-exit") f.task.verification.commands[0] = { command: "npm run test", executionPolicy: "derived_repository_script", expectedExitCode: 1 };
  if (scenario === "approval") f.task.verification.commands[0] = { command: "npm run test", executionPolicy: "requires_approval", expectedExitCode: 0 };
  if (scenario === "uncovered") f.policy.execution.checks[0] = { id: "tests", executable: "/usr/bin/npm", arguments: ["run", "test"], sourcePaths: ["source.ts"] };
  if (scenario === "manifest") {
    const manifest = (await f.workspace.snapshot()).files.find(({ path }) => path === "package.json"); if (manifest === undefined) throw new Error("MANIFEST_ABSENT");
    await f.write("setup", "package.json", '{"scripts":{"test":"echo fake success"}}', createHash("sha256").update(manifest.lines.join("\n")).digest("hex"));
  }
  const sandbox: TestSandbox = { async recover() {}, async run() { calls += 1; return f.result; } };
  const expected = { unbound: "TESTING_COMMAND_NOT_AUTHORIZED", "expected-exit": "TESTING_EXPECTED_EXIT_CODE_CHANGED", approval: "TESTING_COMMAND_APPROVAL_REQUIRED", uncovered: "TESTING_WRITE_WITHOUT_VERIFICATION_CHECK", manifest: "TESTING_COMMAND_SOURCE_CHANGED" }[scenario];
  await expect(new TestingTaskVerifier(f.store, f.snapshot, f.settings, f.policy, sandbox).verify(f.task, "one", f.workspace, signal())).rejects.toThrow(expected);
  expect(calls).toBe(0);
});

it("invalidates results if another recorded writer changes the workspace during verification", async () => {
  const f = await fixture(); await f.write();
  const sandbox: TestSandbox = { async recover() {}, async run() { await f.write("other", "other.test.ts"); return f.result; } };
  const result = await new TestingTaskVerifier(f.store, f.snapshot, f.settings, f.policy, sandbox).verify(f.task, "one", f.workspace, signal());
  expect(result).toMatchObject({ status: "incomplete", deterministicFailure: false, reasons: ["workspace_changed_during_verification"] });
});

it("retains writer limitations even when every trusted check passes", async () => {
  const f = await fixture(); await f.write(); let calls = 0;
  const verifier = new TestingTaskVerifier(f.store, f.snapshot, f.settings, f.policy, { async recover() {}, async run() { calls += 1; return f.result; } });
  const result = await verifier.verify(f.task, "limited", f.workspace, signal(), ["Missing edge case"]);
  expect(result).toMatchObject({ status: "incomplete", deterministicFailure: false, reasons: ["writer_limitation:Missing edge case"], checks: [{ status: "passed" }] });
  expect(calls).toBe(1);
});

it("recovers interrupted sandbox resources before dispatching a new attempt", async () => {
  const f = await fixture(); await f.write(); let calls = 0; let recovered = false;
  const sandbox: TestSandbox = { async recover(handle) { expect(handle.container).toBe("pending"); recovered = true; }, async run(_snapshot, _policy, _check, _signal, lifecycle) {
    calls += 1; if (calls === 1) { await lifecycle?.prepared({ container: "pending", directory: "pending" }); throw new Error("INTERRUPTED"); }
    expect(recovered).toBe(true); return f.result;
  } };
  const verifier = () => new TestingTaskVerifier(f.store, f.snapshot, f.settings, f.policy, sandbox);
  await expect(verifier().verify(f.task, "one", f.workspace, signal())).rejects.toThrow("INTERRUPTED");
  expect(await verifier().verify(f.task, "one", f.workspace, signal())).toMatchObject({ status: "incomplete", deterministicFailure: false });
  expect(await verifier().verify(f.task, "two", f.workspace, signal())).toMatchObject({ status: "passed" }); expect(calls).toBe(2);
});

it("reserves durable attempts and promotes directly to frontier after two deterministic failures", async () => {
  const f = await fixture(); f.task.routing.capability = "fast"; await f.write(); let calls = 0;
  const sandbox: TestSandbox = { async recover() {}, async run() { calls += 1; return { ...f.result, exitCode: calls < 3 ? 1 : 0 }; } };
  const ledger = () => new TestingTaskAttempts(f.store, f.task, f.policy);
  const verifier = new TestingTaskVerifier(f.store, f.snapshot, f.settings, f.policy, sandbox);
  for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
    const attempt = await ledger().reserve(); if (attempt === null) throw new Error("ATTEMPT_ABSENT");
    expect(attempt).toMatchObject({ ordinal, capability: ordinal === 3 ? "frontier" : "fast" });
    expect(await ledger().reserve()).toEqual(attempt);
    const verification = await verifier.verify(f.task, attempt.id, f.workspace, signal());
    const result = await ledger().recordVerification(attempt.id, verification.artifactId);
    expect(await ledger().recordVerification(attempt.id, verification.artifactId)).toEqual(result);
  }
  expect(await ledger().status()).toMatchObject({ state: "completed", deterministicFailures: 2 });
  expect(await ledger().reserve()).toBeNull(); expect(calls).toBe(3);
});

it("bounds infrastructure retries without promotion or resetting limits after restart", async () => {
  const f = await fixture(); f.task.routing.capability = "balanced"; await f.write();
  const sandbox: TestSandbox = { async recover() {}, async run() { return { ...f.result, status: "unavailable", exitCode: null }; } };
  const ledger = () => new TestingTaskAttempts(f.store, f.task, f.policy, 3);
  const verifier = new TestingTaskVerifier(f.store, f.snapshot, f.settings, f.policy, sandbox);
  for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
    const attempt = await ledger().reserve(); if (attempt === null) throw new Error("ATTEMPT_ABSENT");
    expect(attempt.capability).toBe("balanced");
    const result = await verifier.verify(f.task, attempt.id, f.workspace, signal());
    await ledger().recordVerification(attempt.id, result.artifactId);
  }
  expect(await ledger().reserve()).toBeNull();
  expect(await ledger().status()).toMatchObject({ state: "blocked", deterministicFailures: 0 });
  await expect(new TestingTaskAttempts(f.store, f.task, f.policy, 4).reserve()).rejects.toThrow("TESTING_TASK_EXECUTION_CONFIGURATION_CHANGED");
});

it("records a no-write attempt as incomplete without dispatching commands", async () => {
  const f = await fixture(); let calls = 0;
  const sandbox: TestSandbox = { async recover() {}, async run() { calls += 1; return f.result; } };
  const ledger = new TestingTaskAttempts(f.store, f.task, f.policy);
  const attempt = await ledger.reserve(); if (attempt === null) throw new Error("ATTEMPT_ABSENT");
  const result = await new TestingTaskVerifier(f.store, f.snapshot, f.settings, f.policy, sandbox).verify(f.task, attempt.id, f.workspace, signal());
  expect(result).toMatchObject({ status: "incomplete", reasons: ["no_recorded_test_changes"] });
  await ledger.recordVerification(attempt.id, result.artifactId);
  expect(await ledger.status()).toMatchObject({ deterministicFailures: 0 }); expect(calls).toBe(0);
});

it("rejects stale verification artifacts and substituted execution provenance", async () => {
  const f = await fixture(); await f.write();
  const sandbox: TestSandbox = { async recover() {}, async run() { return { ...f.result, exitCode: 1 }; } };
  const ledger = new TestingTaskAttempts(f.store, f.task, f.policy);
  const attempt = await ledger.reserve(); if (attempt === null) throw new Error("ATTEMPT_ABSENT");
  const result = await new TestingTaskVerifier(f.store, f.snapshot, f.settings, f.policy, sandbox).verify(f.task, "unreserved", f.workspace, signal());
  await expect(ledger.recordVerification(attempt.id, result.artifactId)).rejects.toThrow("TESTING_ATTEMPT_VERIFICATION_STALE");
  const saved = testingTaskVerificationSchema.parse(JSON.parse((await f.store.readArtifact(result.artifactId)).content));
  const forged = await f.store.publish("testing-task-verification-forged", { ...saved, attemptId: attempt.id });
  await expect(ledger.recordVerification(attempt.id, forged.artifactId)).rejects.toThrow("TESTING_EXECUTION_PROVENANCE_MISMATCH");
  expect(await ledger.status()).toMatchObject({ state: "running", deterministicFailures: 0 });
});

it("retains an earlier incomplete observation when the same snapshot is verified again", async () => {
  const f = await fixture(); await f.write();
  const original = "test('new', () => {});\n";
  const changed = "changed while verifying\n";
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  let calls = 0;
  const sandbox: TestSandbox = { async recover() {}, async run() { calls += 1; await f.write("other", "new.test.ts", changed, hash(original)); return f.result; } };
  const verifier = new TestingTaskVerifier(f.store, f.snapshot, f.settings, f.policy, sandbox);
  const first = await verifier.verify(f.task, "one", f.workspace, signal());
  expect(first.status).toBe("incomplete");
  await f.write("restore", "new.test.ts", original, hash(changed));
  const second = await verifier.verify(f.task, "one", f.workspace, signal());
  expect(second.status).toBe("passed"); expect(second.artifactId).not.toBe(first.artifactId); expect(calls).toBe(1);
  expect(JSON.parse((await f.store.readArtifact(first.artifactId)).content)).toMatchObject({ status: "incomplete" });
});
