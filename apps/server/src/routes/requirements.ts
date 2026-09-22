import { assertNoSecretEgress, type HttpSchemas, type RouteServer } from "./control-plane.js";

export interface RequirementsCore {
  current(runId: string): Promise<unknown>;
  approve(runId: string, body: unknown): Promise<unknown>;
  revise(runId: string, artifactId: string, draft: unknown): Promise<unknown>;
  applyRevision(runId: string, artifactId: string): Promise<unknown>;
}

export const REQUIREMENTS_ROUTE_INVENTORY = [["GET", "/runs/:id/requirements"], ["POST", "/runs/:id/requirements/approve"], ["POST", "/runs/:id/requirements/revise"], ["POST", "/runs/:id/requirements/apply-revision"]] as const;

export function registerRequirementsRoutes(server: RouteServer, core: RequirementsCore, schemas: HttpSchemas): void {
  for (const [method, url] of REQUIREMENTS_ROUTE_INVENTORY) {
    const schema = schemas[`${method} ${url}`];
    if (schema === undefined) throw new Error(`MISSING_HTTP_SCHEMA:${method} ${url}`);
    server.route({ method, url, schema, handler: async ({ params, body }) => {
      const id = params?.["id"];
      if (id === undefined) throw new Error("MISSING_RUN_ID");
      if (method === "GET") return assertNoSecretEgress(await core.current(id));
      if (url.endsWith("/approve")) return assertNoSecretEgress(await core.approve(id, body));
      const request = body as { artifactId?: unknown; draft?: unknown } | undefined;
      if (typeof request?.artifactId !== "string") throw new Error("REQUIREMENTS_ARTIFACT_ID_REQUIRED");
      if (url.endsWith("/apply-revision")) return assertNoSecretEgress(await core.applyRevision(id, request.artifactId));
      return assertNoSecretEgress(await core.revise(id, request.artifactId, request.draft));
    } });
  }
}
