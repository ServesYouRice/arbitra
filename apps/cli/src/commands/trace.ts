import type { CoreCommandResult } from "../core.js";

export interface TraceCommandPort { trace(runId: string): Promise<CoreCommandResult> }
export async function executeTrace(core: TraceCommandPort, argv: readonly string[]): Promise<CoreCommandResult> {
  const [runId, extra] = argv;
  if (runId === undefined || extra !== undefined) return { disposition: "system_failure", reasons: ["invalid_arguments:trace"], value: null };
  return core.trace(runId);
}
