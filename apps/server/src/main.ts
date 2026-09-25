import Fastify, { type FastifyInstance, type RouteOptions } from "fastify";
import { HTTP_ROUTE_SCHEMAS } from "@arbitra/schemas/http-control-plane";
import { redactSecrets } from "@arbitra/security/redaction";
import { registerControlPlaneRoutes, type ControlPlaneCore, type HttpSchemas, type RouteServer } from "./routes/control-plane.js";
import { registerEvaluationRoutes, type EvaluationCore } from "./routes/evaluation.js";
import { registerTraceRoutes, type TraceCore } from "./routes/traces.js";
import { registerRequirementsRoutes, type RequirementsCore } from "./routes/requirements.js";
import { registerReplayRoutes, type ReplayCore } from "./routes/replay.js";
import { registerTestingRoutes, type TestingCore } from "./routes/testing.js";
import { registerIncrementalRoutes, type IncrementalCore } from "./routes/incremental.js";
import { registerWorkflowRoutes, type WorkflowGraphCore } from "./routes/workflows.js";
import { registerBatchRoutes, type BatchCore } from "./routes/batches.js";

export const DEFAULT_SERVER_HOST = "127.0.0.1" as const;
export const DEFAULT_SERVER_PORT = 4178 as const;
export type LoopbackHost = typeof DEFAULT_SERVER_HOST | "::1";

/** This server has no authentication boundary, so it must never bind off-loopback. */
export function assertLoopbackHost(host: string): LoopbackHost {
  if (host !== DEFAULT_SERVER_HOST && host !== "::1") throw new Error(`NON_LOOPBACK_SERVER_HOST:${host}`);
  return host;
}

export interface ListeningRouteServer extends RouteServer { listen(options: { host: string; port: number }): Promise<unknown> }
/** The control plane plus, when the run store exposes metrics, the evaluation surface over the same core. */
export type ServerCore = ControlPlaneCore & { readonly evaluation?: EvaluationCore; readonly traces?: TraceCore; readonly requirements?: RequirementsCore; readonly replay?: ReplayCore; readonly testing?: TestingCore; readonly workflows?: WorkflowGraphCore; readonly incremental?: IncrementalCore; readonly batches?: BatchCore };
export function buildServer(core: ServerCore, schemas: HttpSchemas = HTTP_ROUTE_SCHEMAS): FastifyInstance {
  // JSON unions must preserve their original types; coercion can turn model budgets
  // into strings while trying the first branch of a recursive JSON schema.
  const app = Fastify({ logger: false, ajv: { customOptions: { coerceTypes: false, removeAdditional: false } } });
  app.addHook("onRequest", async (request, reply) => {
    if (!localUrl(`http://${request.headers.host ?? ""}`) || request.headers.origin !== undefined && !localUrl(request.headers.origin)) {
      await reply.code(403).send({ error: "NON_LOCAL_CONTROL_PLANE_REQUEST" });
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (reply.raw.headersSent) { reply.raw.end(); return; }
    const failure = error instanceof Error ? error : new Error("Request failed");
    const secret = redactSecrets(failure.message).redactions.length > 0;
    const status = (error as { statusCode?: number }).statusCode;
    const statusCode = secret || status === undefined || status < 400 || status > 599 ? 500 : status;
    void reply.code(statusCode).send({ statusCode, error: "REQUEST_FAILED", message: secret ? "HTTP_SECRET_EGRESS_BLOCKED" : failure.message });
  });
  const adapter: RouteServer = { route(options) { app.route(options as RouteOptions); } };
  registerAll(adapter, core, schemas);
  return app;
}
export async function startServer(server: ListeningRouteServer, core: ServerCore, schemas: HttpSchemas = HTTP_ROUTE_SCHEMAS, options: { host?: string; port?: number } = {}): Promise<void> {
  registerAll(server, core, schemas);
  await server.listen({ host: assertLoopbackHost(options.host ?? DEFAULT_SERVER_HOST), port: options.port ?? DEFAULT_SERVER_PORT });
}
function registerAll(server: RouteServer, core: ServerCore, schemas: HttpSchemas): void {
  registerControlPlaneRoutes(server, core, schemas);
  if (core.evaluation !== undefined) registerEvaluationRoutes(server, core.evaluation, schemas);
  if (core.traces !== undefined) registerTraceRoutes(server, core.traces, schemas);
  if (core.requirements !== undefined) registerRequirementsRoutes(server, core.requirements, schemas);
  if (core.replay !== undefined) registerReplayRoutes(server, core.replay, schemas);
  if (core.testing !== undefined) registerTestingRoutes(server, core.testing, schemas);
  if (core.incremental !== undefined) registerIncrementalRoutes(server, core.incremental, schemas);
  if (core.workflows !== undefined) registerWorkflowRoutes(server, core.workflows, schemas);
  if (core.batches !== undefined) registerBatchRoutes(server, core.batches, schemas);
}

function localUrl(value: string): boolean {
  try { const url = new URL(value); return (url.protocol === "http:" || url.protocol === "https:") && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.username === "" && url.password === ""; }
  catch { return false; }
}
