import type { ResultDisposition } from "./exit-policy.js";
import type { AuditCliTarget } from "./commands/audit.js";

export interface CoreCommandResult {
  readonly disposition: ResultDisposition;
  readonly reasons?: readonly string[];
  readonly value?: unknown;
}

/**
 * The CLI depends on the orchestration core through this narrow port. Production and
 * tests supply the same operations; command handlers contain no workflow execution.
 */
export interface OrchestratorCore {
  validate(configPath: string): Promise<CoreCommandResult>;
  estimate(configPath: string): Promise<CoreCommandResult>;
  run(configPath: string): Promise<CoreCommandResult>;
  audit(request: { readonly preset: string; readonly target: AuditCliTarget }): Promise<CoreCommandResult>;
  status(runId: string): Promise<CoreCommandResult>;
  resume(runId: string): Promise<CoreCommandResult>;
  replay(runId: string, overrides: { readonly consensusPolicy: "full" | "risk_weighted" | "minimal"; readonly maximumRounds: 1 | 2 | 3; readonly criticEnabled: boolean }): Promise<CoreCommandResult>;
  diff(runA: string, runB: string): Promise<CoreCommandResult>;
  trace(runId: string): Promise<CoreCommandResult>;
  exportRun(runId: string, format: "json"): Promise<CoreCommandResult>;
  report(runId: string): Promise<CoreCommandResult>;
}
