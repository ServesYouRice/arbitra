import type { OrchestratorCore } from "./core.js";
import { executeCommand } from "./commands/execute.js";
import { exitPolicy, type ExitCode } from "./exit-policy.js";
import { renderHuman } from "./output/human.js";
import { createJsonOutput, type CliJsonOutput } from "./output/json.js";

export interface CliIo {
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

export interface CliExecution {
  readonly exit: ExitCode;
  readonly output: CliJsonOutput;
}

export async function runCli(
  argv: readonly string[],
  core: OrchestratorCore,
  io: CliIo,
): Promise<CliExecution> {
  const json = argv.includes("--json");
  const args = argv.filter((argument) => argument !== "--json");
  const command = args[0] ?? "";
  let result;
  try {
    result = await executeCommand(core, command, args.slice(1));
  } catch (error) {
    result = {
      disposition: "system_failure" as const,
      reasons: ["core_command_failed"],
      value: { message: describeError(error) },
    };
  }
  const policy = exitPolicy(result);
  const output = createJsonOutput(command || "unknown", policy, result.value);
  const rendered = json ? JSON.stringify(output) : renderHuman(output);
  (json || policy.exit === 0 ? io.writeStdout : io.writeStderr)(`${rendered}\n`);
  return { exit: policy.exit, output };
}

export async function main(argv: readonly string[], core: OrchestratorCore): Promise<void> {
  const execution = await runCli(argv, core, {
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
  });
  process.exitCode = execution.exit;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
