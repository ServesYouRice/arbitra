import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { controlPlaneCore } from "@arbitra/runtime/control-plane-core.js";
import { HTTP_ROUTE_SCHEMAS } from "@arbitra/schemas/http-control-plane";
import { testingOperatorViewSchema, testingVerifiedChangeSetSchema } from "@arbitra/schemas/testing-operator.js";
import { buildServer } from "../src/main.js";
import { registerTestingRoutes, TESTING_ROUTE_INVENTORY } from "../src/routes/testing.js";
import { scriptedRuntime, type ScriptedRuntime } from "../fixtures/scripted-runs.js";

// Real orchestrator, runner, Testing executor and repair; scripted provider and sandbox ports.
let root: string;
let runtime: ScriptedRuntime;
let app: ReturnType<typeof buildServer>;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "arbitra-testing-routes-"));
  runtime = scriptedRuntime(root);
  app = buildServer(controlPlaneCore(runtime.orchestrator));
});
afterAll(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });

const view = async (runId: string) => {
  const response = await app.inject({ method: "GET", url: `/runs/${runId}/testing` });
  expect(response.statusCode, response.body).toBe(200);
  return testingOperatorViewSchema.parse(response.json());
};

// Each case drives complete Testing runs (worktree, writers, sandbox checks), so it needs more than the 5 s default.
describe("Testing operator routes", { timeout: 60_000 }, () => {
  it("registers exactly the schema-backed read-only routes", () => {
    const routes: string[] = [];
    registerTestingRoutes({ route: ({ method, url }) => { routes.push(`${method} ${url}`); } }, { view: async () => null, changeSet: async () => null }, HTTP_ROUTE_SCHEMAS);
    expect(routes).toEqual(TESTING_ROUTE_INVENTORY.map(([method, url]) => `${method} ${url}`));
    expect(TESTING_ROUTE_INVENTORY.every(([method]) => method === "GET")).toBe(true);
    expect(() => registerTestingRoutes({ route() {} }, { view: async () => null, changeSet: async () => null }, {})).toThrow("MISSING_HTTP_SCHEMA:GET /runs/:id/testing");
  });

  it("reviews stored authority next to execution and downloads the exact verified bytes", async () => {
    const run = await runtime.start("testing-pass");
    expect(run.state).toBe("COMPLETED");
    const overview = await view(run.runId);
    expect(overview.configuration).toMatchObject({ mode: "execute", execution: { maximumAttempts: 1, maximumRepairRounds: 3, repairRoundsSource: "default", sandbox: { network: "none" }, authorization: { partitions: [{ id: "tests", paths: ["tests/001.test.ts"] }] } } });
    expect(overview.tasks).toMatchObject([{ taskId: "TASK-001", grant: { partitionId: "tests" }, ledgerState: "completed", executionState: "completed", attempts: [{ ordinal: 1, result: "passed", verification: { status: "passed" } }], finalVerification: { status: "passed" }, stale: false }]);
    expect(overview).toMatchObject({ noWork: false, execution: { passed: true, planMatches: true }, repair: { rounds: [], terminal: null }, handoff: { verifiedChangeSet: { files: 1 } } });
    const response = await app.inject({ method: "GET", url: `/runs/${run.runId}/testing/change-set` });
    expect(response.statusCode, response.body).toBe(200);
    const download = testingVerifiedChangeSetSchema.parse(response.json());
    expect(download.changeSetArtifactId).toBe(overview.handoff.verifiedChangeSet?.changeSetArtifactId);
    expect(download.changeSet.files).toEqual([{ path: "tests/001.test.ts", expectedHash: null, contentHash: createHash("sha256").update("test('001', () => {});\n").digest("hex"), content: "test('001', () => {});\n" }]);
    // The source checkout is untouched: the bytes exist only in the verified handoff.
    await expect(readFile(join(run.repository, "tests/001.test.ts"), "utf8")).rejects.toThrow();
  });

  it("reports failed checks without a handoff", async () => {
    const run = await runtime.start("testing-failed");
    const overview = await view(run.runId);
    expect(overview.execution).toMatchObject({ passed: false, reasons: ["task_attempts_exhausted:TASK-001"] });
    expect(overview.tasks[0]).toMatchObject({ ledgerState: "blocked", attempts: [{ result: "failed", verification: { status: "failed", deterministicFailure: true, checks: [{ checkId: "t001", status: "failed", actualExitCode: 1 }] } }] });
    expect(overview.handoff.verifiedChangeSet).toBeNull();
    const response = await app.inject({ method: "GET", url: `/runs/${run.runId}/testing/change-set` });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ message: "TESTING_VERIFIED_HANDOFF_ABSENT" });
  });

  it("shows bounded repair lineage and exports only the repaired bytes", async () => {
    const run = await runtime.start("testing-repair");
    const overview = await view(run.runId);
    expect(overview.repair.rounds).toMatchObject([{ round: 1, failedTaskIds: ["TASK-001"], reopened: [{ taskId: "TASK-001", causeTaskId: "TASK-001" }], staleTaskIds: ["TASK-002"], state: "reopened" }]);
    const [first, second] = overview.tasks;
    expect(first?.attempts.map(({ result, repairVerificationArtifactId }) => [result, repairVerificationArtifactId !== null])).toEqual([["passed", false], ["passed", true]]);
    expect(second).toMatchObject({ attempts: [{ result: "passed" }], finalVerification: { status: "passed" }, stale: false });
    const download = testingVerifiedChangeSetSchema.parse((await app.inject({ method: "GET", url: `/runs/${run.runId}/testing/change-set` })).json());
    expect(download.changeSet.files.find(({ path }) => path === "tests/001.test.ts")?.content).toBe("test('001 repaired', () => {});\n");
  });

  it("keeps a no-work result explicit and refuses non-Testing runs", async () => {
    const empty = await runtime.start("testing-empty");
    expect(empty.state).toBe("COMPLETED");
    expect(await view(empty.runId)).toMatchObject({ noWork: true, tasks: [], execution: null, planning: { selectedGaps: 0, testsExecuted: false }, handoff: { planArtifactId: null, verifiedChangeSet: null } });
    expect((await app.inject({ method: "GET", url: `/runs/${empty.runId}/testing/change-set` })).statusCode).toBe(404);
    const feature = await runtime.start("feature-blocked");
    expect(feature.state).toBe("BLOCKED");
    const refused = await app.inject({ method: "GET", url: `/runs/${feature.runId}/testing` });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ message: "TESTING_RUN_REQUIRED" });
    expect((await app.inject({ method: "GET", url: "/runs/not%20valid/testing" })).statusCode).toBe(400);
  });

  it("blocks secret-shaped content at the egress guard", async () => {
    const guarded = buildServer({ ...controlPlaneCore(runtime.orchestrator), testing: { view: async () => ({ token: "sk-ant-api03-" + "a".repeat(40) }), changeSet: async () => null } });
    try {
      const response = await guarded.inject({ method: "GET", url: "/runs/run-1/testing" });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ message: "HTTP_SECRET_EGRESS_BLOCKED" });
    } finally { await guarded.close(); }
  });
});
