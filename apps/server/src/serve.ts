import { Orchestrator } from "@arbitra/runtime/orchestrator.js";
import { controlPlaneCore } from "@arbitra/runtime/control-plane-core.js";
import { buildServer, DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT } from "./main.js";

/**
 * The control plane's process entrypoint.
 *
 * It binds to loopback only. The routes are read-only over the repository and the run
 * store, and the outbound secret guard in `registerControlPlaneRoutes` applies to every
 * response, so nothing here re-implements that policy.
 */
const host = process.env["ARBITRA_HOST"] ?? DEFAULT_SERVER_HOST;
const port = Number(process.env["ARBITRA_PORT"] ?? DEFAULT_SERVER_PORT);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new RangeError(`INVALID_SERVER_PORT:${process.env["ARBITRA_PORT"]}`);

const orchestrator = new Orchestrator({ repository: process.env["ARBITRA_REPOSITORY"] ?? process.cwd() });
const app = buildServer(controlPlaneCore(orchestrator));

await app.listen({ host, port });
process.stdout.write(`arbitra control plane on http://${host}:${port} (repository ${orchestrator.repository})\n`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { void app.close().then(() => { process.exitCode = 0; }); });
}
