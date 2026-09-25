import { assertNoSecretEgress, type HttpSchemas, type RouteServer } from "./control-plane.js";

/** Provider batch submissions are durable run state owned by the orchestrator; the routes forward and keep none. */
export interface BatchCore {
  list(runId: string): Promise<unknown>;
  resolve(runId: string, submissionId: string, body: unknown): Promise<unknown>;
}

export const BATCH_ROUTE_INVENTORY = [["GET", "/runs/:id/batches"], ["POST", "/runs/:id/batches/:submissionId/resolve"]] as const;

export function registerBatchRoutes(server: RouteServer, core: BatchCore, schemas: HttpSchemas): void {
  for (const [method, url] of BATCH_ROUTE_INVENTORY) {
    const schema = schemas[`${method} ${url}`];
    if (schema === undefined) throw new Error(`MISSING_HTTP_SCHEMA:${method} ${url}`);
    server.route({ method, url, schema, handler: async ({ params, body }) => {
      const id = params?.["id"];
      if (id === undefined || id === "") throw new Error("MISSING_RUN_ID");
      if (method === "GET") return assertNoSecretEgress(await core.list(id));
      const submissionId = params?.["submissionId"];
      if (submissionId === undefined || submissionId === "") throw new Error("MISSING_ROUTE_PARAMETER:submissionId");
      return assertNoSecretEgress(await core.resolve(id, submissionId, body));
    } });
  }
}
