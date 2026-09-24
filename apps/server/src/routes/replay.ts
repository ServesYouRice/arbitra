import { assertNoSecretEgress, type HttpSchemas, type RouteServer } from "./control-plane.js";

/** Replay is the orchestrator's; the route forwards the mode-specific request unchanged. */
export interface ReplayCore {
  start(sourceRunId: string, body: unknown): Promise<unknown>;
  report(runId: string): Promise<unknown>;
}

export const REPLAY_ROUTE_INVENTORY = [["POST", "/runs/:id/replay"], ["GET", "/runs/:id/replay"]] as const;

export function registerReplayRoutes(server: RouteServer, core: ReplayCore, schemas: HttpSchemas): void {
  for (const [method, url] of REPLAY_ROUTE_INVENTORY) {
    const schema = schemas[`${method} ${url}`];
    if (schema === undefined) throw new Error(`MISSING_HTTP_SCHEMA:${method} ${url}`);
    server.route({ method, url, schema, handler: async ({ params, body }) => {
      const id = params?.["id"];
      if (id === undefined || id === "") throw new Error("MISSING_RUN_ID");
      return assertNoSecretEgress(method === "GET" ? await core.report(id) : await core.start(id, body));
    } });
  }
}
