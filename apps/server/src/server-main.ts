import { Orchestrator } from "@arbitra/runtime/orchestrator.js";
import { controlPlaneCore } from "@arbitra/runtime/control-plane-core.js";
import { existsSync } from "node:fs";
import { arbitraBuild, detectEnvironment, type DetectedEnvironment } from "@arbitra/runtime/environment.js";
import { pickFolder } from "./folder-picker.js";
import { registerHandoffRoutes } from "./handoff.js";
import { runReport } from "@arbitra/runtime/run-report.js";
import { processHost } from "@arbitra/runtime/run-host.js";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertLoopbackHost, buildServer, DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT } from "./main.js";
import { serveWebApp } from "./web-app.js";

/**
 * The control plane's process entrypoint, as a function: `serve.js` calls it, and so does the single-file app, which
 * bundles it and names its own web build, protocol assets and build in the environment.
 *
 * It binds to loopback only. The control-plane routes go through `registerControlPlaneRoutes`, whose outbound secret
 * guard applies to their responses. The routes registered below belong to the local app: the run report redacts its
 * own text, and the plan export writes into the repository only when the operator asks for it.
 */
export async function serve(): Promise<Serving> {
  const host = assertLoopbackHost(process.env["ARBITRA_HOST"] ?? DEFAULT_SERVER_HOST);
  const port = Number(process.env["ARBITRA_PORT"] ?? DEFAULT_SERVER_PORT);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new RangeError(`INVALID_SERVER_PORT:${process.env["ARBITRA_PORT"]}`);
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;

  const here = (): string => dirname(fileURLToPath(import.meta.url));
  // The build this server runs, named in the diagnostics and the run report, and recorded with each run it starts, so a
  // resume on another build that cannot reuse the run's work can say which one it started on.
  const recorded = arbitraBuild(join(here(), "..", "..", "..", ".."));
  const build = recorded ?? "unknown";
  // An arbitra already at this address is this one when it runs the same build; another build is named, never opened in
  // its place (an old one left running showed its own pages to a person who had started the new one). Asked before
  // anything here opens the run store the other may hold.
  const running = await answeringBuild(url);
  if (running !== null) {
    if (running === build) return { url, alreadyRunning: true, close: () => Promise.resolve() };
    throw new ArbitraAlreadyRunningError(url, running, build);
  }
  // The computer is kept awake while a run works, and its sleeps watched (see packages/runtime/src/run-host.ts).
  const orchestrator = new Orchestrator({ repository: process.env["ARBITRA_REPOSITORY"] ?? process.cwd(), host: processHost(), ...(recorded === null ? {} : { build: recorded }) });
  const app = buildServer(controlPlaneCore(orchestrator));
  // The built web app is served from the same address when it exists (`pnpm build` makes it); ARBITRA_WEB_DIST names
  // another build, and an empty value leaves the control plane alone, as for the Vite dev server.
  const webRoot = resolve(process.env["ARBITRA_WEB_DIST"] ?? join(here(), "..", "..", "..", "web", "dist"));
  const withWeb = process.env["ARBITRA_WEB_DIST"] !== "" && existsSync(join(webRoot, "index.html"));
  if (withWeb) serveWebApp(app, webRoot);

  // What a tester's machine can run, and a run's plain-text report to copy and send (see packages/runtime).
  let environment: Promise<DetectedEnvironment> = detectEnvironment();
  // Which build and process answer here, at once: a launcher waits for its own process, not whatever holds the port.
  app.get("/diagnostics/server", async () => ({ build, pid: process.pid }));
  app.get<{ Querystring: { refresh?: string } }>("/diagnostics/environment", async (request) => {
    if (request.query.refresh === "1") environment = detectEnvironment();
    // Whether a run keeps this computer awake, as of now: a missing tool or a holder that stopped shows here, never as a failed run.
    return { build, ...await environment, keepAwake: orchestrator.keepAwake() };
  });
  // Writes a run's plan into its repository as prompts on the operator's explicit request only, and reads it back.
  registerHandoffRoutes(app, orchestrator);
  app.post("/repositories/pick", async () => ({ path: await pickFolder("Choose the project folder for arbitra to read") }));
  app.get<{ Params: { runId: string } }>("/diagnostics/runs/:runId", async (request, reply) => {
    const text = await runReport(orchestrator, request.params.runId, await environment.catch(() => null), build);
    return reply.type("text/plain; charset=utf-8").send(text);
  });

  await app.listen({ host, port });
  process.stdout.write(`arbitra on ${url}${withWeb ? "" : " (control plane only; run pnpm build for the web app)"} · repository ${orchestrator.repository}\n`);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => { void app.close().then(() => { process.exitCode = 0; }); });
  }
  return { url, alreadyRunning: false, close: async () => { await app.close(); } };
}

/** Where arbitra answers. `alreadyRunning`: the same build was there already, and this call started nothing. */
export interface Serving {
  readonly url: string;
  readonly alreadyRunning: boolean;
  close(): Promise<void>;
}

/** Another build of arbitra answers at the address this one would take. */
export class ArbitraAlreadyRunningError extends Error {
  constructor(readonly url: string, readonly build: string, readonly ours: string) {
    super(`Another arbitra (${build}) is already running on ${url}, so this one (${ours}) cannot start there.`);
    this.name = "ArbitraAlreadyRunningError";
  }
}

/**
 * The build of the arbitra answering at `url`, or null when nothing does (or something that is not arbitra, which then
 * holds the port and fails the listen). Builds before 0.3.1 name theirs only in the environment route.
 */
async function answeringBuild(url: string): Promise<string | null> {
  for (const path of ["/diagnostics/server", "/diagnostics/environment"]) {
    let response: Response;
    try { response = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(10_000) }); } catch { return null; }
    const answer: unknown = response.ok ? await response.json().catch(() => null) : null;
    const build = typeof answer === "object" && answer !== null ? (answer as { readonly build?: unknown }).build : undefined;
    if (typeof build === "string") return build;
  }
  return null;
}
