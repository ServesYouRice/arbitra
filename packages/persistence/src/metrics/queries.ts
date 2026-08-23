import { IncomparableIdentityError, type IdentityDimension, type MetricRow, type MetricStore } from "./query.js";
import type { TraceOutcome } from "../trace.js";

/**
 * Decision-useful evaluation queries over the guarded metric substrate.
 *
 * Every aggregation goes through MetricStore, so the identity guard from TASK-020 is
 * enforced here at the query layer and never by convention in a view. Anything the run
 * did not measure is returned as null; callers render that as unavailable, never as zero.
 */

/** Per-auditor scoring produced by the ground-truth harness. Structural, so persistence does not depend on the testing package. */
export interface PremiseAuditorInput {
  readonly auditorId: string; readonly modelIdentity: string; readonly protocolIdentity: string; readonly independenceGroup: string;
  readonly recall: number; readonly precision: number | null; readonly falsePositiveRate: number | null;
  readonly uniqueTrueContribution: number; readonly marginalTrueContribution: number;
  readonly repairFrequency: number | null; readonly invalidEvidenceRate: number | null; readonly refusalRate: number | null;
  readonly cost: number; readonly latencyMs: number;
}
export interface PremiseInput {
  readonly protocolIdentity: string; readonly currency: string;
  readonly auditors: readonly PremiseAuditorInput[];
  readonly consensus: { readonly acceptedIssueCount: number; readonly trueAcceptedIssueCount: number; readonly precision: number | null; readonly recall: number; readonly costPerTrueAcceptedIssue: number | null };
}
/** Run-level counters recorded by the verification, clustering and security stages. */
export interface RunSummaryInput {
  readonly verification?: { readonly itemCount: number; readonly resolvedDisputes: number };
  readonly escalatedPairs?: number;
  readonly securityOverlapBudget?: { readonly budget: number; readonly used: number };
  readonly suppressionCandidateCount?: number;
}
export interface EvaluationFilter {
  readonly store: MetricStore;
  readonly runIds?: readonly string[];
  readonly outcomes?: readonly TraceOutcome[];
  readonly premise?: PremiseInput;
  readonly runSummary?: RunSummaryInput;
}
export interface ContributionRow {
  readonly modelIdentity: string; readonly activityCount: number; readonly successCount: number; readonly refusalCount: number; readonly errorCount: number;
  readonly cacheHitRate: number | null; readonly repairCount: number;
  readonly recall: number | null; readonly precision: number | null; readonly falsePositiveRate: number | null;
  readonly uniqueTrueContribution: number | null; readonly marginalTrueContribution: number | null;
  readonly repairFrequency: number | null; readonly invalidEvidenceRate: number | null; readonly refusalRate: number | null;
  readonly costUsd: number | null; readonly latencyMs: number | null;
  readonly independenceGroup: string | null;
}
export interface ContributionResult {
  readonly rows: readonly ContributionRow[];
  readonly denominator: { readonly activityCount: number; readonly auditorCount: number; readonly groundTruthAvailable: boolean };
  readonly segmentation: readonly IdentityDimension[];
  /** Null-not-applicable, per §25.7: one auditor produces no independence data at all. */
  readonly independence: { readonly applicable: boolean; readonly reason: string | null; readonly groups: readonly string[] };
}
export interface CostResult {
  readonly rows: readonly ContributionRow[];
  readonly totalCostUsd: number | null;
  readonly currency: string | null;
  readonly costPerTrueAcceptedIssue: number | null;
  readonly consensusPrecision: number | null;
  readonly consensusRecall: number | null;
  readonly verificationResolutionRate: number | null;
  readonly cacheHitRate: number | null;
  readonly escalatedPairs: number | null;
  readonly securityOverlapBudget: { readonly budget: number; readonly used: number; readonly usage: number | null } | null;
  readonly suppressionCandidateCount: number | null;
  readonly segmentation: readonly IdentityDimension[];
}
export interface ProtocolComparisonSide { readonly store: MetricStore; readonly protocolIdentity: string; readonly runIds?: readonly string[] }
export interface ProtocolComparisonResult {
  readonly comparable: true;
  readonly protocolIdentity: string;
  readonly sides: readonly { readonly protocolIdentity: string; readonly rows: readonly MetricRow[] }[];
}
export class CrossProtocolComparisonError extends Error {
  constructor(readonly left: string, readonly right: string) {
    super(`CROSS_PROTOCOL_COMPARISON_REFUSED: ${left} and ${right} are different protocol identities; metrics recorded under different protocol versions are not comparable`);
    this.name = "CrossProtocolComparisonError";
  }
}

export function contributionQuery(filter: EvaluationFilter): ContributionResult {
  const rows = queryRows(filter, ["model"]);
  const premise = filter.premise ?? null;
  const byModel = new Map((premise?.auditors ?? []).map((auditor) => [auditor.modelIdentity, auditor]));
  const groups = [...new Set((premise?.auditors ?? []).map(({ independenceGroup }) => independenceGroup))].sort();
  const auditorCount = premise?.auditors.length ?? 0;
  return Object.freeze({
    rows: Object.freeze(rows.map((row) => contributionRow(row, byModel.get(String(row.group.model ?? ""))))),
    denominator: Object.freeze({ activityCount: rows.reduce((total, { activityCount }) => total + activityCount, 0), auditorCount, groundTruthAvailable: premise !== null }),
    segmentation: Object.freeze<IdentityDimension[]>(["model"]),
    independence: Object.freeze(auditorCount < 2
      ? { applicable: false, reason: auditorCount === 0 ? "no_ground_truth_measurement" : "single_auditor_run_produces_no_independence_data", groups: Object.freeze(groups) }
      : { applicable: true, reason: null, groups: Object.freeze(groups) }),
  });
}

export function costQuery(filter: EvaluationFilter): CostResult {
  const contribution = contributionQuery(filter);
  const costs = contribution.rows.map(({ costUsd }) => costUsd);
  const cacheValues = contribution.rows.flatMap(({ cacheHitRate }) => cacheHitRate === null ? [] : [cacheHitRate]);
  const verification = filter.runSummary?.verification;
  const overlap = filter.runSummary?.securityOverlapBudget;
  return Object.freeze({
    rows: contribution.rows,
    totalCostUsd: costs.some((value) => value === null) ? null : round(costs.reduce<number>((total, value) => total + (value ?? 0), 0)),
    currency: filter.premise?.currency ?? null,
    costPerTrueAcceptedIssue: filter.premise?.consensus.costPerTrueAcceptedIssue ?? null,
    consensusPrecision: filter.premise?.consensus.precision ?? null,
    consensusRecall: filter.premise?.consensus.recall ?? null,
    verificationResolutionRate: verification === undefined || verification.itemCount === 0 ? null : round(verification.resolvedDisputes / verification.itemCount),
    cacheHitRate: cacheValues.length === 0 ? null : round(cacheValues.reduce((total, value) => total + value, 0) / cacheValues.length),
    escalatedPairs: filter.runSummary?.escalatedPairs ?? null,
    securityOverlapBudget: overlap === undefined ? null : Object.freeze({ budget: overlap.budget, used: overlap.used, usage: overlap.budget === 0 ? null : round(overlap.used / overlap.budget) }),
    suppressionCandidateCount: filter.runSummary?.suppressionCandidateCount ?? null,
    segmentation: contribution.segmentation,
  });
}

export function protocolComparison(a: ProtocolComparisonSide, b: ProtocolComparisonSide): ProtocolComparisonResult {
  if (a.protocolIdentity !== b.protocolIdentity) throw new CrossProtocolComparisonError(a.protocolIdentity, b.protocolIdentity);
  return Object.freeze({
    comparable: true as const,
    protocolIdentity: a.protocolIdentity,
    sides: Object.freeze([a, b].map((side) => Object.freeze({ protocolIdentity: side.protocolIdentity, rows: side.store.query({ ...(side.runIds === undefined ? {} : { runIds: side.runIds }), groupBy: ["model", "protocol"] }) }))),
  });
}

export { IncomparableIdentityError };

function queryRows(filter: EvaluationFilter, groupBy: readonly IdentityDimension[]): readonly MetricRow[] {
  return filter.store.query({ ...(filter.runIds === undefined ? {} : { runIds: filter.runIds }), ...(filter.outcomes === undefined ? {} : { outcomes: filter.outcomes }), groupBy: [...groupBy] });
}
function contributionRow(row: MetricRow, auditor: PremiseAuditorInput | undefined): ContributionRow {
  return Object.freeze({
    modelIdentity: String(row.group.model ?? "unavailable"), activityCount: row.activityCount, successCount: row.successCount, refusalCount: row.refusalCount, errorCount: row.errorCount,
    cacheHitRate: row.cacheHitRate, repairCount: row.repairCount,
    recall: auditor?.recall ?? null, precision: auditor?.precision ?? null, falsePositiveRate: auditor?.falsePositiveRate ?? null,
    uniqueTrueContribution: auditor?.uniqueTrueContribution ?? null, marginalTrueContribution: auditor?.marginalTrueContribution ?? null,
    repairFrequency: auditor?.repairFrequency ?? null, invalidEvidenceRate: auditor?.invalidEvidenceRate ?? null, refusalRate: auditor?.refusalRate ?? null,
    costUsd: row.costUsd, latencyMs: auditor?.latencyMs ?? null,
    independenceGroup: auditor?.independenceGroup ?? null,
  });
}
function round(value: number): number { return Math.round(value * 1_000_000) / 1_000_000; }
