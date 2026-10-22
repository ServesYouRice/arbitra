import type { ModelActivityTraceRecord } from "@arbitra/persistence/trace.js";
import type { CanonicalIssueSet } from "@arbitra/workflow/nodes/canonical-issues.js";

const SEVERITIES = ["critical", "high", "medium", "low", "informational"] as const;

/** One auditor's part in what a run confirmed. */
export interface AuditorYield {
  readonly auditorId: string;
  readonly modelId: string | null;
  /** Findings it reported in discovery. */
  readonly findings: number;
  /** Confirmed issues it reported in discovery. */
  readonly confirmed: number;
  /** Confirmed issues no other auditor reported in discovery. */
  readonly confirmedAlone: number;
  /** Recorded tokens of its discovery calls. */
  readonly discoveryTokens: number | null;
}

/**
 * What a run checked against the source, and what it paid for each confirmed issue.
 *
 * "Confirmed" means the verifier answered CONFIRMED from the source. It is not ground truth, which only a benchmark's
 * key gives (`costPerTrueAcceptedIssue`). An issue accepted without a check, such as one below the plan's severity
 * bar, is counted apart and never as confirmed. An auditor's findings are its discovery findings only: what it adds in
 * peer review was written after reading the other auditors' findings, so it cannot count as found alone.
 */
export interface ConfirmedYield {
  readonly candidates: number;
  readonly confirmed: number;
  readonly confirmedBySeverity: Readonly<Partial<Record<(typeof SEVERITIES)[number], number>>>;
  readonly rejected: number;
  /** The verifier answered that the source cannot settle the issue. */
  readonly unsettled: number;
  readonly acceptedUnchecked: number;
  /** Neither checked nor accepted: below the plan's severity bar, or left open. */
  readonly notChecked: number;
  readonly tokens: number | null;
  readonly tokensPerConfirmed: number | null;
  readonly auditors: readonly AuditorYield[];
}

export function confirmedYield(set: CanonicalIssueSet, models: Readonly<Record<string, { readonly modelId?: string }>>, traces: readonly ModelActivityTraceRecord[]): ConfirmedYield {
  const confirmed = set.issues.filter(({ verificationOutcome, disposition }) => verificationOutcome === "CONFIRMED" && (disposition === "accepted" || disposition === "verified_single_source"));
  const confirmedIds = new Set(confirmed.map(({ candidateId }) => candidateId));
  const bySeverity: Partial<Record<(typeof SEVERITIES)[number], number>> = {};
  for (const severity of SEVERITIES) { const count = confirmed.filter((issue) => issue.severity === severity).length; if (count > 0) bySeverity[severity] = count; }
  const rejected = set.issues.filter(({ disposition }) => disposition === "rejected").length;
  const unsettled = set.issues.filter(({ disposition, verificationOutcome }) => disposition !== "rejected" && verificationOutcome === "STILL_NEEDS_VERIFICATION").length;
  const acceptedUnchecked = set.issues.filter(({ disposition, verificationOutcome }) => disposition === "accepted" && verificationOutcome === null).length;
  const tokens = recordedTokens(traces);
  const discoverers = (sourceFindingIds: readonly string[]) => new Set(sourceFindingIds.filter(isDiscoveryFinding).map(auditorOf));
  const auditorIds = [...new Set([...Object.keys(models).filter((alias) => alias.startsWith("auditor-")), ...set.issues.flatMap(({ sourceFindingIds }) => [...discoverers(sourceFindingIds)])])].sort();
  const auditors = auditorIds.map((auditorId): AuditorYield => {
    const found = set.issues.filter(({ sourceFindingIds }) => discoverers(sourceFindingIds).has(auditorId));
    const foundConfirmed = found.filter(({ candidateId }) => confirmedIds.has(candidateId));
    return Object.freeze({
      auditorId, modelId: models[auditorId]?.modelId ?? null,
      findings: set.issues.reduce((total, { sourceFindingIds }) => total + sourceFindingIds.filter((id) => isDiscoveryFinding(id) && auditorOf(id) === auditorId).length, 0),
      confirmed: foundConfirmed.length,
      confirmedAlone: foundConfirmed.filter(({ sourceFindingIds }) => discoverers(sourceFindingIds).size === 1).length,
      discoveryTokens: recordedTokens(traces.filter(({ nodeId }) => nodeId === auditorId)),
    });
  });
  return Object.freeze({
    candidates: set.issues.length, confirmed: confirmed.length, confirmedBySeverity: Object.freeze(bySeverity), rejected, unsettled, acceptedUnchecked,
    notChecked: set.issues.length - confirmed.length - rejected - unsettled - acceptedUnchecked,
    tokens, tokensPerConfirmed: tokens === null || confirmed.length === 0 ? null : Math.round(tokens / confirmed.length),
    auditors: Object.freeze(auditors),
  });
}

/** Source finding IDs begin with the auditor; peer review's carry `review-<round>` next (`auditor-a/review-1/...`). */
function isDiscoveryFinding(id: string): boolean { return !/^review-\d+$/u.test(id.split("/")[1] ?? ""); }
function auditorOf(id: string): string { return id.split("/")[0] ?? id; }

function recordedTokens(traces: readonly ModelActivityTraceRecord[]): number | null {
  const recorded = traces.filter(({ tokenUsage }) => tokenUsage != null);
  return recorded.length === 0 ? null : recorded.reduce((total, { tokenUsage }) => total + (tokenUsage?.inputTokens ?? 0) + (tokenUsage?.outputTokens ?? 0), 0);
}
