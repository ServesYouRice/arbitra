import { assertNoSecretEgress, type HttpSchemas, type RouteServer } from "./control-plane.js";

/**
 * Read-only Testing operator routes. The view composes the run's stored authority with
 * plan-versus-execution state; the change-set route returns only the exact verified bytes
 * named by the completion record. Neither route writes, dispatches or applies anything,
 * and both responses pass the shared secret-egress guard.
 */
export interface TestingCore {
  view(runId: string): Promise<unknown>;
  changeSet(runId: string): Promise<unknown>;
}
export const TESTING_ROUTE_INVENTORY = [["GET", "/runs/:id/testing"], ["GET", "/runs/:id/testing/change-set"]] as const;

export function registerTestingRoutes(server: RouteServer, core: TestingCore, schemas: HttpSchemas): void {
  for (const [method, url] of TESTING_ROUTE_INVENTORY) {
    const schema = schemas[`${method} ${url}`];
    if (schema === undefined) throw new Error(`MISSING_HTTP_SCHEMA:${method} ${url}`);
    server.route({ method, url, schema, handler: async ({ params }) => {
      const id = params?.["id"];
      if (id === undefined || id === "") throw new Error("MISSING_ROUTE_PARAMETER:id");
      return assertNoSecretEgress(url.endsWith("/change-set") ? await core.changeSet(id) : await core.view(id));
    } });
  }
}
