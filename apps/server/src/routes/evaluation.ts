import { assertNoSecretEgress, type HttpSchemas, type RouteServer } from "./control-plane.js";

/**
 * Evaluation routes over the same guarded query layer the CLI report command uses.
 *
 * The identity aggregation guard and the cross-protocol refusal are raised by the query
 * layer, not by these handlers; the routes translate them into a 409 with the query
 * layer's own explanation so a caller learns why the comparison was refused. Outbound
 * payloads pass through the same secret guard as every other localhost route.
 */
export const EVALUATION_ROUTE_INVENTORY = [
  ["GET", "/runs/:id/metrics"],
  ["POST", "/runs/compare"],
] as const;

export const AGGREGATION_REFUSAL_STATUS = 409 as const;
export const AGGREGATION_REFUSAL_CODES = ["INCOMPARABLE_IDENTITY_MIX", "CROSS_PROTOCOL_COMPARISON_REFUSED"] as const;

export interface EvaluationCore {
  metrics(runId: string): Promise<unknown>;
  compare(request: { readonly a: unknown; readonly b: unknown }): Promise<unknown>;
}
interface EvaluationReply { code(status: number): EvaluationReply; send(payload: unknown): unknown }
type Handler = (request: { body?: unknown; params?: Record<string, string> }, reply: unknown) => Promise<unknown> | unknown;

export function registerEvaluationRoutes(server: RouteServer, core: EvaluationCore, schemas: HttpSchemas): void {
  const route = (method: string, url: string, handler: Handler): void => {
    const schema = schemas[`${method} ${url}`];
    if (schema === undefined) throw new Error(`MISSING_HTTP_SCHEMA:${method} ${url}`);
    server.route({ method, url, schema, handler: guardedHandler(handler) });
  };
  route("GET", "/runs/:id/metrics", ({ params }) => core.metrics(required(params, "id")));
  route("POST", "/runs/compare", ({ body }) => {
    const request = body as { a?: unknown; b?: unknown } | undefined;
    if (request?.a === undefined || request.b === undefined) throw new Error("COMPARISON_SIDES_REQUIRED");
    return core.compare({ a: request.a, b: request.b });
  });
  if (EVALUATION_ROUTE_INVENTORY.length !== 2) throw new Error("EVALUATION_ROUTE_INVENTORY_INCOMPLETE");
}

/** A refusal raised by the query layer, never re-derived here. */
export function aggregationRefusal(error: unknown): { readonly code: string; readonly message: string } | null {
  const message = error instanceof Error ? error.message : "";
  const code = AGGREGATION_REFUSAL_CODES.find((candidate) => message.startsWith(candidate));
  return code === undefined ? null : { code, message };
}

function guardedHandler(handler: Handler): Handler {
  return async (request, reply) => {
    try {
      return assertNoSecretEgress(await handler(request, reply));
    } catch (cause) {
      const refusal = aggregationRefusal(cause);
      if (refusal === null) throw cause;
      const typed = reply as EvaluationReply;
      return typed.code(AGGREGATION_REFUSAL_STATUS).send({ error: refusal.code, message: refusal.message, comparable: false });
    }
  };
}
function required(params: Record<string, string> | undefined, key: string): string { const value = params?.[key]; if (value === undefined || value === "") throw new Error(`MISSING_ROUTE_PARAMETER:${key}`); return value; }
