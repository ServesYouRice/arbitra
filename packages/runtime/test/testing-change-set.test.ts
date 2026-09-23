import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { testingChangeSet } from "../src/testing-change-set.js";
import type { TestingPlanExecutionOutcome } from "../src/testing-plan-executor.js";
import type { RepositorySnapshot } from "../src/repository.js";
import { verificationSnapshotFingerprint } from "../src/verification-execution.js";

function snapshot(content: string): RepositorySnapshot {
  return { root: "fixture", files: [{ path: "tests/session.ts", lines: content.split("\n"), byteLength: Buffer.byteLength(content), lineStartBytes: [0] }] };
}
function outcome(current: RepositorySnapshot): TestingPlanExecutionOutcome {
  const snapshotFingerprint = verificationSnapshotFingerprint(current);
  return { passed: true, reasons: [], planFingerprint: "a".repeat(64), snapshotFingerprint, tasks: [{ taskId: "TASK-001", state: "completed" }],
    finalVerification: [{ taskId: "TASK-001", attemptId: "final", artifactId: "verified", taskFingerprint: "b".repeat(64), policyFingerprint: "c".repeat(64), snapshotFingerprint,
      status: "passed", deterministicFailure: false, reasons: [], checks: [{ command: "test", checkId: "tests", executionId: "execution", status: "passed", expectedExitCode: 0, actualExitCode: 0 }] }] };
}

it("exports exact replacement bytes and a baseline compare-and-swap hash", () => {
  const before = "old\r\n"; const after = "new\r\nUnicode: \u754c\n";
  const current = snapshot(after); const changes = testingChangeSet(snapshot(before), current, outcome(current));
  expect(changes.files).toEqual([{ path: "tests/session.ts", expectedHash: createHash("sha256").update(before).digest("hex"), contentHash: createHash("sha256").update(after).digest("hex"), content: after }]);
  expect(changes.verificationArtifactIds).toEqual(["verified"]);
});

it.each(["stale", "failed", "missing", "redaction", "empty", "deletion"])("rejects unsafe or unverifiable handoff: %s", (scenario) => {
  const baseline = snapshot("old\n");
  const current = scenario === "deletion" ? { root: "fixture", files: [] } : snapshot(scenario === "redaction" ? `sk-${"x".repeat(24)}` : scenario === "empty" ? "old\n" : "new\n");
  const initial = outcome(current);
  const verified: TestingPlanExecutionOutcome = { ...initial, finalVerification: scenario === "missing" ? [] : initial.finalVerification.map((result) => ({ ...result,
    snapshotFingerprint: scenario === "stale" ? "d".repeat(64) : result.snapshotFingerprint, status: scenario === "failed" ? "failed" : result.status })) };
  expect(() => testingChangeSet(baseline, current, verified)).toThrow(scenario === "redaction" ? "TESTING_CHANGE_SET_REDACTION_REQUIRED" : scenario === "empty" ? "TESTING_CHANGE_SET_EMPTY" : scenario === "deletion" ? "TESTING_CHANGE_SET_DELETION_UNSUPPORTED" : "TESTING_VERIFIED_CHANGE_SET_REQUIRED");
});
