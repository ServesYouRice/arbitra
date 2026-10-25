import { assertNoSecretEgress, type HttpSchemas, type RouteServer } from "./control-plane.js";

/** A run's progress so far, read from its records by the orchestrator (`RunProgress` in @arbitra/schemas). Read-only. */
export interface ProgressCore {
  read(runId: string): Promise<unknown>;
}
export const PROGRESS_ROUTE_INVENTORY = [["GET", "/runs/:id/progress"]] as const;

export function registerProgressRoutes(server: RouteServer, core: ProgressCore, schemas: HttpSchemas): void {
  for (const [method, url] of PROGRESS_ROUTE_INVENTORY) {
    const schema = schemas[`${method} ${url}`];
    if (schema === undefined) throw new Error(`MISSING_HTTP_SCHEMA:${method} ${url}`);
    server.route({ method, url, schema, handler: async ({ params }) => {
      const id = params?.["id"];
      if (id === undefined || id === "") throw new Error("MISSING_ROUTE_PARAMETER:id");
      // Finding titles are model text: the outbound secret guard reads them like every other response.
      return assertNoSecretEgress(await core.read(id));
    } });
  }
}
