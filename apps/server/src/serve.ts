import { ArbitraAlreadyRunningError, serve } from "./server-main.js";

/**
 * The control plane's process entrypoint (see server-main.ts). It exits 0 when the same build already runs at its
 * address, and 1, naming the other build, when another one does.
 */
try {
  const { url, alreadyRunning } = await serve();
  if (alreadyRunning) process.stdout.write(`arbitra is already running on ${url}\n`);
} catch (error) {
  if (!(error instanceof ArbitraAlreadyRunningError)) throw error;
  process.stderr.write(`arbitra: ${error.message} Close it, then start this one again.\n`);
  process.exitCode = 1;
}
