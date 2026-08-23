import { describe, expect, it } from "vitest";
import { HTTP_ROUTE_SCHEMAS } from "@arbitra/schemas/http-control-plane";
import { buildServer } from "../src/main.js";
import type { ControlPlaneCore } from "../src/routes/control-plane.js";
import { aggregationRefusal, EVALUATION_ROUTE_INVENTORY, registerEvaluationRoutes, type EvaluationCore } from "../src/routes/evaluation.js";

describe("evaluation routes over the guarded query layer", () => {
  it("declares both routes with canonical schemas and registers nothing else", () => {
    const server = fakeServer();
    registerEvaluationRoutes(server, evaluationCore(), HTTP_ROUTE_SCHEMAS);
    expect(server.routes.map(({ method, url }) => [method, url])).toEqual(EVALUATION_ROUTE_INVENTORY.map((route) => [...route]));
    for (const [method, url] of EVALUATION_ROUTE_INVENTORY) expect(HTTP_ROUTE_SCHEMAS[`${method} ${url}` as keyof typeof HTTP_ROUTE_SCHEMAS]).toBeDefined();
    expect(server.routes.every(({ schema }) => schema !== undefined)).toBe(true);
  });

  it("refuses to register a route the canonical schema set does not declare", () => {
    expect(() => registerEvaluationRoutes(fakeServer(), evaluationCore(), {})).toThrow("MISSING_HTTP_SCHEMA:GET /runs/:id/metrics");
  });

  it("passes the run identifier through and returns the query layer result unchanged", async () => {
    const calls: string[] = []; const server = fakeServer();
    registerEvaluationRoutes(server, evaluationCore(calls), HTTP_ROUTE_SCHEMAS);
    expect(await invoke(server, "GET", "/runs/:id/metrics", { params: { id: "run-1" } })).toMatchObject({ rows: [{ modelIdentity: "model-a", recall: null }] });
    expect(calls).toEqual(["metrics:run-1"]);
    await expect(invoke(server, "GET", "/runs/:id/metrics", { params: {} })).rejects.toThrow("MISSING_ROUTE_PARAMETER:id");
  });

  it("answers a cross-protocol comparison with the query layer refusal rather than a computed result", async () => {
    const server = fakeServer();
    const core: EvaluationCore = { async metrics() { return {}; }, async compare() { throw new Error("CROSS_PROTOCOL_COMPARISON_REFUSED: audit@1.0.0 and audit@2.0.0 are different protocol identities; metrics recorded under different protocol versions are not comparable"); } };
    registerEvaluationRoutes(server, core, HTTP_ROUTE_SCHEMAS);
    const reply = fakeReply();
    await invoke(server, "POST", "/runs/compare", { body: { a: { protocolIdentity: "audit@1.0.0" }, b: { protocolIdentity: "audit@2.0.0" } } }, reply);
    expect(reply.status).toBe(409);
    expect(reply.payload).toMatchObject({ error: "CROSS_PROTOCOL_COMPARISON_REFUSED", comparable: false });
    expect(String((reply.payload as { message: string }).message)).toContain("are different protocol identities");
  });

  it("answers an incomparable identity mix with the same refusal shape", async () => {
    const server = fakeServer();
    const core: EvaluationCore = { async metrics() { throw new Error("INCOMPARABLE_IDENTITY_MIX:protocol: group by protocol or narrow the filter"); }, async compare() { return {}; } };
    registerEvaluationRoutes(server, core, HTTP_ROUTE_SCHEMAS);
    const reply = fakeReply();
    await invoke(server, "GET", "/runs/:id/metrics", { params: { id: "run-1" } }, reply);
    expect(reply.status).toBe(409);
    expect(reply.payload).toMatchObject({ error: "INCOMPARABLE_IDENTITY_MIX", comparable: false });
  });

  it("does not convert an unrelated failure into a refusal", async () => {
    const server = fakeServer();
    const core: EvaluationCore = { async metrics() { throw new Error("DISK_FAILURE"); }, async compare() { return {}; } };
    registerEvaluationRoutes(server, core, HTTP_ROUTE_SCHEMAS);
    await expect(invoke(server, "GET", "/runs/:id/metrics", { params: { id: "run-1" } }, fakeReply())).rejects.toThrow("DISK_FAILURE");
    expect(aggregationRefusal(new Error("DISK_FAILURE"))).toBeNull();
  });

  it("applies the same outbound secret guard as the control plane", async () => {
    const server = fakeServer();
    const core: EvaluationCore = { async metrics() { return { rows: [{ apiKey: "sk-abcdefghijklmnop" }] }; }, async compare() { return {}; } };
    registerEvaluationRoutes(server, core, HTTP_ROUTE_SCHEMAS);
    await expect(invoke(server, "GET", "/runs/:id/metrics", { params: { id: "run-1" } }, fakeReply())).rejects.toThrow("HTTP_SECRET_EGRESS_BLOCKED");
  });

  it("requires both comparison sides", async () => {
    const server = fakeServer();
    registerEvaluationRoutes(server, evaluationCore(), HTTP_ROUTE_SCHEMAS);
    await expect(invoke(server, "POST", "/runs/compare", { body: { a: { protocolIdentity: "audit@1.0.0" } } })).rejects.toThrow("COMPARISON_SIDES_REQUIRED");
  });

  it("serves both routes through a real Fastify instance and omits them when no metric store is wired", async () => {
    const app = buildServer({ ...controlPlaneCore(), evaluation: evaluationCore() });
    const metrics = await app.inject({ method: "GET", url: "/runs/run-1/metrics" });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.json()).toMatchObject({ rows: [{ modelIdentity: "model-a" }] });
    const invalid = await app.inject({ method: "POST", url: "/runs/compare", payload: { a: { protocolIdentity: "" }, b: { protocolIdentity: "audit@1.0.0" } } });
    expect(invalid.statusCode).toBe(400);
    await app.close();
    const bare = buildServer(controlPlaneCore());
    expect((await bare.inject({ method: "GET", url: "/runs/run-1/metrics" })).statusCode).toBe(404);
    await bare.close();
  });
});

function evaluationCore(calls: string[] = []): EvaluationCore {
  return {
    async metrics(runId) { calls.push(`metrics:${runId}`); return { rows: [{ modelIdentity: "model-a", recall: null, precision: null, costUsd: 0.01 }], denominator: { activityCount: 1, auditorCount: 0, groundTruthAvailable: false }, segmentation: ["model"], independence: { applicable: false, reason: "no_ground_truth_measurement", groups: [] } }; },
    async compare(request) { calls.push("compare"); return { comparable: true, protocolIdentity: (request.a as { protocolIdentity: string }).protocolIdentity, sides: [] }; },
  };
}
function controlPlaneCore(): ControlPlaneCore { return { configurations: { async list() { return []; }, async save() { return {}; }, async load() { return {}; }, async update() { return {}; }, async duplicate() { return {}; }, validate() { return {}; }, async export() { return {}; } }, repositories: { async select() { return {}; } }, runs: { async estimate() { return {}; }, async start() { return {}; }, async status() { return {}; }, async resume() { return {}; }, async *events() { yield {}; }, async cancel() { return {}; }, async artifacts() { return []; }, async artifact() { return {}; } } }; }
function fakeServer() { const server = { routes: [] as Array<{ method: string; url: string; schema: unknown; handler: (request: never, reply: never) => unknown }>, route(options: never) { server.routes.push(options); } }; return server; }
function fakeReply() { const reply = { status: 200, payload: null as unknown, code(status: number) { reply.status = status; return reply; }, send(payload: unknown) { reply.payload = payload; return payload; } }; return reply; }
async function invoke(server: ReturnType<typeof fakeServer>, method: string, url: string, request: object, reply: unknown = {}): Promise<unknown> { const route = server.routes.find((candidate) => candidate.method === method && candidate.url === url); if (route === undefined) throw new Error("route missing"); return route.handler(request as never, reply as never); }
