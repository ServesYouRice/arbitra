import { Orchestrator } from "@arbitra/runtime/orchestrator.js";
import { controlPlaneCore } from "@arbitra/runtime/control-plane-core.js";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { detectEnvironment, type DetectedEnvironment } from "@arbitra/runtime/environment.js";
import { exportPlan } from "@arbitra/runtime/plan-export.js";
import { pickFolder } from "./folder-picker.js";
import { runReport } from "@arbitra/runtime/run-report.js";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertLoopbackHost, buildServer, DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT } from "./main.js";
import { serveWebApp } from "./web-app.js";

/**
 * The control plane's process entrypoint.
 *
 * It binds to loopback only. The routes are read-only over the repository and the run
 * store, and the outbound secret guard in `registerControlPlaneRoutes` applies to every
 * response, so nothing here re-implements that policy.
 */
const host = assertLoopbackHost(process.env["ARBITRA_HOST"] ?? DEFAULT_SERVER_HOST);
const port = Number(process.env["ARBITRA_PORT"] ?? DEFAULT_SERVER_PORT);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new RangeError(`INVALID_SERVER_PORT:${process.env["ARBITRA_PORT"]}`);

const orchestrator = new Orchestrator({ repository: process.env["ARBITRA_REPOSITORY"] ?? process.cwd() });
const app = buildServer(controlPlaneCore(orchestrator));
// The built web app is served from the same address when it exists (`pnpm build` makes it); ARBITRA_WEB_DIST names
// another build, and an empty value leaves the control plane alone, as for the Vite dev server.
const webRoot = resolve(process.env["ARBITRA_WEB_DIST"] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "web", "dist"));
const withWeb = process.env["ARBITRA_WEB_DIST"] !== "" && existsSync(join(webRoot, "index.html"));
if (withWeb) serveWebApp(app, webRoot);

// What a tester's machine can run, and a run's plain-text report to copy and send (see packages/runtime).
const arbitraRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
// A zip download has no Git history; Git wrote the commit into tooling/launch/build-id when it made the archive.
const archived = (): string => { try { const id = readFileSync(join(arbitraRoot, "tooling", "launch", "build-id"), "utf8").trim(); return id.startsWith("$Format") ? "unknown" : `${id}, from a download`; } catch { return "unknown"; } };
const build = (() => { try { return execFileSync("git", ["-C", arbitraRoot, "rev-parse", "--short", "HEAD"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return archived(); } })();
let environment: Promise<DetectedEnvironment> = detectEnvironment();
app.get<{ Querystring: { refresh?: string } }>("/diagnostics/environment", async (request) => {
  if (request.query.refresh === "1") environment = detectEnvironment();
  return { build, ...await environment };
});
// Writes a run's plan into its repository as prompts, on the operator's explicit request only.
app.post<{ Params: { runId: string } }>("/handoff/runs/:runId", async (request) => exportPlan(orchestrator, request.params.runId));
app.post("/repositories/pick", async () => ({ path: await pickFolder("Choose the project folder for arbitra to read") }));
app.get<{ Params: { runId: string } }>("/diagnostics/runs/:runId", async (request, reply) => {
  const text = await runReport(orchestrator, request.params.runId, await environment.catch(() => null), build);
  return reply.type("text/plain; charset=utf-8").send(text);
});

await app.listen({ host, port });
process.stdout.write(`arbitra on http://${host}:${port}${withWeb ? "" : " (control plane only; run pnpm build for the web app)"} · repository ${orchestrator.repository}\n`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { void app.close().then(() => { process.exitCode = 0; }); });
}
