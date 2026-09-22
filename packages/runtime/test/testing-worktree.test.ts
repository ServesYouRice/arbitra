import { createHash } from "node:crypto";
import { link, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WritePartitions } from "@arbitra/security/write-partitions";
import { snapshotRepository } from "../src/repository.js";
import { TestingWorktree, type TestingWorktreeHandle } from "../src/testing-worktree.js";

const roots: string[] = []; const handles: TestingWorktreeHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => TestingWorktree.recover(handle)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "testing-worktree-fixture-")); roots.push(root);
  await writeFile(join(root, "source.ts"), "export const version = 1;\r\n");
  await writeFile(join(root, "existing.test.ts"), "original test\n");
  const snapshot = await snapshotRepository(root);
  const partitions = new WritePartitions([{ id: "tests", paths: ["existing.test.ts", "tests/new.test.ts", "linked.test.ts", "escape/new.test.ts"] }]);
  const lifecycle = { async prepared(handle: TestingWorktreeHandle) { handles.push(handle); } };
  const worktree = await TestingWorktree.create(snapshot, partitions, lifecycle, new AbortController().signal);
  return { root, snapshot, partitions, worktree };
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

it("creates an owned detached worktree and updates only live leased files with matching hashes", async () => {
  const f = await fixture();
  expect((await readFile(join(f.worktree.directory, ".git"), "utf8")).startsWith("gitdir:")).toBe(true);
  expect((await f.worktree.snapshot()).files).toEqual(f.snapshot.files);
  const lease = f.partitions.acquire({ taskId: "task", partitionId: "tests", paths: ["existing.test.ts", "tests/new.test.ts"] });
  expect(await f.worktree.write(lease, { path: "existing.test.ts", expectedHash: hash("original test\n"), content: "updated test\n" })).toEqual({ path: "existing.test.ts", beforeHash: hash("original test\n"), afterHash: hash("updated test\n") });
  expect(await f.worktree.write(lease, { path: "tests/new.test.ts", expectedHash: null, content: "new test\n" })).toMatchObject({ beforeHash: null, afterHash: hash("new test\n") });
  await expect(f.worktree.write(lease, { path: "existing.test.ts", expectedHash: hash("original test\n"), content: "stale" })).rejects.toThrow("TESTING_WRITE_CONFLICT");
  await expect(f.worktree.write(lease, { path: "source.ts", expectedHash: hash("export const version = 1;\r\n"), content: "changed" })).rejects.toThrow("WRITE_OUTSIDE_LEASE");
  await expect(f.worktree.close()).rejects.toThrow("TESTING_WORKTREE_WRITERS_ACTIVE");
  f.partitions.release(lease);
  await expect(f.worktree.write(lease, { path: "tests/new.test.ts", expectedHash: null, content: "stale lease" })).rejects.toThrow("STALE_OR_FORGED_WRITE_LEASE");
  expect(await readFile(join(f.root, "existing.test.ts"), "utf8")).toBe("original test\n");
  expect((await snapshotRepository(f.root)).files).toEqual(f.snapshot.files);
  await f.worktree.close();
  await expect(f.worktree.snapshot()).rejects.toThrow("TESTING_WORKTREE_CLOSED");
  await expect(lstat(f.worktree.handle.directory)).rejects.toMatchObject({ code: "ENOENT" });
});

it("reopens owned resources and binds cleanup to the original handle", async () => {
  const { worktree } = await fixture();
  const reopened = await TestingWorktree.open(worktree.handle, new WritePartitions([]));
  expect((await reopened.snapshot()).files).toEqual((await worktree.snapshot()).files);
  await expect(TestingWorktree.recover({ ...worktree.handle, snapshotDigest: "0".repeat(64) })).rejects.toThrow("TESTING_WORKTREE_OWNER_MISMATCH");
  await expect(TestingWorktree.recover({ ...worktree.handle, directory: tmpdir() })).rejects.toThrow("INVALID_TESTING_WORKTREE_HANDLE");
  await reopened.close();
  await TestingWorktree.recover(worktree.handle);
});

it("rejects hard-linked files and junction parents without changing external content", async () => {
  const f = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "testing-write-outside-")); roots.push(outside);
  await writeFile(join(outside, "new.test.ts"), "outside\n");
  await link(join(outside, "new.test.ts"), join(f.worktree.directory, "linked.test.ts"));
  await symlink(outside, join(f.worktree.directory, "escape"), "junction");
  const lease = f.partitions.acquire({ taskId: "task", partitionId: "tests", paths: ["linked.test.ts", "escape/new.test.ts"] });
  await expect(f.worktree.write(lease, { path: "linked.test.ts", expectedHash: hash("outside\n"), content: "changed" })).rejects.toThrow("TESTING_WORKTREE_UNSAFE_FILE");
  await expect(f.worktree.write(lease, { path: "escape/new.test.ts", expectedHash: hash("outside\n"), content: "changed" })).rejects.toThrow("TESTING_WORKTREE_UNSAFE_DIRECTORY");
  await expect(f.worktree.snapshot()).rejects.toThrow();
  expect(await readFile(join(outside, "new.test.ts"), "utf8")).toBe("outside\n");
  f.partitions.release(lease); await f.worktree.close();
  expect(await readFile(join(outside, "new.test.ts"), "utf8")).toBe("outside\n");
});

it("persists ownership before Git dispatch and cleans failed setup", async () => {
  const root = await mkdtemp(join(tmpdir(), "testing-worktree-failure-")); roots.push(root);
  const snapshot = { root, files: [] };
  let prepared: TestingWorktreeHandle | undefined; let calls = 0;
  await expect(TestingWorktree.create(snapshot, new WritePartitions([]), { async prepared(handle) { prepared = handle; handles.push(handle); } }, new AbortController().signal, { async run(request) {
    calls += 1; expect(prepared).toBeDefined();
    expect(request.executable).toBe("git"); expect(request.environment["GIT_CONFIG_NOSYSTEM"]).toBe("1");
    expect(request.environment["GIT_CONFIG_COUNT"]).toBeUndefined();
    expect(request.arguments).toContain("--template");
    return { exitCode: 1, stdout: "", stderr: "failed", stopped: null };
  } })).rejects.toThrow("TESTING_WORKTREE_GIT_FAILED");
  expect(calls).toBe(1);
  if (prepared === undefined) throw new Error("HANDLE_ABSENT");
  await expect(lstat(prepared.directory)).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not dispatch Git when ownership persistence fails or cancellation is already signalled", async () => {
  let calls = 0;
  const process = { async run() { calls += 1; throw new Error("UNEXPECTED_DISPATCH"); } };
  await expect(TestingWorktree.create({ root: tmpdir(), files: [] }, new WritePartitions([]), { async prepared(handle) { handles.push(handle); throw new Error("PERSISTENCE_FAILED"); } }, new AbortController().signal, process)).rejects.toThrow("PERSISTENCE_FAILED");
  const controller = new AbortController(); controller.abort();
  await expect(TestingWorktree.create({ root: tmpdir(), files: [] }, new WritePartitions([]), { async prepared() { throw new Error("UNEXPECTED_PREPARE"); } }, controller.signal, process)).rejects.toThrow("TESTING_WORKTREE_CANCELLED");
  expect(calls).toBe(0);
});
