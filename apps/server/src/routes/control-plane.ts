import { ROUTE_INVENTORY } from "./inventory.js";
import { redactSecrets } from "@arbitra/security/redaction";
import { streamSse, type SseReply } from "../sse.js";

type Handler = (request: { body?: unknown; params?: Record<string, string>; query?: unknown }, reply: unknown) => Promise<unknown> | unknown;
export interface RouteServer { route(options: { method: string; url: string; schema: unknown; handler: Handler }): void }
export interface HttpSchemas { readonly [route: string]: unknown }
export interface ControlPlaneCore {
  configurations: { list(): Promise<unknown>; save(body: unknown): Promise<unknown>; load(id: string): Promise<unknown>; update(id: string, body: unknown): Promise<unknown>; duplicate(id: string, body: unknown): Promise<unknown>; validate(body: unknown): unknown; export(id: string): Promise<unknown> };
  repositories: { select(body: unknown): Promise<unknown> };
  runs: { estimate(body: unknown): Promise<unknown>; start(body: unknown): Promise<unknown>; status(id: string): Promise<unknown>; resume(id: string): Promise<unknown>; events(id: string): AsyncIterable<unknown>; cancel(id: string): Promise<unknown>; respondCheckpoint(id: string, checkpointId: string, body: unknown): Promise<unknown>; artifacts(id: string): Promise<unknown>; artifact(id: string, artifactId: string): Promise<unknown> };
}

export function registerControlPlaneRoutes(server: RouteServer, core: ControlPlaneCore, schemas: HttpSchemas): void {
  const route = (method: string, url: string, handler: Handler): void => { const schema = schemas[`${method} ${url}`]; if (schema === undefined) throw new Error(`MISSING_HTTP_SCHEMA:${method} ${url}`); server.route({ method, url, schema, handler: redactHandler(handler) }); };
  route("GET", "/configurations", () => core.configurations.list());
  route("POST", "/configurations", ({ body }) => core.configurations.save(body));
  route("GET", "/configurations/:id", ({ params }) => core.configurations.load(required(params, "id")));
  route("PUT", "/configurations/:id", ({ params, body }) => core.configurations.update(required(params, "id"), body));
  route("POST", "/configurations/:id/duplicate", ({ params, body }) => core.configurations.duplicate(required(params, "id"), body));
  route("POST", "/configurations/validate", ({ body }) => core.configurations.validate(body));
  route("GET", "/configurations/:id/export", ({ params }) => core.configurations.export(required(params, "id")));
  route("POST", "/repositories/select", ({ body }) => core.repositories.select(body));
  route("POST", "/estimate", ({ body }) => core.runs.estimate(body));
  route("POST", "/runs", ({ body }) => core.runs.start(body));
  route("GET", "/runs/:id", ({ params }) => core.runs.status(required(params, "id")));
  route("POST", "/runs/:id/resume", ({ params }) => core.runs.resume(required(params, "id")));
  route("GET", "/runs/:id/events", async ({ params }, reply) => streamSse(reply as SseReply, guardedEvents(core.runs.events(required(params, "id")))));
  route("POST", "/runs/:id/cancel", ({ params }) => core.runs.cancel(required(params, "id")));
  // Generic human checkpoints are durable run state owned by the orchestrator; the route
  // forwards the versioned decision and keeps no checkpoint state of its own.
  route("POST", "/runs/:id/checkpoints/:checkpointId", ({ params, body }) => core.runs.respondCheckpoint(required(params, "id"), required(params, "checkpointId"), body));
  route("GET", "/runs/:id/artifacts", ({ params }) => core.runs.artifacts(required(params, "id")));
  route("GET", "/runs/:id/artifacts/:artifactId", ({ params }) => core.runs.artifact(required(params, "id"), required(params, "artifactId")));
  if (ROUTE_INVENTORY.length !== 17) throw new Error("ROUTE_INVENTORY_INCOMPLETE");
}

function required(params: Record<string, string> | undefined, key: string): string { const value = params?.[key]; if (value === undefined || value === "") throw new Error(`MISSING_ROUTE_PARAMETER:${key}`); return value; }
function redactHandler(handler: Handler): Handler { return async (request, reply) => assertNoSecretEgress(await handler(request, reply)); }
/** The single outbound secret guard for every localhost route; evaluation routes reuse it rather than defining a second pattern set. */
export function assertNoSecretEgress<T>(value: T): T {
  const encoded = JSON.stringify(value, (_key, child: unknown) => {
    if (typeof child === "string" && redactSecrets(child).redactions.length > 0) throw new Error("HTTP_SECRET_EGRESS_BLOCKED");
    return child;
  });
  if (encoded !== undefined && redactSecrets(encoded).redactions.length > 0) throw new Error("HTTP_SECRET_EGRESS_BLOCKED");
  return value;
}

async function* guardedEvents(events: AsyncIterable<unknown>): AsyncIterable<unknown> {
  for await (const event of events) yield assertNoSecretEgress(event);
}
