import { isImplementedCommand } from "../command-registry.js";
import type { CoreCommandResult, OrchestratorCore } from "../core.js";
import { executeAudit } from "./audit.js";
import { executeDiff } from "./diff.js";
import { executeEstimate } from "./estimate.js";
import { executeExport } from "./export.js";
import { executeReplay } from "./replay.js";
import { executeReport } from "./report.js";
import { executeTrace } from "./trace.js";

export async function executeCommand(
  core: OrchestratorCore,
  command: string,
  positional: readonly string[],
): Promise<CoreCommandResult> {
  if (!isImplementedCommand(command)) {
    return { disposition: "system_failure", reasons: [`unknown_command:${command || "missing"}`], value: null };
  }
  if (command === "audit") return executeAudit(core, positional);
  if (command === "replay") return executeReplay(core, positional);
  if (command === "diff") return executeDiff(core, positional);
  if (command === "trace") return executeTrace(core, positional);
  if (command === "export") return executeExport(core, positional);
  if (command === "report") return executeReport(core, positional);
  const subject = positional[0];
  if (subject === undefined || subject.length === 0) {
    return { disposition: "system_failure", reasons: [`missing_argument:${command}`], value: null };
  }
  switch (command) {
    case "validate": return core.validate(subject);
    case "estimate": return executeEstimate(core, subject);
    case "run": return core.run(subject);
    case "status": return core.status(subject);
    case "resume": return core.resume(subject);
  }
}
