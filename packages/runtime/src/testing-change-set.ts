import { createHash } from "node:crypto";
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
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
