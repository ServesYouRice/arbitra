import { estimateRun, type ResolvedEstimateConfig, type RunEstimate, type SnapshotSummary } from "./estimate.js";

export type BudgetVerdict =
  | { readonly status: "within_budget"; readonly estimate: RunEstimate }
  | { readonly status: "downscale"; readonly estimate: RunEstimate; readonly maximumCalls: number; readonly reasons: readonly string[] }
  | { readonly status: "suspend"; readonly estimate: RunEstimate; readonly reasons: readonly string[] };

export class BudgetGate {
  preflight(config: ResolvedEstimateConfig, snapshot: SnapshotSummary): BudgetVerdict {
    const estimate = estimateRun(config, snapshot);
    const reasons: string[] = [];
    if (config.budget.maximumTokens !== null && estimate.tokens.maximum > config.budget.maximumTokens) reasons.push("maximum_token_budget_exceeded");
    if (config.budget.maximumCostUsd !== null) {
      if (estimate.cost.maximum === null) reasons.push("cost_unknown_under_hard_cost_budget");
      else if (estimate.cost.maximum > config.budget.maximumCostUsd) reasons.push("maximum_cost_budget_exceeded");
    }
    if (reasons.length === 0) return Object.freeze({ status: "within_budget", estimate });
    if (config.allowDownscale) {
      const totalCalls = config.calls.reduce((total, call) => total + call.calls, 0);
      const tokenRatio = config.budget.maximumTokens === null ? 1 : config.budget.maximumTokens / Math.max(1, estimate.tokens.maximum);
      const costRatio = config.budget.maximumCostUsd === null || estimate.cost.maximum === null ? 1 : config.budget.maximumCostUsd / Math.max(Number.EPSILON, estimate.cost.maximum);
      const maximumCalls = Math.floor(totalCalls * Math.min(tokenRatio, costRatio));
      if (maximumCalls > 0) return Object.freeze({ status: "downscale", estimate, maximumCalls, reasons: Object.freeze(reasons) });
    }
    return Object.freeze({ status: "suspend", estimate, reasons: Object.freeze(reasons) });
  }
}
