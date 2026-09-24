import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import { controlPlaneCore } from "@arbitra/runtime/control-plane-core.js";
import { buildServer, DEFAULT_SERVER_HOST } from "../src/main.js";
import { SCRIPTED_SCENARIOS, scriptedRuntime, type ScriptedScenario } from "./scripted-runs.js";

/**
 * Browser-acceptance entrypoint: the real control plane over a temporary state
 * directory, plus the built web app. Runs are produced by the real orchestrator with
 * scripted provider and sandbox ports (see `scripted-runs.ts`).
 *
 * `POST /__fixture/runs/:scenario` exists only in this fixture process. It lets each
 * browser scenario create its own isolated run; the web app never calls it.
 */
const port = Number(process.env["E2E_PORT"] ?? 4179);
const webRoot = resolve(process.env["E2E_WEB_DIST"] ?? join(process.cwd(), "dist"));
const root = await mkdtemp(join(tmpdir(), "arbitra-e2e-"));
const runtime = scriptedRuntime(root);
const app = buildServer(controlPlaneCore(runtime.orchestrator));
const types: Readonly<Record<string, string>> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".map": "application/json", ".woff2": "font/woff2" };

app.post<{ Params: { scenario: string } }>("/__fixture/runs/:scenario", async (request, reply) => {
  const scenario = request.params.scenario;
  if (!(SCRIPTED_SCENARIOS as readonly string[]).includes(scenario)) return reply.code(404).send({ error: "UNKNOWN_SCENARIO" });
  const run = await runtime.start(scenario as ScriptedScenario);
  return { runId: run.runId, state: run.state };
});
app.setNotFoundHandler(async (request, reply) => {
  if (request.method !== "GET") return reply.code(404).send({ error: "NOT_FOUND" });
  const path = new URL(request.url, "http://localhost").pathname;
  const file = normalize(join(webRoot, path === "/" ? "index.html" : decodeURIComponent(path)));
  if (!file.startsWith(webRoot + sep)) return reply.code(403).send({ error: "OUTSIDE_WEB_ROOT" });
  try {
    const body = await readFile(file);
    return reply.type(types[extname(file)] ?? "application/octet-stream").send(body);
  } catch {
    return reply.code(404).send({ error: "NOT_FOUND" });
  }
});

await app.listen({ host: DEFAULT_SERVER_HOST, port });
process.stdout.write(`arbitra e2e fixture on http://${DEFAULT_SERVER_HOST}:${port} (web ${webRoot}, state ${root})\n`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { void app.close().then(() => rm(root, { recursive: true, force: true })).finally(() => process.exit(0)); });
}
