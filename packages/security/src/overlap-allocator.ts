export interface OverlapSignal { readonly path: string; readonly level: "high" | "medium" | "low"; readonly instructionShaped: boolean; readonly securitySensitiveChanged: boolean; readonly suspiciousDirective: boolean; readonly controlPolicyChanged: boolean; readonly estimatedAdditionalTokens: number }
export interface OverlapBudget { readonly maximumAdditionalTokens: number; readonly mode: "interactive" | "ci" | "high_security"; readonly ciPolicy?: "fail_closed" | "continue_degraded" }
export interface OverlapDecision { readonly path: string; readonly disposition: "forced" | "budgeted" | "not_allocated"; readonly reason: string; readonly additionalAuditors: 0 | 1; readonly estimatedAdditionalTokens: number; readonly budgetChargedTokens: number }
export interface OverlapPlan { readonly pathsRequiringMultiAuditorOverlap: readonly string[]; readonly decisions: readonly OverlapDecision[]; readonly budget: { readonly maximumAdditionalTokens: number; readonly usedAdditionalTokens: number; readonly remainingAdditionalTokens: number }; readonly securityCoverage: { readonly degraded: boolean; readonly reason: "overlap_budget_exceeded" | null; readonly requiredAction: "none" | "offer_raise_continue_or_cancel" | "fail_closed" | "continue_degraded" } }

export function allocateOverlap(signals: readonly OverlapSignal[], budget: OverlapBudget): OverlapPlan {
  if (!Number.isSafeInteger(budget.maximumAdditionalTokens) || budget.maximumAdditionalTokens < 0) throw new Error("INVALID_SECURITY_OVERLAP_BUDGET");
  const decisions: OverlapDecision[] = []; let used = 0; let exceeded = false;
  const ordered = [...signals].sort((a, b) => forced(b) - forced(a) || levelWeight(b.level) - levelWeight(a.level) || a.estimatedAdditionalTokens - b.estimatedAdditionalTokens || a.path.localeCompare(b.path));
  for (const signal of ordered) {
    if (!Number.isSafeInteger(signal.estimatedAdditionalTokens) || signal.estimatedAdditionalTokens < 0) throw new Error(`INVALID_OVERLAP_ESTIMATE:${signal.path}`);
    const forceReason = forceReasonOf(signal);
    if (forceReason !== null) { decisions.push(decision(signal, "forced", forceReason, 1, 0)); continue; }
    if (used + signal.estimatedAdditionalTokens <= budget.maximumAdditionalTokens) { used += signal.estimatedAdditionalTokens; decisions.push(decision(signal, "budgeted", `${signal.level}_risk_security_overlap`, 1, signal.estimatedAdditionalTokens)); }
    else { exceeded = true; decisions.push(decision(signal, "not_allocated", "overlap_budget_exceeded", 0, 0)); }
  }
  const requiredAction = !exceeded ? "none" : budget.mode === "interactive" ? "offer_raise_continue_or_cancel" : budget.ciPolicy === "continue_degraded" ? "continue_degraded" : "fail_closed";
  return Object.freeze({ pathsRequiringMultiAuditorOverlap: Object.freeze(decisions.filter(({ disposition }) => disposition !== "not_allocated").map(({ path }) => path).sort()), decisions: Object.freeze(decisions), budget: Object.freeze({ maximumAdditionalTokens: budget.maximumAdditionalTokens, usedAdditionalTokens: used, remainingAdditionalTokens: budget.maximumAdditionalTokens - used }), securityCoverage: Object.freeze({ degraded: exceeded, reason: exceeded ? "overlap_budget_exceeded" : null, requiredAction }) });
}
function forced(signal: OverlapSignal): number { return forceReasonOf(signal) === null ? 0 : 1; }
function forceReasonOf(signal: OverlapSignal): string | null { if (signal.controlPolicyChanged) return "control_policy_change"; if (signal.level === "high" && signal.instructionShaped) return "high_risk_instruction_shaped_content"; if (signal.securitySensitiveChanged && signal.suspiciousDirective) return "security_sensitive_change_with_suspicious_directive"; return null; }
function levelWeight(level: OverlapSignal["level"]): number { return level === "high" ? 3 : level === "medium" ? 2 : 1; }
function decision(signal: OverlapSignal, disposition: OverlapDecision["disposition"], reason: string, additionalAuditors: 0 | 1, budgetChargedTokens: number): OverlapDecision { return Object.freeze({ path: signal.path, disposition, reason, additionalAuditors, estimatedAdditionalTokens: signal.estimatedAdditionalTokens, budgetChargedTokens }); }
