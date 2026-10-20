import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import type { FastifyInstance } from "fastify";

const TYPES: Readonly<Record<string, string>> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".map": "application/json", ".woff2": "font/woff2", ".png": "image/png", ".ico": "image/x-icon" };

/**
 * Serves the built web app (`apps/web/dist`) from the control plane itself, so one process on one address is the
 * whole product: no separate dev server and no proxy. Any GET the control plane's routes do not answer is a file of
 * the app; nothing outside `webRoot` is served.
 */
export function serveWebApp(app: FastifyInstance, webRoot: string): void {
  app.setNotFoundHandler(async (request, reply) => {
    if (request.method !== "GET") return reply.code(404).send({ error: "NOT_FOUND" });
    const path = new URL(request.url, "http://localhost").pathname;
    const file = normalize(join(webRoot, path === "/" ? "index.html" : decodeURIComponent(path)));
    if (!file.startsWith(webRoot + sep)) return reply.code(403).send({ error: "OUTSIDE_WEB_ROOT" });
    try {
      const body = await readFile(file);
      return reply.type(TYPES[extname(file)] ?? "application/octet-stream").send(body);
    } catch {
      return reply.code(404).send({ error: "NOT_FOUND" });
    }
  });
}
