import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CheckpointRegistry } from "../src/checkpoints.js";
import { buildServer, DEFAULT_SERVER_HOST, startServer } from "../src/main.js";
import { registerControlPlaneRoutes, type ControlPlaneCore } from "../src/routes/control-plane.js";
import { EVALUATION_ROUTE_INVENTORY } from "../src/routes/evaluation.js";
import { ROUTE_INVENTORY } from "../src/routes/inventory.js";
import { HTTP_ROUTE_SCHEMAS } from "@arbitra/schemas/http-control-plane";

describe("localhost control plane contracts", () => {
  it("registers every declared schema-backed route, uses localhost and has no websocket surface", async () => {
    const server = fakeServer();
    await startServer(server, core());
    expect(server.routes.map(({ method, url }) => [method, url])).toEqual(ROUTE_INVENTORY);
    expect(server.listenOptions).toEqual({ host: "127.0.0.1", port: 4178 }); expect(DEFAULT_SERVER_HOST).toBe("127.0.0.1");
    expect(JSON.stringify(ROUTE_INVENTORY)).not.toMatch(/websocket|ws:/iu);
    expect(Object.keys(HTTP_ROUTE_SCHEMAS).sort()).toEqual([...ROUTE_INVENTORY, ...EVALUATION_ROUTE_INVENTORY].map(([method, url]) => `${method} ${url}`).sort());
  });

  it("round-trips canonical configurations byte-stably and rejects resolved credentials", async () => {
    const { ConfigStore } = await configStoreModule();
    const directory = await mkdtemp(join(tmpdir(), "arbitra-config-")); let next = 0;
    try {
      const store = new ConfigStore(directory, { parse(value) { if (typeof value !== "object" || value === null) throw new Error("invalid"); return value as Record<string, unknown>; } }, () => `id-${++next}`);
      const value = { models: { primary: { credentialEnvVar: "OPENAI_API_KEY", provider: "openai" } }, mode: "audit" };
      const saved = await store.save("Default", value); expect(await store.load(saved.id)).toEqual(saved);
      const duplicate = await store.duplicate(saved.id, "Copy"); expect(duplicate.config).toEqual(value);
      expect(await store.export(saved.id)).toBe('{"mode":"audit","models":{"primary":{"credentialEnvVar":"OPENAI_API_KEY","provider":"openai"}}}\n');
      expect(await readFile(join(directory, `${saved.id}.json`), "utf8")).not.toContain("resolved-secret");
      expect(() => store.validate({ apiKey: "sk-this-must-never-persist" })).toThrow("RESOLVED_CREDENTIAL_FORBIDDEN");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("supports lifecycle, SSE, cancellation, artifacts and interactive checkpoints", async () => {
    const calls: string[] = []; const service = core(calls); const server = fakeServer(); const schemas = Object.fromEntries(ROUTE_INVENTORY.map(([method, url]) => [`${method} ${url}`, {}])); const checkpoints = new CheckpointRegistry();
    registerControlPlaneRoutes(server, service, checkpoints, schemas);
    await invoke(server, "POST", "/repositories/select", { body: { path: "fixture" } }); await invoke(server, "POST", "/estimate", { body: {} }); await invoke(server, "POST", "/runs", { body: {} }); await invoke(server, "GET", "/runs/:id", { params: { id: "run-1" } }); await invoke(server, "POST", "/runs/:id/resume", { params: { id: "run-1" } }); await invoke(server, "GET", "/runs/:id/artifacts", { params: { id: "run-1" } }); await invoke(server, "GET", "/runs/:id/artifacts/:artifactId", { params: { id: "run-1", artifactId: "a-1" } }); await invoke(server, "POST", "/runs/:id/cancel", { params: { id: "run-1" } });
    expect(calls).toEqual(["select", "estimate", "start", "status", "resume", "artifacts", "artifact", "cancel"]);
    const waiting = checkpoints.wait("run-1", "interactive", { id: "cp-1", stage: "before_planning", prompt: "Proceed?" }); expect(checkpoints.list("run-1")).toHaveLength(1); checkpoints.respond("run-1", "cp-1", "continue"); expect(await waiting).toBe("continue"); expect(await checkpoints.wait("run-2", "automatic", { id: "cp-2", stage: "before_planning", prompt: "Proceed?" })).toBeNull();
    const reply = sseReply(); await invoke(server, "GET", "/runs/:id/events", { params: { id: "run-1" } }, reply); expect(reply.chunks.join("")).toContain('data: {"t":"run_transition","runId":"run-1","state":"COMPLETED"}');
  });

  it("fails closed when core output contains a credential", async () => {
    const server = fakeServer(); const schemas = Object.fromEntries(ROUTE_INVENTORY.map(([method, url]) => [`${method} ${url}`, {}])); const service = core(); service.configurations.list = async () => [{ apiKey: "sk-abcdefghijklmnop" }]; registerControlPlaneRoutes(server, service, new CheckpointRegistry(), schemas);
    await expect(invoke(server, "GET", "/configurations", {})).rejects.toThrow("HTTP_SECRET_EGRESS_BLOCKED");
  });

  it("serves the route inventory through a real Fastify instance", async () => {
    const app = buildServer(core());
    const response = await app.inject({ method: "GET", url: "/configurations" });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual([]);
    const invalid = await app.inject({ method: "POST", url: "/configurations", payload: { name: "Invalid", config: { mode: "audit" } } });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });

  it("keeps the event loop responsive while a large SSE stream is active", async () => {
    const service = core(); service.runs.events = async function* events(id) { for (let index = 0; index < 500; index += 1) yield { t: "node_completed", runId: id, nodeId: `node-${index}` }; };
    const server = fakeServer(); registerControlPlaneRoutes(server, service, new CheckpointRegistry(), HTTP_ROUTE_SCHEMAS);
    let timerRan = false; setImmediate(() => { timerRan = true; });
    const reply = sseReply(); await invoke(server, "GET", "/runs/:id/events", { params: { id: "run-heavy" } }, reply);
    expect(timerRan).toBe(true); expect(reply.chunks).toHaveLength(500);
  });
});

function core(calls: string[] = []): ControlPlaneCore { return { configurations: { async list() { return []; }, async save() { return {}; }, async load() { return {}; }, async update() { return {}; }, async duplicate() { return {}; }, validate() { return {}; }, async export() { return {}; } }, repositories: { async select() { calls.push("select"); return {}; } }, runs: { async estimate() { calls.push("estimate"); return {}; }, async start() { calls.push("start"); return {}; }, async status() { calls.push("status"); return {}; }, async resume() { calls.push("resume"); return {}; }, async *events(id) { yield { t: "run_transition", runId: id, state: "COMPLETED" }; }, async cancel() { calls.push("cancel"); return {}; }, async artifacts() { calls.push("artifacts"); return []; }, async artifact() { calls.push("artifact"); return {}; } } }; }
function fakeServer() { const server = { routes: [] as Array<{ method: string; url: string; schema: unknown; handler: (request: never, reply: never) => unknown }>, listenOptions: null as null | { host: string; port: number }, route(options: never) { server.routes.push(options); }, async listen(options: { host: string; port: number }) { server.listenOptions = options; } }; return server; }
async function invoke(server: ReturnType<typeof fakeServer>, method: string, url: string, request: object, reply: unknown = {}): Promise<unknown> { const route = server.routes.find((candidate) => candidate.method === method && candidate.url === url); if (route === undefined) throw new Error("route missing"); return route.handler(request as never, reply as never); }
function sseReply() { const chunks: string[] = []; return { chunks, header() {}, raw: { write(chunk: string) { chunks.push(chunk); return true; }, end() {}, on() {} } }; }
async function configStoreModule(): Promise<{ ConfigStore: new <T>(directory: string, schema: { parse(value: unknown): T }, id: () => string) => { save(name: string, value: unknown): Promise<{ id: string; name: string; config: T }>; load(id: string): Promise<{ id: string; name: string; config: T }>; duplicate(id: string, name: string): Promise<{ config: T }>; export(id: string): Promise<string>; validate(value: unknown): T } }> { const moduleUrl = new URL("../../../packages/core/src/config/config-store.ts", import.meta.url).href; return await import(moduleUrl) as never; }
