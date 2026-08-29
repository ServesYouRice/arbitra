#!/usr/bin/env node
import { Orchestrator } from "@arbitra/runtime/orchestrator.js";
import { orchestratorCore } from "@arbitra/runtime/cli-core.js";
import { runCli } from "./main.js";

/**
 * The CLI's process entrypoint.
 *
 * It composes the one orchestrator and hands it to `runCli`, which owns argument parsing,
 * rendering and the exit policy. The exit code is the policy's, never re-derived here.
 */
const { exit } = await runCli(process.argv.slice(2), orchestratorCore(new Orchestrator({ repository: process.cwd() })), {
  writeStdout: (text: string): void => { process.stdout.write(text); },
  writeStderr: (text: string): void => { process.stderr.write(text); },
});
process.exitCode = exit;
