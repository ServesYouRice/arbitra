import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { redactSecrets } from "@arbitra/security/redaction";
import { concreteWritePath } from "@arbitra/security/write-partitions";
import type { RepositorySnapshot } from "./repository.js";
import type { TestingPlanExecutionOutcome } from "./testing-plan-executor.js";
import { verificationSnapshotFingerprint } from "./verification-execution.js";

export interface TestingChangeSet {
  readonly schemaVersion: 1;
  readonly planFingerprint: string;
  readonly baselineFingerprint: string;
  readonly snapshotFingerprint: string;
  readonly verificationArtifactIds: readonly string[];
  readonly files: readonly { path: string; expectedHash: string | null; contentHash: string; content: string }[];
}

/** Exact UTF-8 create/replace payloads. Applying them requires comparing expectedHash
 * with the destination bytes; generation never changes the user's checkout. */
export function testingChangeSet(baseline: RepositorySnapshot, current: RepositorySnapshot, outcome: TestingPlanExecutionOutcome): TestingChangeSet {
  const fingerprint = verificationSnapshotFingerprint(current);
  if (!outcome.passed || outcome.reasons.length !== 0 || outcome.snapshotFingerprint !== fingerprint
    || outcome.tasks.length === 0 || outcome.tasks.some(({ state }) => state !== "completed")
    || outcome.finalVerification.length !== outcome.tasks.length
    || outcome.tasks.some(({ taskId }) => !outcome.finalVerification.some((result) => result.taskId === taskId && result.status === "passed" && result.snapshotFingerprint === fingerprint))) throw new Error("TESTING_VERIFIED_CHANGE_SET_REQUIRED");
  const original = new Map(baseline.files.map(({ path, lines }) => [path, digest(lines.join("\n"))]));
  if (original.size !== baseline.files.length || new Set(current.files.map(({ path }) => path)).size !== current.files.length) throw new Error("TESTING_CHANGE_SET_DUPLICATE_PATH");
  if (baseline.files.some(({ path }) => !current.files.some((file) => file.path === path))) throw new Error("TESTING_CHANGE_SET_DELETION_UNSUPPORTED");
  const files: TestingChangeSet["files"][number][] = [];
  for (const { path, lines } of current.files) {
    const content = lines.join("\n"); const contentHash = digest(content); const expectedHash = original.get(path) ?? null;
    if (expectedHash === contentHash) continue;
    concreteWritePath(path);
    // Artifact persistence redacts secrets. Do not silently deliver altered bytes
    // while claiming the hashes/checks describe the original verified content.
    if (redactSecrets(content).text !== content) throw new Error(`TESTING_CHANGE_SET_REDACTION_REQUIRED:${path}`);
    files.push({ path, expectedHash, contentHash, content });
  }
  if (files.length === 0) throw new Error("TESTING_CHANGE_SET_EMPTY");
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { schemaVersion: 1, planFingerprint: outcome.planFingerprint, baselineFingerprint: verificationSnapshotFingerprint(baseline),
    snapshotFingerprint: fingerprint, verificationArtifactIds: outcome.finalVerification.map(({ artifactId }) => artifactId), files };
}
export interface TestingChangeSetApplication {
  readonly target: string;
  readonly applied: readonly { path: string; contentHash: string; created: boolean }[];
}

/**
 * Apply an exported change set to a checkout the operator names. Every destination is
 * compared with its `expectedHash` (absent for a created file) before anything is
 * written, so a stale or diverged destination rejects the whole set and changes nothing.
 * Writes go through a sibling temporary file and rename. Symbolic links and control-plane
 * paths are refused; the bytes written are exactly the verified `content`.
 */
export async function applyTestingChangeSet(changeSet: Pick<TestingChangeSet, "files">, targetDirectory: string): Promise<TestingChangeSetApplication> {
  const target = await realpath(targetDirectory);
  if (!(await lstat(target)).isDirectory()) throw new Error("TESTING_CHANGE_SET_TARGET_NOT_DIRECTORY");
  const stale: string[] = [];
  const planned: { path: string; destination: string; content: string; contentHash: string; created: boolean }[] = [];
  const paths = new Set<string>();
  for (const file of changeSet.files) {
    const path = concreteWritePath(file.path);
    if (paths.has(path)) throw new Error(`TESTING_CHANGE_SET_DUPLICATE_PATH:${path}`);
    paths.add(path);
    if (digest(file.content) !== file.contentHash) throw new Error(`TESTING_CHANGE_SET_CONTENT_MISMATCH:${path}`);
    const destination = join(target, path);
    await assertNoLinkedAncestor(target, path);
    let current: Buffer | null = null;
    try {
      const entry = await lstat(destination);
      if (!entry.isFile()) throw new Error(`TESTING_CHANGE_SET_DESTINATION_NOT_FILE:${path}`);
      current = await readFile(destination);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const currentHash = current === null ? null : createHash("sha256").update(current).digest("hex");
    if (currentHash !== file.expectedHash) { stale.push(path); continue; }
    planned.push({ path, destination, content: file.content, contentHash: file.contentHash, created: current === null });
  }
  if (stale.length > 0) throw new Error(`TESTING_CHANGE_SET_STALE_DESTINATION:${stale.join(",")}`);
  for (const file of planned) {
    await mkdir(dirname(file.destination), { recursive: true });
    await assertNoLinkedAncestor(target, file.path);
    const temporary = join(dirname(file.destination), `.arbitra-apply-${randomBytes(6).toString("hex")}`);
    try { await writeFile(temporary, file.content, { encoding: "utf8", flag: "wx" }); await rename(temporary, file.destination); }
    finally { await rm(temporary, { force: true }); }
  }
  return { target, applied: planned.map(({ path, contentHash, created }) => ({ path, contentHash, created })) };
}

async function assertNoLinkedAncestor(target: string, path: string): Promise<void> {
  let current = target;
  for (const part of path.split("/")) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`TESTING_CHANGE_SET_SYMLINK_REFUSED:${path}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  }
  const inside = relative(target, current);
  if (inside.startsWith("..") || isAbsolute(inside)) throw new Error(`TESTING_CHANGE_SET_PATH_OUTSIDE_TARGET:${path}`);
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
