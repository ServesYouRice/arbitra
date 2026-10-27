import { expect, it } from "vitest";
import { buildServer, type ServerCore } from "../src/main.js";
import { INCREMENTAL_ROUTE_INVENTORY } from "../src/routes/incremental.js";
import { HTTP_ROUTE_SCHEMAS } from "@arbitra/schemas/http-control-plane";

it("accepts an explicit incremental base on POST /runs, serves the incremental report, and starts one from a run", async () => {
  const started: unknown[] = [];
  const reports: string[] = [];
  const bases: string[] = [];
  const none = async () => ({});
  const core: ServerCore = {
    configurations: { list: async () => [], save: none, load: none, update: none, duplicate: none, validate: () => ({}), export: none },
    repositories: { select: none, selected: none },
    runs: { list: async () => [], overview: none, estimate: none, preflight: none, async start(body) { started.push(body); return { runId: "run-2" }; }, status: none, resume: none, async *events() { /* none */ }, cancel: none, respondCheckpoint: none, artifacts: async () => [], artifact: none },
    incremental: {
      async report(runId) { reports.push(runId); if (runId === "run-absent") throw Object.assign(new Error("INCREMENTAL_CONTRACT_ABSENT:run-absent"), { statusCode: 404 }); return { baseRunId: "run-1", strategy: "incremental" }; },
      async start(baseRunId) { bases.push(baseRunId); if (baseRunId === "run-scripted") throw Object.assign(new Error("INCREMENTAL_BASE_MODE_MISMATCH:scripted_audit"), { statusCode: 409 }); return { runId: "run-3", state: "CREATED" }; },
    },
  };
  expect(INCREMENTAL_ROUTE_INVENTORY.every(([method, url]) => `${method} ${url}` in HTTP_ROUTE_SCHEMAS)).toBe(true);
  const app = buildServer(core);
  try {
    const accepted = await app.inject({ method: "POST", url: "/runs", payload: { configurationId: "config-1", incremental: { baseRunId: "run-1" } } });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(started).toEqual([{ configurationId: "config-1", incremental: { baseRunId: "run-1" } }]);
    for (const incremental of [{ baseRunId: "../escape" }, { baseRunId: "run-1", extra: true }, {}]) {
      expect((await app.inject({ method: "POST", url: "/runs", payload: { configurationId: "config-1", incremental } })).statusCode).toBe(400);
    }
    expect(started).toHaveLength(1);
    const report = await app.inject({ method: "GET", url: "/runs/run-2/incremental" });
    expect(report.json()).toEqual({ baseRunId: "run-1", strategy: "incremental" });
    expect((await app.inject({ method: "GET", url: "/runs/run-absent/incremental" })).statusCode).toBe(404);
    expect(reports).toEqual(["run-2", "run-absent"]);
    // A bodiless POST starts a new audit with the run as its base, as the web UI sends it.
    const fromRun = await app.inject({ method: "POST", url: "/runs/run-1/incremental" });
    expect(fromRun.statusCode, fromRun.body).toBe(200);
    expect(fromRun.json()).toEqual({ runId: "run-3", state: "CREATED" });
    expect((await app.inject({ method: "POST", url: "/runs/run-scripted/incremental" })).json()).toMatchObject({ statusCode: 409, message: "INCREMENTAL_BASE_MODE_MISMATCH:scripted_audit" });
    expect((await app.inject({ method: "POST", url: "/runs/..%2Fescape/incremental" })).statusCode).toBe(400);
    expect(bases).toEqual(["run-1", "run-scripted"]);
  } finally { await app.close(); }
});
