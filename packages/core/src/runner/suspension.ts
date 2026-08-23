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
  return error instanceof RunSuspendedError ? error.suspension.state : "FAILED";
}
