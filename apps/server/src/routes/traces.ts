import { assertNoSecretEgress, type HttpSchemas, type RouteServer } from "./control-plane.js";

export interface TraceCore {
  list(runId: string, query: unknown): Promise<unknown>;
  detail(runId: string, traceId: string): Promise<unknown>;
  artifact(runId: string, traceId: string, slot: string): Promise<unknown>;
}
export const TRACE_ROUTE_INVENTORY = [
  ["GET", "/runs/:id/traces"],
  ["GET", "/runs/:id/traces/:traceId"],
  ["GET", "/runs/:id/traces/:traceId/artifacts/:slot"],
] as const;

export function registerTraceRoutes(server: RouteServer, core: TraceCore, schemas: HttpSchemas): void {
  for (const [method, url] of TRACE_ROUTE_INVENTORY) {
    const schema = schemas[`${method} ${url}`];
    if (schema === undefined) throw new Error(`MISSING_HTTP_SCHEMA:${method} ${url}`);
    server.route({ method, url, schema, handler: async ({ params, query }) => {
      const required = (key: string): string => {
        const value = params?.[key];
        if (!value) throw new Error(`MISSING_ROUTE_PARAMETER:${key}`);
        return value;
      };
      const result = url.endsWith("/:slot") ? await core.artifact(required("id"), required("traceId"), required("slot"))
        : url.endsWith("/:traceId") ? await core.detail(required("id"), required("traceId"))
        : await core.list(required("id"), query ?? {});
      return assertNoSecretEgress(result);
    } });
  }
}
