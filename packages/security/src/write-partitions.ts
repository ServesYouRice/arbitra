/** Exact paths granted by trusted execution configuration, never planner output. */
export interface TrustedWritePartition { readonly id: string; readonly paths: readonly string[] }
export interface WriteRequest {
  readonly taskId: string;
  readonly partitionId: string;
  readonly paths: readonly string[];
  readonly filesNotToTouch?: readonly string[];
  /** Preparatory tasks which mutate shared state must run alone. */
  readonly exclusive?: boolean;
}
export interface WriteLease { readonly taskId: string; readonly partitionId: string; readonly paths: readonly string[]; readonly exclusive: boolean }

/** Portable concrete file identity. Reject aliases instead of broadening authority. */
export function concreteWritePath(path: string): string {
  if (path !== path.normalize("NFC") || path.includes("\\") || [...path].some((character) => character.charCodeAt(0) < 32) || /[<>:"|?*]/u.test(path)) throw new Error(`INVALID_WRITE_PATH:${path}`);
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".." || /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) throw new Error(`INVALID_WRITE_PATH:${path}`);
  if (parts.some((part) => [".git", ".runs", ".codex", ".agents"].includes(part.toLowerCase()))) throw new Error(`CONTROL_PLANE_WRITE_FORBIDDEN:${path}`);
  return path;
}

/** Process-local dispatch guard. The execution coordinator must recover all durable
 * in-flight executors before constructing a replacement guard after restart.
 * This is scheduling authority; the filesystem/container boundary must enforce it too. */
export class WritePartitions {
  readonly #partitions = new Map<string, ReadonlyMap<string, string>>();
  readonly #active = new Map<string, WriteLease>();

  constructor(partitions: readonly TrustedWritePartition[]) {
    for (const partition of partitions) {
      if (partition.id.trim() === "" || this.#partitions.has(partition.id)) throw new Error("INVALID_WRITE_PARTITION_ID");
      const paths = new Map<string, string>();
      for (const raw of partition.paths) {
        const path = concreteWritePath(raw); const key = identity(path);
        if (paths.has(key)) throw new Error(`DUPLICATE_WRITE_PATH:${path}`);
        if ([...paths.keys()].some((existing) => intersects(existing, key))) throw new Error(`WRITE_PATH_ANCESTOR_CONFLICT:${path}`);
        paths.set(key, path);
      }
      this.#partitions.set(partition.id, paths);
    }
  }

  acquire(request: WriteRequest): WriteLease {
    if (request.taskId.trim() === "" || this.#active.has(request.taskId)) throw new Error("WRITE_TASK_ALREADY_ACTIVE_OR_INVALID");
    const partition = this.#partitions.get(request.partitionId);
    if (partition === undefined) throw new Error(`UNKNOWN_WRITE_PARTITION:${request.partitionId}`);
    const excluded = new Set((request.filesNotToTouch ?? []).map((path) => identity(concreteWritePath(path))));
    const paths = request.paths.map(concreteWritePath);
    if (new Set(paths.map(identity)).size !== paths.length) throw new Error("DUPLICATE_TASK_WRITE_PATH");
    for (const path of paths) {
      // Exact spelling prevents case-sensitive hosts from writing a second, ungranted file.
      if (partition.get(identity(path)) !== path) throw new Error(`WRITE_SCOPE_REQUIRES_APPROVAL:${path}`);
      if (excluded.has(identity(path))) throw new Error(`WRITE_PATH_EXCLUDED:${path}`);
    }
    if (paths.length === 0) throw new Error("EMPTY_TASK_WRITE_SCOPE");
    for (const active of this.#active.values()) {
      if (request.exclusive === true || active.exclusive || paths.some((path) => active.paths.some((other) => intersects(identity(path), identity(other))))) throw new Error(`WRITE_SCOPE_BUSY:${active.taskId}`);
    }
    const lease: WriteLease = Object.freeze({ taskId: request.taskId, partitionId: request.partitionId, paths: Object.freeze([...paths].sort()), exclusive: request.exclusive === true });
    this.#active.set(request.taskId, lease);
    return lease;
  }

  assertGranted(lease: WriteLease, path: string): void {
    if (this.#active.get(lease.taskId) !== lease) throw new Error("STALE_OR_FORGED_WRITE_LEASE");
    concreteWritePath(path);
    if (!lease.paths.includes(path)) throw new Error(`WRITE_OUTSIDE_LEASE:${path}`);
  }

  release(lease: WriteLease): void {
    if (this.#active.get(lease.taskId) !== lease) throw new Error("STALE_OR_FORGED_WRITE_LEASE");
    this.#active.delete(lease.taskId);
  }

  active(): readonly WriteLease[] { return Object.freeze([...this.#active.values()]); }
}

// Conservative case folding prevents concurrent aliases on case-insensitive worktrees.
function identity(path: string): string { return path.toLowerCase(); }
function intersects(left: string, right: string): boolean { return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`); }
