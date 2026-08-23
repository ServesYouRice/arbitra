export interface CheckpointContext {
  readonly tainted: boolean;
  readonly effectiveWriteScope: readonly string[];
  readonly executionPolicy: "derived_repository_script" | "allowlisted" | "requires_approval";
}

export interface CheckpointDecision {
  readonly required: boolean;
  readonly mayProceed: boolean;
  readonly exitCode: 0 | 1 | 3;
  readonly reason: "not_required" | "checkpoint_available" | "checkpoint_unavailable";
}

export function requiresCheckpoint(context: CheckpointContext): boolean {
  return context.tainted
    && (context.effectiveWriteScope.length > 0 || context.executionPolicy === "requires_approval");
}

export function checkpointDecision(
  context: CheckpointContext,
  checkpointAvailable: boolean,
): CheckpointDecision {
  const required = requiresCheckpoint(context);
  if (!required) return Object.freeze({ required: false, mayProceed: true, exitCode: 0, reason: "not_required" });
  if (checkpointAvailable) {
    return Object.freeze({ required: true, mayProceed: false, exitCode: 3, reason: "checkpoint_available" });
  }
  return Object.freeze({ required: true, mayProceed: false, exitCode: 1, reason: "checkpoint_unavailable" });
}
