import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { controlPlaneCore } from "@arbitra/runtime/control-plane-core.js";
import { registerHandoffRoutes } from "../src/handoff.js";
import { buildServer, DEFAULT_SERVER_HOST } from "../src/main.js";
import { serveWebApp } from "../src/web-app.js";
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

app.post<{ Params: { scenario: string } }>("/__fixture/runs/:scenario", async (request, reply) => {
  const scenario = request.params.scenario;
  if (!(SCRIPTED_SCENARIOS as readonly string[]).includes(scenario)) return reply.code(404).send({ error: "UNKNOWN_SCENARIO" });
  const run = await runtime.start(scenario as ScriptedScenario);
  return { runId: run.runId, state: run.state };
});
// A fresh Audit repository for a run the browser starts itself from a saved graph (P16).
app.post("/__fixture/repositories/audit", async () => ({ repository: await runtime.auditRepository() }));
// The plan's hand-over routes, as the local app serves them: the Plan and Results tabs read them.
registerHandoffRoutes(app, runtime.orchestrator);
serveWebApp(app, webRoot);

await app.listen({ host: DEFAULT_SERVER_HOST, port });
process.stdout.write(`arbitra e2e fixture on http://${DEFAULT_SERVER_HOST}:${port} (web ${webRoot}, state ${root})\n`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { void app.close().then(() => rm(root, { recursive: true, force: true })).finally(() => process.exit(0)); });
}
