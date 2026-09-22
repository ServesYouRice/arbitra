import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WritePartitions } from "@arbitra/security/write-partitions";
import { snapshotRepository } from "../src/repository.js";
import { RunStore } from "../src/run-store.js";
import { TestingWorkspace } from "../src/testing-workspace.js";
import { TestingWorktree, type TestingWorktreeHandle } from "../src/testing-worktree.js";

const roots: string[] = []; const handles: TestingWorktreeHandle[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(handles.splice(0).map((handle) => TestingWorktree.recover(handle))); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const hash = (content: string) => createHash("sha256").update(content).digest("hex");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "testing-workspace-fixture-")); roots.push(root);
  await writeFile(join(root, "source.ts"), "source\n");
  await writeFile(join(root, "existing.test.ts"), "original test\n");
  const snapshot = await snapshotRepository(root);
  const store = new RunStore(join(root, ".runs"), "run");
  const create = () => {
    const partitions = new WritePartitions([{ id: "tests", paths: ["existing.test.ts", "new.test.ts"] }]);
    return { partitions, workspace: new TestingWorkspace(store, partitions) };
  };
  const current = create(); const handle = await current.workspace.prepare(snapshot, new AbortController().signal); handles.push(handle);
  return { ...current, root, snapshot, store, handle, create };
}

it("journals disjoint writes, preserves the source tree and reuses completed operations after restart", async () => {
  const f = await fixture();
  const a = f.partitions.acquire({ taskId: "a", partitionId: "tests", paths: ["existing.test.ts"] });
  const b = f.partitions.acquire({ taskId: "b", partitionId: "tests", paths: ["new.test.ts"] });
  const updates = [{ path: "existing.test.ts", expectedHash: hash("original test\n"), content: "revised test\n" }, { path: "new.test.ts", expectedHash: null, content: "new test\n" }] as const;
  const results = await Promise.all([f.workspace.write("a/1", a, updates[0]), f.workspace.write("b/1", b, updates[1])]);
  expect(results.map(({ reused }) => reused)).toEqual([false, false]);
  f.partitions.release(a); f.partitions.release(b);
  const restarted = f.create(); await restarted.workspace.prepare(f.snapshot, new AbortController().signal);
  const lease = restarted.partitions.acquire({ taskId: "a", partitionId: "tests", paths: ["existing.test.ts"] });
  expect(await restarted.workspace.write("a/1", lease, updates[0])).toMatchObject({ reused: true });
  await expect(restarted.workspace.write("a/1", lease, { ...updates[0], content: "different" })).rejects.toThrow("TESTING_WRITE_OPERATION_CHANGED");
  restarted.partitions.release(lease);
  expect((await restarted.workspace.snapshot()).files.map(({ path }) => path)).toEqual(["existing.test.ts", "new.test.ts", "source.ts"]);
  expect(await readFile(join(f.root, "existing.test.ts"), "utf8")).toBe("original test\n");
  await restarted.workspace.close(); await restarted.workspace.recoverClosed();
  await expect(f.create().workspace.prepare(f.snapshot, new AbortController().signal)).rejects.toThrow("TESTING_WORKSPACE_CLOSED");
});

it.each(["before-write", "after-write"])("recovers interruption %s without losing or duplicating the operation", async (point) => {
  const f = await fixture(); const lease = f.partitions.acquire({ taskId: "a", partitionId: "tests", paths: ["existing.test.ts"] });
  const update = { path: "existing.test.ts", expectedHash: hash("original test\n"), content: "revised test\n" };
  if (point === "before-write") vi.spyOn(TestingWorktree.prototype, "write").mockRejectedValueOnce(new Error("INTERRUPTED"));
  else {
    const publish = f.store.publish.bind(f.store);
    vi.spyOn(f.store, "publish").mockImplementation(async (kind, value, nodeId) => {
      if (kind === "testing-workspace" && (value as { writes?: { state: string }[] }).writes?.at(-1)?.state === "completed") throw new Error("INTERRUPTED");
      return publish(kind, value, nodeId);
    });
  }
  await expect(f.workspace.write("a/1", lease, update)).rejects.toThrow("INTERRUPTED");
  vi.restoreAllMocks(); f.partitions.release(lease);
  const restarted = f.create(); await restarted.workspace.prepare(f.snapshot, new AbortController().signal);
  const next = restarted.partitions.acquire({ taskId: "a", partitionId: "tests", paths: ["existing.test.ts"] });
  expect(await restarted.workspace.write("a/1", next, update)).toMatchObject({ reused: point === "after-write" });
  restarted.partitions.release(next);
  expect((await restarted.workspace.snapshot()).files.find(({ path }) => path === "existing.test.ts")?.lines[0]).toBe("revised test");
  await restarted.workspace.close();
});

it("rejects unrecorded changes anywhere in the worktree and changed source baselines", async () => {
  const f = await fixture();
  await writeFile(join(f.handle.directory, "worktree", "source.ts"), "unexpected change\n");
  await expect(f.create().workspace.prepare(f.snapshot, new AbortController().signal)).rejects.toThrow("TESTING_WORKSPACE_UNRECORDED_CHANGE");
  await expect(f.workspace.snapshot()).rejects.toThrow("TESTING_WORKSPACE_UNRECORDED_CHANGE");
  const changed = { ...f.snapshot, files: f.snapshot.files.map((file) => ({ ...file, lines: ["changed baseline"] })) };
  await expect(f.create().workspace.prepare(changed, new AbortController().signal)).rejects.toThrow("TESTING_WORKSPACE_BASELINE_CHANGED");
  expect(await readFile(join(f.root, "source.ts"), "utf8")).toBe("source\n");
});

it("finishes a committed close after interrupted cleanup", async () => {
  const f = await fixture();
  vi.spyOn(TestingWorktree, "recover").mockRejectedValueOnce(new Error("CLEANUP_INTERRUPTED"));
  await expect(f.workspace.close()).rejects.toThrow("CLEANUP_INTERRUPTED");
  vi.restoreAllMocks();
  await f.create().workspace.recoverClosed();
  await expect(readFile(join(f.handle.directory, "owner.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("requires idle writers for prepare and a ready journal for writes", async () => {
  const f = await fixture(); const lease = f.partitions.acquire({ taskId: "a", partitionId: "tests", paths: ["existing.test.ts"] });
  await expect(f.workspace.prepare(f.snapshot, new AbortController().signal)).rejects.toThrow("TESTING_WORKSPACE_PREPARE_REQUIRES_IDLE_WRITERS");
  await expect(f.workspace.close()).rejects.toThrow("TESTING_WORKSPACE_WRITERS_ACTIVE");
  await expect(new TestingWorkspace(f.store, f.partitions).write("a/1", lease, { path: "existing.test.ts", expectedHash: null, content: "new" })).rejects.toThrow("TESTING_WORKSPACE_NOT_PREPARED");
  f.partitions.release(lease);
});

it("requires recovery after a publisher reports failure following a committed intent", async () => {
  const f = await fixture(); const lease = f.partitions.acquire({ taskId: "a", partitionId: "tests", paths: ["existing.test.ts"] });
  const update = { path: "existing.test.ts", expectedHash: hash("original test\n"), content: "revised test\n" };
  const publish = f.store.publish.bind(f.store);
  vi.spyOn(f.store, "publish").mockImplementationOnce(async (kind, value, nodeId) => { await publish(kind, value, nodeId); throw new Error("COMMIT_ACK_LOST"); });
  await expect(f.workspace.write("a/1", lease, update)).rejects.toThrow("COMMIT_ACK_LOST");
  await expect(f.workspace.write("a/2", lease, update)).rejects.toThrow("TESTING_WORKSPACE_NOT_PREPARED");
  f.partitions.release(lease); vi.restoreAllMocks();
  await f.workspace.prepare(f.snapshot, new AbortController().signal);
  const next = f.partitions.acquire({ taskId: "a", partitionId: "tests", paths: ["existing.test.ts"] });
  expect(await f.workspace.write("a/1", next, update)).toMatchObject({ reused: false });
  f.partitions.release(next); await f.workspace.close();
});
