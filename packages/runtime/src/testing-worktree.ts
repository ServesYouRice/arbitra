import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { concreteWritePath, WritePartitions, type WriteLease } from "@arbitra/security/write-partitions";
import type { RepositorySnapshot, SourceFile } from "./repository.js";
import { runBoundedProcess, type ProcessPort } from "./test-sandbox.js";

export interface TestingWorktreeHandle { readonly id: string; readonly directory: string; readonly snapshotDigest: string }
export interface TestingWorktreeLifecycle { prepared(handle: TestingWorktreeHandle): Promise<void> }
export interface TestingFileUpdate { readonly path: string; readonly expectedHash: string | null; readonly content: string }
const MAX_FILE_BYTES = 512 * 1024;
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;

/** Owned detached Git worktree, seeded from the exact scoped snapshot. No source
 * checkout Git metadata, credentials, hooks or remotes are shared. Untrusted command
 * execution must use a separate read-only sandbox, never this host directory.
 * The coordinator is the sole writer; leases alone cannot constrain a native process. */
export class TestingWorktree {
  #pending: Promise<unknown> = Promise.resolve();
  #closed = false;
  private constructor(readonly handle: TestingWorktreeHandle, private readonly partitions: WritePartitions) {}
  get directory(): string { return join(this.handle.directory, "worktree"); }

  static async create(snapshot: RepositorySnapshot, partitions: WritePartitions, lifecycle: TestingWorktreeLifecycle, signal: AbortSignal,
    processes: ProcessPort = { run: runBoundedProcess }): Promise<TestingWorktree> {
    snapshot = { root: snapshot.root, files: snapshot.files.map((file) => ({ ...file, lines: [...file.lines], lineStartBytes: [...file.lineStartBytes] })) };
    validateSnapshot(snapshot);
    if (signal.aborted) throw new Error("TESTING_WORKTREE_CANCELLED");
    // arbitra-determinism: allow -- resource identity is minted at the filesystem boundary
    const id = randomUUID();
    const directory = await mkdtemp(join(tmpdir(), `arbitra-testing-worktree-${id}-`));
    const handle: TestingWorktreeHandle = Object.freeze({ id, directory, snapshotDigest: digest(snapshot) });
    await writeFile(join(directory, "owner.json"), JSON.stringify(handle), { flag: "wx", mode: 0o600 });
    try {
      // No Git process or snapshot materialization precedes durable ownership.
      await lifecycle.prepared(handle);
      const repository = join(directory, "repository");
      const empty = join(directory, "empty");
      await mkdir(repository); await mkdir(empty); await mkdir(join(directory, "staging"));
      await writeFile(join(directory, "empty-config"), "", { flag: "wx" });
      const environment = { ...Object.fromEntries(["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key] as string]])),
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(directory, "empty-config"), GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "file" };
      const git = async (args: readonly string[]) => {
        const result = await processes.run({ executable: "git", arguments: ["-c", `core.hooksPath=${empty}`, "-c", `core.attributesFile=${join(directory, "empty-config")}`, "-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", "commit.gpgsign=false", "-c", "user.name=Arbitra", "-c", "user.email=arbitra@localhost", "-C", repository, ...args],
          cwd: directory, environment, timeoutMs: 30_000, maximumOutputBytes: 16_384, signal });
        if (result.stopped !== null || result.exitCode !== 0) throw new Error(`TESTING_WORKTREE_GIT_FAILED:${result.stopped ?? result.exitCode}`);
      };
      await git(["init", "--template", empty, "--initial-branch=arbitra"]);
      for (const file of snapshot.files) {
        if (signal.aborted) throw new Error("TESTING_WORKTREE_CANCELLED");
        const destination = join(repository, file.path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, file.lines.join("\n"), { flag: "wx" });
      }
      await git(["add", "--all", "--force", "--", "."]);
      await git(["commit", "--allow-empty", "-m", "Recorded Testing snapshot"]);
      await git(["worktree", "add", "--detach", join(directory, "worktree"), "HEAD"]);
      const worktree = new TestingWorktree(handle, partitions);
      if (digest(await worktree.snapshot()) !== handle.snapshotDigest) throw new Error("TESTING_WORKTREE_SNAPSHOT_CHANGED");
      return worktree;
    } catch (error) { await TestingWorktree.recover(handle); throw error; }
  }

  /** The caller must first recover all previous executors and validate its durable
   * write journal. Opening does not establish that unrecorded file changes are valid. */
  static async open(handle: TestingWorktreeHandle, partitions: WritePartitions): Promise<TestingWorktree> {
    const owned = Object.freeze({ ...handle });
    await validateOwner(owned);
    await checkedDirectory(join(owned.directory, "worktree"));
    return new TestingWorktree(owned, partitions);
  }

  /** Abandon owned resources after executors are stopped. No source Git commands run. */
  static async recover(handle: TestingWorktreeHandle): Promise<void> {
    if (!await validateOwner(handle, true)) return;
    // Preserve the ownership marker while child cleanup can still fail or be interrupted.
    for (const name of await readdir(handle.directory)) {
      if (name === "owner.json") continue;
      const child = join(handle.directory, name);
      if (dirname(child) !== handle.directory) throw new Error("UNSAFE_TESTING_WORKTREE_CLEANUP");
      await rm(child, { recursive: true, force: true });
    }
    await rm(join(handle.directory, "owner.json"), { force: true });
    await rmdir(handle.directory);
  }

  write(lease: WriteLease, update: TestingFileUpdate): Promise<{ path: string; beforeHash: string | null; afterHash: string }> {
    // Copy before awaiting: caller mutation cannot change the authorized operation.
    const input = Object.freeze({ ...update });
    return this.serial(async () => {
      await this.assertOpen();
      this.partitions.assertGranted(lease, input.path);
      if (input.expectedHash !== null && !/^[a-f0-9]{64}$/u.test(input.expectedHash)) throw new Error("INVALID_TESTING_EXPECTED_HASH");
      if (Buffer.byteLength(input.content) > MAX_FILE_BYTES) throw new Error("TESTING_WRITE_SIZE_LIMIT");
      const path = await this.resolveFile(input.path, true);
      const before = await fileHash(path);
      if (before !== input.expectedHash) throw new Error(`TESTING_WRITE_CONFLICT:${input.path}`);
      // Keep temporary files outside all task partitions, on the same volume.
      await checkedDirectory(join(this.handle.directory, "staging"));
      const staging = await mkdtemp(join(this.handle.directory, "staging", "write-"));
      const temporary = join(staging, "content");
      try {
        await writeFile(temporary, input.content, { flag: "wx" });
        await this.resolveFile(input.path, false);
        this.partitions.assertGranted(lease, input.path);
        if (await fileHash(path) !== before) throw new Error(`TESTING_WRITE_CONFLICT:${input.path}`);
        await rename(temporary, path);
      } finally { await rm(staging, { recursive: true, force: true }); }
      return { path: input.path, beforeHash: before, afterHash: hash(input.content) };
    });
  }

  snapshot(): Promise<RepositorySnapshot> {
    return this.serial(async () => {
      await this.assertOpen();
      const files: SourceFile[] = []; let bytes = 0;
      const walk = async (relative: string) => {
        const directory = join(this.directory, relative); await checkedDirectory(directory);
        for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          if (relative === "" && entry.name === ".git") continue;
          const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
          concreteWritePath(path);
          if (entry.isDirectory()) { await walk(path); continue; }
          await checkedFile(join(this.directory, path));
          const content = await readFile(join(this.directory, path));
          bytes += content.length;
          if (content.length > MAX_FILE_BYTES || bytes > MAX_SNAPSHOT_BYTES) throw new Error("TESTING_WORKTREE_SIZE_LIMIT");
          const text = content.toString("utf8");
          if (!Buffer.from(text).equals(content)) throw new Error("TESTING_WORKTREE_NON_UTF8_FILE");
          const lines = text.split("\n"); let offset = 0;
          const lineStartBytes = lines.map((line) => { const start = offset; offset += Buffer.byteLength(line) + 1; return start; });
          files.push({ path, lines, lineStartBytes, byteLength: content.length });
        }
      };
      await walk("");
      return { root: this.directory, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
    });
  }

  close(): Promise<void> {
    return this.serial(async () => {
      if (this.partitions.active().length > 0) throw new Error("TESTING_WORKTREE_WRITERS_ACTIVE");
      this.#closed = true;
      await TestingWorktree.recover(this.handle);
    });
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#pending.then(operation); this.#pending = pending.catch(() => undefined); return pending;
  }
  private async assertOpen() {
    if (this.#closed) throw new Error("TESTING_WORKTREE_CLOSED");
    await validateOwner(this.handle);
    await checkedDirectory(this.directory);
  }
  private async resolveFile(path: string, createParents: boolean): Promise<string> {
    concreteWritePath(path);
    let current = this.directory;
    for (const part of path.split("/").slice(0, -1)) {
      current = join(current, part);
      if (createParents) { try { await mkdir(current); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
      await checkedDirectory(current);
    }
    const destination = join(this.directory, path);
    try { await checkedFile(destination); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return destination;
  }
}

async function validateOwner(handle: TestingWorktreeHandle, missingAllowed = false): Promise<boolean> {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(handle.id) || !/^[a-f0-9]{64}$/u.test(handle.snapshotDigest)
    || !isAbsolute(handle.directory) || resolve(dirname(handle.directory)) !== resolve(tmpdir())
    || !new RegExp(`^arbitra-testing-worktree-${handle.id}-[A-Za-z0-9]{6}$`, "u").test(basename(handle.directory))) throw new Error("INVALID_TESTING_WORKTREE_HANDLE");
  try { await checkedDirectory(handle.directory); }
  catch (error) { if (missingAllowed && (error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  if (dirname(await realpath(handle.directory)) !== await realpath(tmpdir())) throw new Error("UNSAFE_TESTING_WORKTREE_ROOT");
  const owner = join(handle.directory, "owner.json");
  try { await checkedFile(owner); }
  catch (error) {
    // An interrupted final rmdir leaves only the empty, identity-bound directory.
    if (missingAllowed && (error as NodeJS.ErrnoException).code === "ENOENT" && (await readdir(handle.directory)).length === 0) return true;
    throw error;
  }
  const saved = JSON.parse(await readFile(owner, "utf8")) as TestingWorktreeHandle;
  if (saved.id !== handle.id || saved.directory !== handle.directory || saved.snapshotDigest !== handle.snapshotDigest) throw new Error("TESTING_WORKTREE_OWNER_MISMATCH");
  return true;
}
async function checkedDirectory(path: string): Promise<void> { const entry = await lstat(path); if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("TESTING_WORKTREE_UNSAFE_DIRECTORY"); }
async function checkedFile(path: string): Promise<void> { const entry = await lstat(path); if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new Error("TESTING_WORKTREE_UNSAFE_FILE"); }
async function fileHash(path: string): Promise<string | null> { try { await checkedFile(path); return hash(await readFile(path)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } }
function hash(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function digest(snapshot: RepositorySnapshot): string { return hash(JSON.stringify(snapshot.files.map(({ path, lines }) => ({ path, content: lines.join("\n") })).sort((a, b) => a.path.localeCompare(b.path)))); }
function validateSnapshot(snapshot: RepositorySnapshot): void {
  new WritePartitions([{ id: "snapshot", paths: snapshot.files.map(({ path }) => path) }]);
  let total = 0;
  for (const file of snapshot.files) { const bytes = Buffer.byteLength(file.lines.join("\n")); total += bytes; if (bytes > MAX_FILE_BYTES || total > MAX_SNAPSHOT_BYTES) throw new Error("TESTING_WORKTREE_SIZE_LIMIT"); }
}
