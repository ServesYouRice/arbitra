import { assertNoSecretEgress, type HttpSchemas, type RouteServer } from "./control-plane.js";

/** Incremental Audit reporting is the orchestrator's; the route only forwards the run ID. */
export interface IncrementalCore {
  report(runId: string): Promise<unknown>;
}

export const INCREMENTAL_ROUTE_INVENTORY = [["GET", "/runs/:id/incremental"]] as const;

export function registerIncrementalRoutes(server: RouteServer, core: IncrementalCore, schemas: HttpSchemas): void {
  for (const [method, url] of INCREMENTAL_ROUTE_INVENTORY) {
    const schema = schemas[`${method} ${url}`];
    if (schema === undefined) throw new Error(`MISSING_HTTP_SCHEMA:${method} ${url}`);
    server.route({ method, url, schema, handler: async ({ params }) => {
      const id = params?.["id"];
      if (id === undefined || id === "") throw new Error("MISSING_RUN_ID");
      return assertNoSecretEgress(await core.report(id));
    } });
  }
}
