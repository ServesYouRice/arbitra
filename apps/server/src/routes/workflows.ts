import { assertNoSecretEgress, type HttpSchemas, type RouteServer } from "./control-plane.js";

/**
 * Operator-authored workflow graphs. Validation and versioning are the orchestrator's:
 * the routes forward requests unchanged and keep no graph state of their own. Save never
 * overwrites; each distinct graph is a new immutable, content-addressed version.
 */
export interface WorkflowGraphCore {
  list(): Promise<unknown>;
  versions(graphId: string): Promise<unknown>;
  version(graphId: string, version: string): Promise<unknown>;
  validate(body: unknown): Promise<unknown>;
  save(body: unknown): Promise<unknown>;
}

export const WORKFLOW_ROUTE_INVENTORY = [
  ["GET", "/workflows"], ["GET", "/workflows/:id"], ["GET", "/workflows/:id/versions/:version"],
  ["POST", "/workflows/validate"], ["POST", "/workflows"],
] as const;

export function registerWorkflowRoutes(server: RouteServer, core: WorkflowGraphCore, schemas: HttpSchemas): void {
  const handlers: Record<string, (request: { body?: unknown; params?: Record<string, string> }) => Promise<unknown>> = {
    "GET /workflows": () => core.list(),
    "GET /workflows/:id": ({ params }) => core.versions(required(params, "id")),
    "GET /workflows/:id/versions/:version": ({ params }) => core.version(required(params, "id"), required(params, "version")),
    "POST /workflows/validate": ({ body }) => core.validate(body),
    "POST /workflows": ({ body }) => core.save(body),
  };
  for (const [method, url] of WORKFLOW_ROUTE_INVENTORY) {
    const key = `${method} ${url}`;
    const schema = schemas[key];
    const handler = handlers[key];
    if (schema === undefined) throw new Error(`MISSING_HTTP_SCHEMA:${key}`);
    if (handler === undefined) throw new Error(`MISSING_ROUTE_HANDLER:${key}`);
    server.route({ method, url, schema, handler: async (request) => assertNoSecretEgress(await handler(request)) });
  }
}

function required(params: Record<string, string> | undefined, key: string): string {
  const value = params?.[key];
  if (value === undefined || value === "") throw new Error(`MISSING_ROUTE_PARAMETER:${key}`);
  return value;
}
