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
  respondCheckpoint?(runId: string, checkpointId: string, version: string, decision: string): Promise<CoreCommandResult>;
  /** Provider batch submissions of a run, with uncertain ones and their recorded evidence. */
  batches?(runId: string): Promise<CoreCommandResult>;
  resolveBatch?(runId: string, submissionId: string, request: BatchResolutionCommand): Promise<CoreCommandResult>;
  requirements?(runId: string): Promise<CoreCommandResult>;
  /** Operator-authored graphs: list, show one version, validate or save a graph file. */
  workflow?(request: WorkflowCommand): Promise<CoreCommandResult>;
  applyRequirementsRevision?(runId: string, artifactId: string): Promise<CoreCommandResult>;
  approveRequirements?(runId: string, artifactId: string, ambiguityIds: readonly string[]): Promise<CoreCommandResult>;
  reviseRequirements?(runId: string, artifactId: string, draftPath: string): Promise<CoreCommandResult>;
  validate(configPath: string): Promise<CoreCommandResult>;
  estimate(configPath: string): Promise<CoreCommandResult>;
  /** `incremental` names a completed base Audit run, exactly as `POST /runs` accepts it. */
  run(configPath: string, options?: { readonly incremental?: { readonly baseRunId: string } }): Promise<CoreCommandResult>;
  incremental?(runId: string): Promise<CoreCommandResult>;
  /** Apply a Testing run's verified change set to an operator-named checkout, compare-and-swap per file. */
  applyChanges?(runId: string, targetDirectory: string): Promise<CoreCommandResult>;
  audit(request: { readonly preset: string; readonly target: AuditCliTarget }): Promise<CoreCommandResult>;
  status(runId: string): Promise<CoreCommandResult>;
  resume(runId: string): Promise<CoreCommandResult>;
  replay(runId: string, overrides: { readonly consensusPolicy: "full" | "risk_weighted" | "minimal"; readonly maximumRounds: 1 | 2 | 3; readonly criticEnabled: boolean }): Promise<CoreCommandResult>;
  replayRequest?(runId: string, requestPath: string): Promise<CoreCommandResult>;
  diff(runA: string, runB: string): Promise<CoreCommandResult>;
  trace(runId: string): Promise<CoreCommandResult>;
  exportRun(runId: string, format: "json"): Promise<CoreCommandResult>;
  report(runId: string): Promise<CoreCommandResult>;
}

export type BatchResolutionCommand = { readonly version: string; readonly by: string } & (
  | { readonly decision: "provider_job"; readonly providerJobId: string }
  | { readonly decision: "not_submitted" | "abandon" });

export type WorkflowCommand =
  | { readonly action: "list" }
  | { readonly action: "show"; readonly graphId: string; readonly version?: string }
  | { readonly action: "validate" | "save"; readonly graphPath: string; readonly configurationId?: string; readonly parentVersion?: string; readonly authorize: readonly string[] };
