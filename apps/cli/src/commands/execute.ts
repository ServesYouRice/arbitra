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
    case "apply-requirements-revision": {
      const artifactId = positional[1];
      if (core.applyRequirementsRevision === undefined || artifactId === undefined || positional.length !== 2) throw new Error("USAGE: apply-requirements-revision <run-id> <proposal-artifact-id>");
      return core.applyRequirementsRevision(subject, artifactId);
    }
    case "respond-checkpoint": {
      const [checkpointId, version, decision] = positional.slice(1);
      if (core.respondCheckpoint === undefined || checkpointId === undefined || version === undefined || decision === undefined || positional.length !== 4) throw new Error("USAGE: respond-checkpoint <run-id> <checkpoint-id> <version> <approve|reject>");
      return core.respondCheckpoint(subject, checkpointId, version, decision);
    }
    case "requirements": {
      if (core.requirements === undefined || positional.length !== 1) throw new Error("USAGE: requirements <run-id>");
      return core.requirements(subject);
    }
    case "approve-requirements": {
      const artifactId = positional[1];
      if (core.approveRequirements === undefined || artifactId === undefined || positional.length < 3) throw new Error("USAGE: approve-requirements <run-id> <artifact-id> <ambiguity-id>...");
      return core.approveRequirements(subject, artifactId, positional.slice(2));
    }
    case "revise-requirements": {
      const artifactId = positional[1]; const draftPath = positional[2];
      if (core.reviseRequirements === undefined || artifactId === undefined || draftPath === undefined || positional.length !== 3) throw new Error("USAGE: revise-requirements <run-id> <artifact-id> <draft.json>");
      return core.reviseRequirements(subject, artifactId, draftPath);
    }
    case "validate": return core.validate(subject);
    case "estimate": return executeEstimate(core, subject);
    case "run": return core.run(subject);
    case "status": return core.status(subject);
    case "resume": return core.resume(subject);
  }
}
