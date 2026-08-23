import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

import { RepositoryPathGuard, type AbsolutePath } from "./path-guard.js";

const execFileAsync = promisify(execFile);

export type SnapshotScope =
  | { readonly kind: "full" }
  | { readonly kind: "diff"; readonly base: string; readonly head: string };

export interface RepositorySnapshot {
  readonly root: AbsolutePath;
  readonly branch: string | null;
  readonly commit: string;
  readonly dirty: boolean;
  readonly changedFiles: readonly string[];
  readonly workingTreeDigest: string;
  readonly scope: SnapshotScope & { readonly mergeBase?: string };
}

export interface GitRunner {
  run(root: string, args: readonly string[]): Promise<string>;
}

export interface SnapshotOptions {
  readonly git?: GitRunner;
}

const processGitRunner: GitRunner = {
  async run(root, args) {
    const result = await execFileAsync("git", ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return result.stdout;
  },
};

export async function createSnapshot(
  root: string,
  scope: SnapshotScope = { kind: "full" },
  options: SnapshotOptions = {},
): Promise<RepositorySnapshot> {
  const guard = await RepositoryPathGuard.create(root);
  const git = options.git ?? processGitRunner;
  const repositoryRoot = (await git.run(guard.root, ["rev-parse", "--show-toplevel"])).trim();
  const validatedRoot = guard.resolve(repositoryRoot);
  const [branchOutput, commitOutput, statusOutput, indexOutput] = await Promise.all([
    git.run(validatedRoot, ["branch", "--show-current"]),
    git.run(validatedRoot, ["rev-parse", "HEAD"]),
    git.run(validatedRoot, ["status", "--porcelain=v1", "-z"]),
    git.run(validatedRoot, ["ls-files", "--stage", "-z"]),
  ]);
  const changedFiles = scope.kind === "diff"
    ? splitNull(await git.run(validatedRoot, ["diff", "--name-only", "-z", scope.base, scope.head]))
    : pathsFromStatus(statusOutput);
  const resolvedScope = scope.kind === "diff"
    ? Object.freeze({
        ...scope,
        mergeBase: (await git.run(validatedRoot, ["merge-base", scope.base, scope.head])).trim(),
      })
    : Object.freeze(scope);

  return Object.freeze({
    root: validatedRoot,
    branch: branchOutput.trim() || null,
    commit: commitOutput.trim(),
    dirty: statusOutput.length > 0,
    changedFiles: Object.freeze(changedFiles),
    workingTreeDigest: digestWorkingTree(indexOutput, statusOutput),
    scope: resolvedScope,
  });
}

export interface DriftResult {
  readonly changed: boolean;
  readonly warning: string | null;
  readonly currentDigest: string;
}

export async function detectWorkingTreeDrift(
  snapshot: RepositorySnapshot,
  git: GitRunner = processGitRunner,
): Promise<DriftResult> {
  const [status, index] = await Promise.all([
    git.run(snapshot.root, ["status", "--porcelain=v1", "-z"]),
    git.run(snapshot.root, ["ls-files", "--stage", "-z"]),
  ]);
  const currentDigest = digestWorkingTree(index, status);
  const changed = currentDigest !== snapshot.workingTreeDigest;
  return Object.freeze({
    changed,
    warning: changed ? "Repository working tree changed materially after snapshot capture." : null,
    currentDigest,
  });
}

function digestWorkingTree(index: string, status: string): string {
  return createHash("sha256").update(index).update("\0").update(status).digest("hex");
}

function splitNull(value: string): string[] {
  return value.split("\0").filter((entry) => entry.length > 0).sort();
}

function pathsFromStatus(status: string): string[] {
  const entries = status.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined || entry.length === 0) continue;
    paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C" || entry[1] === "R" || entry[1] === "C") {
      const originalPath = entries[index + 1];
      if (originalPath !== undefined && originalPath.length > 0) paths.push(originalPath);
      index += 1;
    }
  }
  return [...new Set(paths)].sort();
}
