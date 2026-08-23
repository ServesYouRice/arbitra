export const VERIFICATION_METHODS = Object.freeze(["cited_lines", "symbol_or_call_path", "route_config_middleware", "dependency_or_import_path", "allowlisted_safe_test", "bounded_deterministic_check"] as const);
export type VerificationMethod = typeof VERIFICATION_METHODS[number] | "single_model_question";
export type VerificationOutcome = "CONFIRMED" | "REJECTED" | "STILL_NEEDS_VERIFICATION";
export interface VerificationItem { readonly candidateId: string; readonly severity: "critical" | "high" | "medium" | "low" | "informational"; readonly claim: string; readonly question: string; readonly citedEvidenceIds: readonly string[]; readonly citedContext: readonly { readonly evidenceId: string; readonly text: string }[]; readonly symbols: readonly string[]; readonly routes: readonly string[]; readonly dependencies: readonly string[]; readonly allowlistedTest?: string }
export interface VerificationAttempt { readonly method: Exclude<VerificationMethod, "single_model_question">; readonly verdict: "confirmed" | "rejected" | "inconclusive"; readonly evidenceIds: readonly string[]; readonly artifactRefs: readonly string[]; readonly toolCallIds: readonly string[]; readonly activityId: string; readonly confidence: number | null }
export interface VerificationTools {
  readCitedLines(item: VerificationItem): Promise<VerificationAttempt>;
  searchSymbolOrCallPath(item: VerificationItem): Promise<VerificationAttempt>;
  inspectRouteConfigMiddleware(item: VerificationItem): Promise<VerificationAttempt>;
  inspectDependencyOrImportPath(item: VerificationItem): Promise<VerificationAttempt>;
  runAllowlistedSafeTest(item: VerificationItem, policy: { readonly executionPolicy: "derived_repository_script"; readonly command: string }): Promise<VerificationAttempt>;
  boundedDeterministicCheck(item: VerificationItem): Promise<VerificationAttempt>;
}

export async function runDeterministicLadder(item: VerificationItem, tools: VerificationTools): Promise<{ readonly resolved: VerificationAttempt | null; readonly attempts: readonly VerificationAttempt[] }> {
  const calls: Array<() => Promise<VerificationAttempt>> = [
    () => tools.readCitedLines(item), () => tools.searchSymbolOrCallPath(item), () => tools.inspectRouteConfigMiddleware(item), () => tools.inspectDependencyOrImportPath(item),
    ...(item.allowlistedTest === undefined ? [] : [() => tools.runAllowlistedSafeTest(item, { executionPolicy: "derived_repository_script", command: item.allowlistedTest! })]),
    () => tools.boundedDeterministicCheck(item),
  ];
  const attempts: VerificationAttempt[] = [];
  for (const invoke of calls) { const attempt = await invoke(); validateAttempt(attempt); attempts.push(attempt); if (attempt.verdict !== "inconclusive") return Object.freeze({ resolved: attempt, attempts: Object.freeze(attempts) }); }
  return Object.freeze({ resolved: null, attempts: Object.freeze(attempts) });
}
function validateAttempt(attempt: VerificationAttempt): void { if (!VERIFICATION_METHODS.includes(attempt.method) || attempt.activityId.trim() === "" || !Number.isFinite(attempt.confidence ?? 0) || (attempt.confidence !== null && (attempt.confidence < 0 || attempt.confidence > 1))) throw new Error("INVALID_VERIFICATION_ATTEMPT"); }
