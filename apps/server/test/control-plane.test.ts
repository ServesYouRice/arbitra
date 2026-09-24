import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertLoopbackHost, buildServer, DEFAULT_SERVER_HOST, startServer } from "../src/main.js";
import { registerControlPlaneRoutes, type ControlPlaneCore } from "../src/routes/control-plane.js";
import { EVALUATION_ROUTE_INVENTORY } from "../src/routes/evaluation.js";
import { TRACE_ROUTE_INVENTORY } from "../src/routes/traces.js";
import { REQUIREMENTS_ROUTE_INVENTORY } from "../src/routes/requirements.js";
import { REPLAY_ROUTE_INVENTORY } from "../src/routes/replay.js";
import { TESTING_ROUTE_INVENTORY } from "../src/routes/testing.js";
import { ROUTE_INVENTORY } from "../src/routes/inventory.js";
import { HTTP_ROUTE_SCHEMAS } from "@arbitra/schemas/http-control-plane";

describe("localhost control plane contracts", () => {
  it("registers every declared schema-backed route, uses localhost and has no websocket surface", async () => {
    const server = fakeServer();
    await startServer(server, core());
    expect(server.routes.map(({ method, url }) => [method, url])).toEqual(ROUTE_INVENTORY);
    expect(server.listenOptions).toEqual({ host: "127.0.0.1", port: 4178 }); expect(DEFAULT_SERVER_HOST).toBe("127.0.0.1");
    expect(JSON.stringify(ROUTE_INVENTORY)).not.toMatch(/websocket|ws:/iu);
    expect(Object.keys(HTTP_ROUTE_SCHEMAS).sort()).toEqual([...ROUTE_INVENTORY, ...EVALUATION_ROUTE_INVENTORY, ...TRACE_ROUTE_INVENTORY, ...REQUIREMENTS_ROUTE_INVENTORY, ...REPLAY_ROUTE_INVENTORY, ...TESTING_ROUTE_INVENTORY].map(([method, url]) => `${method} ${url}`).sort());
    expect(assertLoopbackHost("::1")).toBe("::1");
    expect(() => assertLoopbackHost("0.0.0.0")).toThrow("NON_LOOPBACK_SERVER_HOST");
    await expect(startServer(fakeServer(), core(), HTTP_ROUTE_SCHEMAS, { host: "localhost" })).rejects.toThrow("NON_LOOPBACK_SERVER_HOST");
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
      await writeFile(join(directory, "spoof.json"), JSON.stringify({ id: "other", name: "Spoof", config: value }));
      await expect(store.load("spoof")).rejects.toThrow("CONFIGURATION_ID_MISMATCH:spoof");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("supports lifecycle, SSE, cancellation, artifacts and durable checkpoint responses", async () => {
    const calls: string[] = []; const service = core(calls); const server = fakeServer(); const schemas = Object.fromEntries(ROUTE_INVENTORY.map(([method, url]) => [`${method} ${url}`, {}]));
    registerControlPlaneRoutes(server, service, schemas);
    await invoke(server, "POST", "/repositories/select", { body: { path: "fixture" } }); await invoke(server, "POST", "/estimate", { body: {} }); await invoke(server, "POST", "/runs", { body: {} }); await invoke(server, "GET", "/runs/:id", { params: { id: "run-1" } }); await invoke(server, "POST", "/runs/:id/resume", { params: { id: "run-1" } }); await invoke(server, "GET", "/runs/:id/artifacts", { params: { id: "run-1" } }); await invoke(server, "GET", "/runs/:id/artifacts/:artifactId", { params: { id: "run-1", artifactId: "a-1" } }); await invoke(server, "POST", "/runs/:id/cancel", { params: { id: "run-1" } });
    expect(calls).toEqual(["select", "estimate", "start", "status", "resume", "artifacts", "artifact", "cancel"]);
    // The route holds no checkpoint state: it forwards the versioned body to the shared core.
    expect(await invoke(server, "POST", "/runs/:id/checkpoints/:checkpointId", { params: { id: "run-1", checkpointId: "approval" }, body: { version: "a".repeat(64), decision: "approve" } })).toEqual({ accepted: true });
    expect(calls.at(-1)).toBe(`respond:run-1:approval:${JSON.stringify({ version: "a".repeat(64), decision: "approve" })}`);
    const reply = sseReply(); await invoke(server, "GET", "/runs/:id/events", { params: { id: "run-1" } }, reply); expect(reply.chunks.join("")).toContain('data: {"t":"run_transition","runId":"run-1","state":"COMPLETED"}');
  });

  it("fails closed when core output contains a credential", async () => {
    const server = fakeServer(); const schemas = Object.fromEntries(ROUTE_INVENTORY.map(([method, url]) => [`${method} ${url}`, {}])); const service = core(); service.configurations.list = async () => [{ apiKey: "sk-abcdefghijklmnop" }]; registerControlPlaneRoutes(server, service, schemas);
    await expect(invoke(server, "GET", "/configurations", {})).rejects.toThrow("HTTP_SECRET_EGRESS_BLOCKED");
    for (const secret of ["github_pat_abcdefghijklmnopqrstuvwxyz", "password=abcdefghijklmnop", "-----BEGIN PRIVATE KEY-----\nabcdefghijklmnop\n-----END PRIVATE KEY-----"]) {
      service.configurations.list = async () => [{ value: secret }];
      await expect(invoke(server, "GET", "/configurations", {})).rejects.toThrow("HTTP_SECRET_EGRESS_BLOCKED");
    }
  });

  it("applies the outbound secret guard to SSE frames", async () => {
    const service = core(); service.runs.events = async function* events() { yield { token: "github_pat_abcdefghijklmnopqrstuvwxyz" }; };
    const server = fakeServer(); registerControlPlaneRoutes(server, service, HTTP_ROUTE_SCHEMAS);
    const reply = sseReply();
    await expect(invoke(server, "GET", "/runs/:id/events", { params: { id: "run-secret" } }, reply)).rejects.toThrow("HTTP_SECRET_EGRESS_BLOCKED");
    expect(reply.chunks.join("")).not.toContain("github_pat_");
  });

  it("serves the route inventory through a real Fastify instance", async () => {
    const app = buildServer(core());
    const response = await app.inject({ method: "GET", url: "/configurations" });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual([]);
    const invalid = await app.inject({ method: "POST", url: "/configurations", payload: { name: "Invalid", config: { mode: "audit" } } });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });

  it("blocks off-host browser requests and secrets in error responses", async () => {
    const service = core();
    const app = buildServer(service);
    try {
      expect((await app.inject({ method: "GET", url: "/configurations", headers: { host: "attacker.example" } })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/runs/run-1/cancel", headers: { origin: "https://attacker.example" } })).statusCode).toBe(403);
      service.configurations.list = async () => { throw new Error("upstream key sk-abcdefghijklmnop failed"); };
      const response = await app.inject({ method: "GET", url: "/configurations" });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain("sk-abcdefghijklmnop");
      expect(response.body).toContain("HTTP_SECRET_EGRESS_BLOCKED");
    } finally { await app.close(); }
  });

  it("keeps the event loop responsive while a large SSE stream is active", async () => {
    const service = core(); service.runs.events = async function* events(id) { for (let index = 0; index < 500; index += 1) yield { t: "node_completed", runId: id, nodeId: `node-${index}` }; };
    const server = fakeServer(); registerControlPlaneRoutes(server, service, HTTP_ROUTE_SCHEMAS);
    let timerRan = false; setImmediate(() => { timerRan = true; });
    const reply = sseReply(); await invoke(server, "GET", "/runs/:id/events", { params: { id: "run-heavy" } }, reply);
    expect(timerRan).toBe(true); expect(reply.chunks.filter((chunk) => chunk.startsWith("data:"))).toHaveLength(500);
    expect(reply.chunks.at(-1)).toBe("event: end\ndata: {}\n\n");
  });
});

function core(calls: string[] = []): ControlPlaneCore { return { configurations: { async list() { return []; }, async save() { return {}; }, async load() { return {}; }, async update() { return {}; }, async duplicate() { return {}; }, validate() { return {}; }, async export() { return {}; } }, repositories: { async select() { calls.push("select"); return {}; } }, runs: { async estimate() { calls.push("estimate"); return {}; }, async start() { calls.push("start"); return {}; }, async status() { calls.push("status"); return {}; }, async resume() { calls.push("resume"); return {}; }, async *events(id) { yield { t: "run_transition", runId: id, state: "COMPLETED" }; }, async cancel() { calls.push("cancel"); return {}; }, async respondCheckpoint(id, checkpointId, body) { calls.push(`respond:${id}:${checkpointId}:${JSON.stringify(body)}`); return { accepted: true }; }, async artifacts() { calls.push("artifacts"); return []; }, async artifact() { calls.push("artifact"); return {}; } } }; }
function fakeServer() { const server = { routes: [] as Array<{ method: string; url: string; schema: unknown; handler: (request: never, reply: never) => unknown }>, listenOptions: null as null | { host: string; port: number }, route(options: never) { server.routes.push(options); }, async listen(options: { host: string; port: number }) { server.listenOptions = options; } }; return server; }
async function invoke(server: ReturnType<typeof fakeServer>, method: string, url: string, request: object, reply: unknown = {}): Promise<unknown> { const route = server.routes.find((candidate) => candidate.method === method && candidate.url === url); if (route === undefined) throw new Error("route missing"); return route.handler(request as never, reply as never); }
function sseReply() { const chunks: string[] = []; return { chunks, header() {}, raw: { write(chunk: string) { chunks.push(chunk); return true; }, end() {}, on() {} } }; }
async function configStoreModule(): Promise<{ ConfigStore: new <T>(directory: string, schema: { parse(value: unknown): T }, id: () => string) => { save(name: string, value: unknown): Promise<{ id: string; name: string; config: T }>; load(id: string): Promise<{ id: string; name: string; config: T }>; duplicate(id: string, name: string): Promise<{ config: T }>; export(id: string): Promise<string>; validate(value: unknown): T } }> { const moduleUrl = new URL("../../../packages/core/src/config/config-store.ts", import.meta.url).href; return await import(moduleUrl) as never; }
