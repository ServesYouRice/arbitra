import type { CoreCommandResult } from "../core.js";

export interface DiffCommandPort { diff(runA: string, runB: string): Promise<CoreCommandResult> }
export async function executeDiff(core: DiffCommandPort, argv: readonly string[]): Promise<CoreCommandResult> {
  const [runA, runB, extra] = argv;
  if (runA === undefined || runB === undefined || extra !== undefined) return { disposition: "system_failure", reasons: ["invalid_arguments:diff"], value: null };
  return core.diff(runA, runB);
}
