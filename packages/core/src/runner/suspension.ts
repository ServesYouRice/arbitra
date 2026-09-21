import type { BudgetVerdict } from "../budget/budget.js";
import type { RunState } from "./events.js";

export type SuspensionReason = "budget" | "rate_limit";
export interface SuspendedRun {
  readonly state: "SUSPENDED_BUDGET" | "SUSPENDED_RATE_LIMIT";
  readonly reason: SuspensionReason;
  readonly detail: string;
  readonly completedActivityIds: readonly string[];
  readonly resumableWithoutDecision: true;
}

export class RunSuspendedError extends Error {
  constructor(readonly suspension: SuspendedRun) { super(suspension.detail); this.name = "RunSuspendedError"; }
  get state(): SuspendedRun["state"] { return this.suspension.state; }
}

/** The executor must persist the checkpoint before throwing, and recheck it on resume. */
export class RunCheckpointError extends Error {
  readonly state = "BLOCKED" as const;
  constructor(readonly artifactId: string) {
    super(`OPERATOR_CHECKPOINT:${artifactId}`);
    if (artifactId.trim() === "" || /[\r\n\0]/u.test(artifactId)) throw new Error("INVALID_CHECKPOINT_ARTIFACT_ID");
    this.name = "RunCheckpointError";
  }
}

export function suspendForBudget(verdict: BudgetVerdict, completedActivityIds: readonly string[] = []): never {
  if (verdict.status !== "suspend") throw new Error("BUDGET_VERDICT_IS_NOT_SUSPEND");
  throw new RunSuspendedError(Object.freeze({ state: "SUSPENDED_BUDGET", reason: "budget",
    detail: verdict.reasons.join(","), completedActivityIds: Object.freeze([...completedActivityIds]), resumableWithoutDecision: true }));
}

export function resumeState(suspension: SuspendedRun, conditionCleared: boolean): RunState {
  return conditionCleared ? "CREATED" : suspension.state;
}

export function planResumeAfterSuspension(
  suspension: SuspendedRun,
  activityIds: readonly string[],
): readonly { readonly activityId: string; readonly action: "replay" | "execute" }[] {
  const completed = new Set(suspension.completedActivityIds);
  return Object.freeze(activityIds.map((activityId) => Object.freeze({
    activityId,
    action: completed.has(activityId) ? "replay" as const : "execute" as const,
  })));
}

export function projectedState(error: unknown): RunState {
  return error instanceof RunCheckpointError ? "BLOCKED" : error instanceof RunSuspendedError ? error.suspension.state : "FAILED";
}
