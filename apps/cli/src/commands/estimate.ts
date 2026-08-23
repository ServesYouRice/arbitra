import type { CoreCommandResult, OrchestratorCore } from "../core.js";

/** CLI adapter only; the orchestration core owns the canonical estimator and never dispatches here. */
export async function executeEstimate(core: OrchestratorCore, configPath: string): Promise<CoreCommandResult> {
  return core.estimate(configPath);
}
