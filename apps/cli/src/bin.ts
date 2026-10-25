#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { arbitraBuild } from "@arbitra/runtime/environment.js";
import { Orchestrator } from "@arbitra/runtime/orchestrator.js";
import { orchestratorCore } from "@arbitra/runtime/cli-core.js";
import { runCli } from "./main.js";

/**
 * The CLI's process entrypoint.
 *
 * It composes the one orchestrator and hands it to `runCli`, which owns argument parsing,
 * rendering and the exit policy. The exit code is the policy's, never re-derived here.
 * The build it runs is recorded with each run it starts, as the server's is.
 */
const build = arbitraBuild(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".."));
const { exit } = await runCli(process.argv.slice(2), orchestratorCore(new Orchestrator({ repository: process.cwd(), ...(build === null ? {} : { build }) })), {
  writeStdout: (text: string): void => { process.stdout.write(text); },
  writeStderr: (text: string): void => { process.stderr.write(text); },
});
process.exitCode = exit;
