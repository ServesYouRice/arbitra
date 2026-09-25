import type { BatchResolutionCommand, CoreCommandResult, OrchestratorCore } from "../core.js";

const LIST_USAGE = "USAGE: batches <run-id>";
const RESOLVE_USAGE = "USAGE: resolve-batch <run-id> <submission-id> <version> provider_job <provider-job-id> --by=<actor> | resolve-batch <run-id> <submission-id> <version> not_submitted|abandon --by=<actor>";

/** `batches <run-id>` lists the run's provider batch submissions; uncertain ones suspend (exit 3). */
export async function executeBatches(core: OrchestratorCore, argv: readonly string[]): Promise<CoreCommandResult> {
  const [runId, ...rest] = argv;
  if (core.batches === undefined || runId === undefined || runId.startsWith("--") || rest.length !== 0) throw new Error(LIST_USAGE);
  return core.batches(runId);
}

/**
 * `resolve-batch` records one versioned operator decision for an uncertain submission,
 * the same body `POST /runs/:id/batches/:submissionId/resolve` accepts. The actor is
 * always explicit; nothing is resubmitted by this command.
 */
export async function executeResolveBatch(core: OrchestratorCore, argv: readonly string[]): Promise<CoreCommandResult> {
  if (core.resolveBatch === undefined) throw new Error(RESOLVE_USAGE);
  const actors = argv.flatMap((argument) => /^--by=(.+)$/u.exec(argument)?.[1] ?? []);
  const positional = argv.filter((argument) => !argument.startsWith("--"));
  if (actors.length !== 1 || positional.length + actors.length !== argv.length) throw new Error(RESOLVE_USAGE);
  const [runId, submissionId, version, decision, providerJobId, ...extra] = positional;
  const by = actors[0] as string;
  if (runId === undefined || submissionId === undefined || version === undefined || extra.length !== 0) throw new Error(RESOLVE_USAGE);
  let request: BatchResolutionCommand;
  if (decision === "provider_job" && providerJobId !== undefined) request = { version, decision, providerJobId, by };
  else if ((decision === "not_submitted" || decision === "abandon") && providerJobId === undefined) request = { version, decision, by };
  else throw new Error(RESOLVE_USAGE);
  return core.resolveBatch(runId, submissionId, request);
}
