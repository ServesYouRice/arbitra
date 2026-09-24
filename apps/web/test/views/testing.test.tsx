// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestingOperatorView } from "@arbitra/schemas/testing-operator.js";
import type { RunResource } from "../../src/api/runs.js";
import { TestingView } from "../../src/views/testing/TestingView.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const hash = (character: string) => character.repeat(64);
const check = (status: "passed" | "failed", exit: number) => ({ command: "npm run test:001", checkId: "t001", executionId: "exec", status, expectedExitCode: 0, actualExitCode: exit });
const verification = (status: "passed" | "failed", id: string) => ({ artifactId: id, attemptId: id, status, deterministicFailure: status === "failed", reasons: [], checks: [check(status, status === "passed" ? 0 : 1)], snapshotFingerprint: hash("c") });
const view: TestingOperatorView = {
  runId: "run-1", runState: "COMPLETED",
  configuration: { mode: "execute", goal: "Protect sessions", roles: { analyst: "analyst", planner: "planner" }, commands: [], execution: {
    authorization: { maximumParallelTasks: 1, partitions: [{ id: "tests", paths: ["tests/001.test.ts", "tests/002.test.ts"] }], tasks: [{ taskId: "TASK-001", partitionId: "tests", exclusive: false }, { taskId: "TASK-002", partitionId: "tests", exclusive: true }] },
    models: { fast: "m", balanced: "m", frontier: "m" }, maximumAttempts: 2, maximumRepairRounds: 2, repairRoundsSource: "configured",
    sandbox: { driver: "docker", image: `local/node@sha256:${hash("a")}`, maximumRuns: 12, timeoutMs: 30000, network: "none" },
    checks: [{ id: "t001", executable: "/usr/bin/node", arguments: ["--test", "tests/001.test.ts"], sourcePaths: ["tests/001.test.ts"] }],
    bindings: [{ command: "npm run test:001", checkId: "t001", expectedExitCode: 0, authorization: "repository_script" }] } },
  planning: { passed: true, reasons: [], selectedGaps: 1, testsExecuted: false, planFingerprint: hash("b") }, noWork: false,
  tasks: [{ taskId: "TASK-001", title: "Session <b>regression</b>", capability: "frontier", writeScope: ["tests/001.test.ts"], dependsOn: [], commands: [{ command: "npm run test:001", executionPolicy: "derived_repository_script" }],
    grant: { partitionId: "tests", exclusive: false, paths: ["tests/001.test.ts"] }, ledgerState: "completed", executionState: "completed",
    attempts: [{ attemptId: "TASK-001/attempt-1", ordinal: 1, capability: "frontier", state: "verified", result: "passed", repairVerificationArtifactId: null, verification: verification("passed", "v1") },
      { attemptId: "TASK-001/attempt-2", ordinal: 2, capability: "frontier", state: "verified", result: "passed", repairVerificationArtifactId: "final-fail", verification: verification("passed", "v2") }],
    finalVerification: verification("passed", "final-pass"), stale: false }],
  execution: { passed: true, reasons: [], planFingerprint: hash("b"), snapshotFingerprint: hash("c"), planMatches: true },
  repair: { rounds: [{ round: 1, snapshotFingerprint: hash("d"), failedTaskIds: ["TASK-001"], reopened: [{ taskId: "TASK-001", causeTaskId: "TASK-001", verificationArtifactId: "final-fail" }], staleTaskIds: ["TASK-002"], state: "reopened" }], terminal: null },
  handoff: { planArtifactId: "implementation-1", verifiedChangeSet: { completionArtifactId: "completion", changeSetArtifactId: "change-set", files: 1 } },
};
const run: RunResource = { runId: "run-1", state: "COMPLETED", resumable: false, checkpoints: [], workflow: { id: "testing-execute", nodes: [], edges: [] } };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

describe("Testing execution view", () => {
  it("reviews authority, plan versus execution, attempts, repair and the verified change set", async () => {
    const downloads: string[] = [];
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:fixture", revokeObjectURL: () => undefined }));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this.download); });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/runs/run-1/testing") return json(view);
      if (path === "/runs/run-1/testing/change-set") return json({ runId: "run-1", completionArtifactId: "completion", changeSetArtifactId: "change-set", changeSet: { schemaVersion: 1, planFingerprint: hash("b"), baselineFingerprint: hash("e"), snapshotFingerprint: hash("c"), verificationArtifactIds: ["final-pass"], files: [{ path: "tests/001.test.ts", expectedHash: null, contentHash: hash("f"), content: "<script>window.__testingInjected=1</script>" }] } });
      return json({}, 404);
    });
    render(<TestingView runId="run-1" run={run} artifacts={[]} />);
    const partitions = await screen.findByLabelText("write partitions");
    expect(partitions.textContent).toContain("TASK-002 (exclusive)");
    expect(screen.getByText("2 · configured")).toBeTruthy();
    expect(screen.getByLabelText("check bindings").textContent).toContain("/usr/bin/node --test tests/001.test.ts");
    const table = screen.getByLabelText("task plan versus execution");
    expect(within(table).getByText("TASK-001 · Session <b>regression</b>")).toBeTruthy();
    expect(table.querySelector("b")).toBeNull();
    expect(table.textContent).toContain("2 of 2");
    expect(screen.getByLabelText("repair rounds").textContent).toContain("round 1 · reopened · invalidated snapshot dddddddddddd · failed TASK-001 · reopened TASK-001 · stale TASK-002");
    expect(screen.getByText("attempt 2 · frontier · passed · repair of final-fail")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "download verified change set" }));
    expect(await screen.findByLabelText("verified files")).toBeTruthy();
    expect(screen.getByText("<script>window.__testingInjected=1</script>").tagName).toBe("PRE");
    expect(downloads).toEqual(["run-1-verified-change-set.json"]);
  });

  it("keeps no work explicit and never claims coverage", async () => {
    vi.stubGlobal("fetch", async () => json({ ...view, noWork: true, tasks: [], execution: null, repair: { rounds: [], terminal: null }, planning: { ...view.planning, selectedGaps: 0 }, handoff: { planArtifactId: null, verifiedChangeSet: null } }));
    render(<TestingView runId="run-1" run={run} artifacts={[]} />);
    expect(await screen.findByText("no work · analysis selected no gaps, so nothing was written or executed · this is not evidence of test coverage")).toBeTruthy();
    expect(screen.getByText("no verified change set · no work was selected")).toBeTruthy();
    expect(screen.queryByLabelText("task plan versus execution")).toBeNull();
  });

  it("reports failed checks and a stopped repair", async () => {
    const failed = { ...view, execution: { ...view.execution, passed: false, reasons: ["final_verification_failed:TASK-001", "repair_oscillation"] }, repair: { ...view.repair, terminal: { reason: "repair_oscillation", snapshotFingerprint: hash("d") } }, handoff: { planArtifactId: null, verifiedChangeSet: null },
      tasks: view.tasks.map((task) => ({ ...task, ledgerState: "blocked" as const, stale: true, finalVerification: verification("failed", "final-fail") })) } as TestingOperatorView;
    vi.stubGlobal("fetch", async () => json(failed));
    render(<TestingView runId="run-1" run={run} artifacts={[]} />);
    expect(await screen.findByText("repair stopped · repair_oscillation")).toBeTruthy();
    expect(screen.getByText("execution · failed · final_verification_failed:TASK-001, repair_oscillation")).toBeTruthy();
    expect(screen.getByText("blocked · stale").getAttribute("data-state")).toBe("degraded");
    expect(screen.getByText("no verified change set · withheld until fresh final verification passes")).toBeTruthy();
  });
});
