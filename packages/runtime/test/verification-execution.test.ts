import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verificationExecutionSchema } from "@arbitra/schemas/verification-execution.js";
import { RunStore } from "../src/run-store.js";
import { VerificationExecutor } from "../src/verification-execution.js";
import type { TestSandbox, SandboxTestResult } from "../src/test-sandbox.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const snapshot = { root: "unused", files: [{ path: "test.js", lines: ["test()"], byteLength: 6, lineStartBytes: [0] }] };
const policy = verificationExecutionSchema.parse({ driver: "docker", image: `local/node@sha256:${"a".repeat(64)}`, maximumRuns: 1, checks: ["one", "two"].map((id) => ({ id, sourcePaths: ["test.js"], executable: "/bin/node", arguments: ["test.js"] })) });
const result: SandboxTestResult = { driver: "docker", image: policy.image, checkId: "one", isolation: "read_only_snapshot_no_network", status: "exited", cleanupCompleted: true, exitCode: 0, stdout: "ok", stderr: "", stopped: null };
async function store() { const root = await mkdtemp(join(tmpdir(), "verification-executor-test-")); roots.push(root); return new RunStore(root, "test"); }

describe("durable verification execution", () => {
  it("blocks new dispatch while recovery fails and preserves the pending resource identity", async () => {
    const runStore = await store(); let calls = 0;
    const handle = { container: "saved-container", directory: "saved-directory" };
    const sandbox: TestSandbox = { async recover() { throw new Error("ENGINE_OFFLINE"); }, async run(_snapshot, _policy, _check, _signal, lifecycle) {
      calls += 1; await lifecycle?.prepared(handle); throw new Error("PROCESS_CRASH");
    } };
    await expect(new VerificationExecutor(runStore, sandbox).execute(snapshot, policy, ["test.js"], new AbortController().signal)).rejects.toThrow("PROCESS_CRASH");
    await expect(new VerificationExecutor(runStore, sandbox).execute(snapshot, { ...policy, maximumRuns: 2 }, ["test.js"], new AbortController().signal)).rejects.toThrow("ENGINE_OFFLINE");
    expect(calls).toBe(1);
    const descriptor = (await runStore.listArtifacts())[0];
    if (descriptor === undefined) throw new Error("RECORD_ABSENT");
    expect(await runStore.artifacts.get(descriptor.ref)).toMatchObject({ state: "prepared", handle });
  });

  it("does not reuse evidence for changed source bytes or refund consumed runs", async () => {
    const runStore = await store(); let calls = 0;
    const sandbox: TestSandbox = { async recover() {}, async run() { calls += 1; return result; } };
    const executor = new VerificationExecutor(runStore, sandbox);
    await executor.execute(snapshot, policy, ["test.js"], new AbortController().signal);
    const changed = { ...snapshot, files: snapshot.files.map((file) => ({ ...file, lines: ["different()"] })) };
    const output = await executor.execute(changed, policy, ["test.js"], new AbortController().signal);
    expect(output.records).toEqual([]); expect(output.deferredCheckIds).toEqual(["one", "two"]); expect(calls).toBe(1);
  });

  it("reserves before dispatch, reuses completed output after restart and preserves the global limit", async () => {
    const runStore = await store(); let calls = 0;
    const sandbox: TestSandbox = { async recover() { throw new Error("UNEXPECTED_RECOVERY"); }, async run() {
      calls += 1;
      expect((await runStore.listArtifacts()).filter(({ kind }) => kind.startsWith("verification-execution-"))).toHaveLength(1);
      return result;
    } };
    const first = await new VerificationExecutor(runStore, sandbox).execute(snapshot, policy, ["test.js"], new AbortController().signal);
    expect(first.records[0]?.result).toEqual(result); expect(first.deferredCheckIds).toEqual(["two"]);
    const second = await new VerificationExecutor(runStore, sandbox).execute(snapshot, policy, ["test.js"], new AbortController().signal);
    expect(second).toEqual(first); expect(calls).toBe(1);
  });

  it("recovers an interrupted dispatch before selecting checks and never refunds or retries it", async () => {
    const runStore = await store(); let recoveries = 0; let calls = 0;
    const handle = { container: "saved-container", directory: "saved-directory" };
    const sandbox: TestSandbox = { async recover(value) { expect(value).toEqual(handle); recoveries += 1; }, async run(_snapshot, _policy, _check, _signal, lifecycle) {
      calls += 1; await lifecycle?.prepared(handle); throw new Error("PROCESS_CRASH");
    } };
    await expect(new VerificationExecutor(runStore, sandbox).execute(snapshot, policy, ["test.js"], new AbortController().signal)).rejects.toThrow("PROCESS_CRASH");
    const resumed = new VerificationExecutor(runStore, sandbox);
    await resumed.execute(snapshot, policy, [], new AbortController().signal);
    const output = await resumed.execute(snapshot, policy, ["test.js"], new AbortController().signal);
    expect(output.records[0]?.state).toBe("interrupted"); expect(output.deferredCheckIds).toEqual(["two"]);
    expect(calls).toBe(1); expect(recoveries).toBe(1);
  });

  it("serializes concurrent requests and respects zero budget", async () => {
    const runStore = await store(); let calls = 0;
    const sandbox: TestSandbox = { async recover() {}, async run() { calls += 1; return result; } };
    const executor = new VerificationExecutor(runStore, sandbox);
    const zero = await executor.execute(snapshot, { ...policy, maximumRuns: 0 }, ["test.js"], new AbortController().signal);
    expect(zero.deferredCheckIds).toEqual(["one", "two"]); expect(calls).toBe(0);
    await Promise.all([1, 2].map(() => executor.execute(snapshot, policy, ["test.js"], new AbortController().signal)));
    expect(calls).toBe(1);
  });
});
