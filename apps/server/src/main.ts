import Fastify, { type FastifyInstance, type RouteOptions } from "fastify";
import { HTTP_ROUTE_SCHEMAS } from "@arbitra/schemas/http-control-plane";
import { CheckpointRegistry } from "./checkpoints.js";
import { registerControlPlaneRoutes, type ControlPlaneCore, type HttpSchemas, type RouteServer } from "./routes/control-plane.js";
import { registerEvaluationRoutes, type EvaluationCore } from "./routes/evaluation.js";

export const DEFAULT_SERVER_HOST = "127.0.0.1" as const;
export const DEFAULT_SERVER_PORT = 4178 as const;

export interface ListeningRouteServer extends RouteServer { listen(options: { host: string; port: number }): Promise<unknown> }
/** The control plane plus, when the run store exposes metrics, the evaluation surface over the same core. */
export type ServerCore = ControlPlaneCore & { readonly evaluation?: EvaluationCore };
export function buildServer(core: ServerCore, schemas: HttpSchemas = HTTP_ROUTE_SCHEMAS): FastifyInstance {
  const app = Fastify({ logger: false });
  const adapter: RouteServer = { route(options) { app.route(options as RouteOptions); } };
  registerAll(adapter, core, schemas);
  return app;
}
export async function startServer(server: ListeningRouteServer, core: ServerCore, schemas: HttpSchemas = HTTP_ROUTE_SCHEMAS, options: { host?: string; port?: number } = {}): Promise<void> {
  registerAll(server, core, schemas);
  await server.listen({ host: options.host ?? DEFAULT_SERVER_HOST, port: options.port ?? DEFAULT_SERVER_PORT });
}
function registerAll(server: RouteServer, core: ServerCore, schemas: HttpSchemas): void {
  registerControlPlaneRoutes(server, core, new CheckpointRegistry(), schemas);
  if (core.evaluation !== undefined) registerEvaluationRoutes(server, core.evaluation, schemas);
}
