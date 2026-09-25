import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyTestingChangeSet, testingChangeSet } from "../src/testing-change-set.js";
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
      status: "passed", deterministicFailure: false, reasons: [], checks: [{ command: "test", checkId: "tests", executionId: "execution", status: "passed", expectedExitCode: 0, actualExitCode: 0 }] }], repair: [] };
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

describe("applying an exported change set", () => {
  const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
  async function checkout(files: Record<string, string>) {
    const root = await mkdtemp(join(tmpdir(), "change-set-apply-")); roots.push(root);
    for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); }
    return root;
  }
  const replace = (path: string, before: string | null, after: string) => ({ path, expectedHash: before === null ? null : sha(before), contentHash: sha(after), content: after });

  it("writes exact bytes when every destination still matches its baseline hash", async () => {
    const root = await checkout({ "tests/a.test.ts": "old\r\n" });
    const result = await applyTestingChangeSet({ files: [replace("tests/a.test.ts", "old\r\n", "new\r\n界\n"), replace("tests/new/b.test.ts", null, "created\n")] }, root);
    expect(result.applied).toEqual([{ path: "tests/a.test.ts", contentHash: sha("new\r\n界\n"), created: false }, { path: "tests/new/b.test.ts", contentHash: sha("created\n"), created: true }]);
    expect(sha(await readFile(join(root, "tests/a.test.ts")))).toBe(sha("new\r\n界\n"));
    expect(await readFile(join(root, "tests/new/b.test.ts"), "utf8")).toBe("created\n");
    expect((await readdir(join(root, "tests"))).filter((name) => name.startsWith(".arbitra-apply-"))).toEqual([]);
  });

  it("rejects the whole set, writing nothing, when any destination diverged", async () => {
    const root = await checkout({ "tests/a.test.ts": "old\n", "tests/b.test.ts": "edited by the operator\n", "tests/c.test.ts": "exists\n" });
    await expect(applyTestingChangeSet({ files: [replace("tests/a.test.ts", "old\n", "new\n"), replace("tests/b.test.ts", "old\n", "new\n"), replace("tests/c.test.ts", null, "new\n")] }, root))
      .rejects.toThrow("TESTING_CHANGE_SET_STALE_DESTINATION:tests/b.test.ts,tests/c.test.ts");
    expect(await readFile(join(root, "tests/a.test.ts"), "utf8")).toBe("old\n");
    await expect(applyTestingChangeSet({ files: [replace("tests/missing.test.ts", "old\n", "new\n")] }, root)).rejects.toThrow("TESTING_CHANGE_SET_STALE_DESTINATION:tests/missing.test.ts");
  });

  it("refuses tampered content, control-plane paths and symbolic links", async () => {
    const outside = await checkout({ "victim.txt": "old\n" });
    const root = await checkout({ "tests/a.test.ts": "old\n" });
    await symlink(outside, join(root, "linked"));
    await expect(applyTestingChangeSet({ files: [{ ...replace("tests/a.test.ts", "old\n", "new\n"), content: "tampered\n" }] }, root)).rejects.toThrow("TESTING_CHANGE_SET_CONTENT_MISMATCH:tests/a.test.ts");
    await expect(applyTestingChangeSet({ files: [replace(".git/hooks/pre-commit", null, "x")] }, root)).rejects.toThrow("CONTROL_PLANE_WRITE_FORBIDDEN");
    await expect(applyTestingChangeSet({ files: [replace("linked/victim.txt", "old\n", "new\n")] }, root)).rejects.toThrow("TESTING_CHANGE_SET_SYMLINK_REFUSED:linked/victim.txt");
    expect(await readFile(join(outside, "victim.txt"), "utf8")).toBe("old\n");
  });
});
