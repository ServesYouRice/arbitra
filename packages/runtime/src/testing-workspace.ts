import { createHash } from "node:crypto";
import { canonicalJson } from "@arbitra/core/config/config-store.js";
import { WritePartitions, type WriteLease } from "@arbitra/security/write-partitions";
import type { RepositorySnapshot } from "./repository.js";
import { RunStore } from "./run-store.js";
import { TestingWorktree, type TestingFileUpdate, type TestingWorktreeHandle } from "./testing-worktree.js";

interface WriteRecord {
  readonly operationId: string; readonly taskId: string; readonly partitionId: string; readonly path: string;
  readonly beforeHash: string | null; readonly afterHash: string;
  readonly state: "reserved" | "completed" | "interrupted";
}
interface WorkspaceRecord {
  readonly version: 1; readonly baseline: readonly { path: string; hash: string }[];
  readonly state: "reserved" | "prepared" | "ready" | "closed";
  readonly handle?: TestingWorktreeHandle;
  readonly writes: readonly WriteRecord[];
}
const ARTIFACT = "testing-workspace";

/** One coordinator per run. Writes commit their intent before touching files.
 * Recovery verifies every worktree byte against the baseline plus journal, before
 * callers acquire leases or resume model execution. Model/native processes must
 * never receive host write access to the worktree. */
export class TestingWorkspace {
  #pending: Promise<unknown> = Promise.resolve();
  #worktree: TestingWorktree | undefined;
  #record: WorkspaceRecord | undefined;
  constructor(private readonly store: RunStore, private readonly partitions: WritePartitions) {}

  prepare(snapshot: RepositorySnapshot, signal: AbortSignal): Promise<TestingWorktreeHandle> {
    // Freeze caller-owned data across filesystem/provider waits.
    const source = { root: snapshot.root, files: snapshot.files.map((file) => ({ ...file, lines: [...file.lines], lineStartBytes: [...file.lineStartBytes] })) };
    return this.serial(async () => {
      if (this.partitions.active().length > 0) throw new Error("TESTING_WORKSPACE_PREPARE_REQUIRES_IDLE_WRITERS");
      const baseline = source.files.map(({ path, lines }) => ({ path, hash: hash(lines.join("\n")) })).sort((a, b) => a.path.localeCompare(b.path));
      const descriptor = (await this.store.listArtifacts()).find(({ kind }) => kind === ARTIFACT);
      let record = descriptor === undefined ? undefined : await this.store.artifacts.get<WorkspaceRecord>(descriptor.ref);
      if (record !== undefined && (record.version !== 1 || canonicalJson(record.baseline) !== canonicalJson(baseline))) throw new Error("TESTING_WORKSPACE_BASELINE_CHANGED");
      if (record?.state === "closed") throw new Error("TESTING_WORKSPACE_CLOSED");
      if (record?.state === "ready") {
        if (record.handle === undefined) throw new Error("TESTING_WORKSPACE_HANDLE_ABSENT");
        this.#worktree = await TestingWorktree.open(record.handle, this.partitions);
        this.#record = record;
        await this.reconcile();
        return record.handle;
      }
      if (record?.writes.length) throw new Error("TESTING_WORKSPACE_SETUP_HAS_WRITES");
      if (record?.handle !== undefined) await TestingWorktree.recover(record.handle);
      record = { version: 1, baseline, state: "reserved", writes: [] };
      await this.save(record);
      this.#worktree = await TestingWorktree.create(source, this.partitions, { prepared: async (handle) => {
        record = { version: 1, baseline, state: "prepared", writes: [], handle };
        await this.save(record);
      } }, signal);
      await this.save({ ...record, state: "ready", handle: this.#worktree.handle });
      await this.reconcile();
      return this.#worktree.handle;
    });
  }

  write(operationId: string, lease: WriteLease, update: TestingFileUpdate): Promise<{ path: string; beforeHash: string | null; afterHash: string; reused: boolean }> {
    const input = Object.freeze({ ...update });
    return this.serial(async () => {
      if (operationId.trim() === "") throw new Error("INVALID_TESTING_WRITE_OPERATION");
      const worktree = this.ready();
      this.partitions.assertGranted(lease, input.path);
      await this.reconcile();
      let record = this.record();
      const afterHash = hash(input.content);
      const previous = record.writes.findLast((write) => write.operationId === operationId);
      if (previous !== undefined) {
        if (previous.taskId !== lease.taskId || previous.partitionId !== lease.partitionId || previous.path !== input.path || previous.beforeHash !== input.expectedHash || previous.afterHash !== afterHash) throw new Error("TESTING_WRITE_OPERATION_CHANGED");
        if (previous.state === "completed") return { path: previous.path, beforeHash: previous.beforeHash, afterHash, reused: true };
      }
      if (record.writes.length >= 256) throw new Error("TESTING_WRITE_ATTEMPT_LIMIT");
      const files = await worktree.snapshot();
      const actual = files.files.find(({ path }) => path === input.path);
      if ((actual === undefined ? null : hash(actual.lines.join("\n"))) !== input.expectedHash) throw new Error(`TESTING_WRITE_CONFLICT:${input.path}`);
      if (Buffer.byteLength(input.content) > 512 * 1024 || files.files.reduce((sum, file) => sum + file.byteLength, 0) - (actual?.byteLength ?? 0) + Buffer.byteLength(input.content) > 32 * 1024 * 1024) throw new Error("TESTING_WRITE_SIZE_LIMIT");
      const intent: WriteRecord = { operationId, taskId: lease.taskId, partitionId: lease.partitionId, path: input.path, beforeHash: input.expectedHash, afterHash, state: "reserved" };
      record = { ...record, writes: [...record.writes, intent] };
      await this.save(record);
      const result = await worktree.write(lease, input);
      await this.save({ ...record, writes: [...record.writes.slice(0, -1), { ...intent, state: "completed" }] });
      return { ...result, reused: false };
    });
  }

  snapshot(): Promise<RepositorySnapshot> {
    return this.serial(async () => { await this.reconcile(); return this.ready().snapshot(); });
  }

  verificationInput(taskId: string): Promise<{ snapshot: RepositorySnapshot; writes: readonly { path: string; beforeHash: string | null; afterHash: string }[] }> {
    return this.serial(async () => {
      await this.reconcile();
      const writes = this.record().writes.filter((write) => write.taskId === taskId && write.state === "completed" && write.beforeHash !== write.afterHash)
        .map(({ path, beforeHash, afterHash }) => ({ path, beforeHash, afterHash }));
      return { snapshot: await this.ready().snapshot(), writes };
    });
  }

  close(): Promise<void> {
    return this.serial(async () => {
      if (this.partitions.active().length > 0) throw new Error("TESTING_WORKSPACE_WRITERS_ACTIVE");
      await this.reconcile();
      const record = this.record();
      // Commit terminal intent before deletion; cleanup can be retried from this handle.
      await this.save({ ...record, state: "closed" });
      await this.readyWorktree().close(); this.#worktree = undefined;
    });
  }

  /** Finish a previously committed close; never silently discard a ready workspace. */
  async recoverClosed(): Promise<void> {
    return this.serial(async () => {
      if (this.partitions.active().length > 0) throw new Error("TESTING_WORKSPACE_WRITERS_ACTIVE");
      const descriptor = (await this.store.listArtifacts()).find(({ kind }) => kind === ARTIFACT);
      if (descriptor === undefined) return;
      const record = await this.store.artifacts.get<WorkspaceRecord>(descriptor.ref);
      if (record.state !== "closed") throw new Error("TESTING_WORKSPACE_NOT_CLOSED");
      if (record.handle !== undefined) await TestingWorktree.recover(record.handle);
      this.#record = record; this.#worktree = undefined;
    });
  }

  private async reconcile(): Promise<void> {
    const actual = new Map((await this.ready().snapshot()).files.map(({ path, lines }) => [path, hash(lines.join("\n"))]));
    const record = this.record();
    const expected = new Map(record.baseline.map(({ path, hash }) => [path, hash]));
    const writes: WriteRecord[] = []; let changed = false;
    for (const [index, write] of record.writes.entries()) {
      if ((expected.get(write.path) ?? null) !== write.beforeHash) throw new Error("TESTING_WORKSPACE_JOURNAL_INCONSISTENT");
      if (write.state === "reserved") {
        if (index !== record.writes.length - 1) throw new Error("TESTING_WORKSPACE_UNRESOLVED_WRITE_ORDER");
        if (actual.get(write.path) === write.afterHash) { writes.push({ ...write, state: "completed" }); expected.set(write.path, write.afterHash); }
        else if ((actual.get(write.path) ?? null) === write.beforeHash) writes.push({ ...write, state: "interrupted" });
        else throw new Error(`TESTING_WORKSPACE_UNRECORDED_CHANGE:${write.path}`);
        changed = true;
      } else {
        writes.push(write);
        if (write.state === "completed") expected.set(write.path, write.afterHash);
        else if (write.state !== "interrupted") throw new Error("TESTING_WORKSPACE_INVALID_WRITE_STATE");
      }
    }
    if (actual.size !== expected.size || [...expected].some(([path, digest]) => actual.get(path) !== digest)) throw new Error("TESTING_WORKSPACE_UNRECORDED_CHANGE");
    if (changed) await this.save({ ...record, writes });
  }
  private record(): WorkspaceRecord { if (this.#record === undefined) throw new Error("TESTING_WORKSPACE_NOT_PREPARED"); return this.#record; }
  private readyWorktree(): TestingWorktree { if (this.#worktree === undefined) throw new Error("TESTING_WORKSPACE_NOT_PREPARED"); return this.#worktree; }
  private ready(): TestingWorktree { if (this.record().state !== "ready") throw new Error("TESTING_WORKSPACE_NOT_READY"); return this.readyWorktree(); }
  private async save(record: WorkspaceRecord): Promise<void> {
    try { await this.store.publish(ARTIFACT, record, "testing-execution"); this.#record = record; }
    catch (error) {
      // Publication may have committed before reporting failure. Never overwrite an
      // uncertain durable intent using our older in-memory ledger; require prepare.
      this.#record = undefined;
      throw error;
    }
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> { const pending = this.#pending.then(operation); this.#pending = pending.catch(() => undefined); return pending; }
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
