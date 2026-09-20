import { queryActivityTraces } from "@arbitra/persistence/metrics/query.js";
import type { ModelActivityTraceRecord } from "@arbitra/persistence/trace.js";
import type { RunStore } from "./run-store.js";
import { readStage } from "./pipeline.js";
import { modelIdentity, harnessIdentity, protocolIdentity } from "@arbitra/persistence/index-db/rebuild.js";

/** Operational measurements do not establish ground-truth model quality. */
export async function evaluationMetrics(store: RunStore, traces: readonly ModelActivityTraceRecord[]) {
  const artifacts = await store.listArtifacts();
  const optional = async <T>(kind: string): Promise<T | null> => artifacts.some((artifact) => artifact.kind === kind) ? readStage<T>(store, kind) : null;
  const clustering = await optional<{ metrics: { escalatedPairs: number } }>("clustering");
  const verification = await optional<{ itemCount: number; resolvedDisputes: number; deferredItemIds: string[] }>("verification-metrics");
  const verificationCount = verification === null ? 0 : verification.itemCount + verification.deferredItemIds.length;
  const issues = await optional<{ coverage: { suppressionCandidates: unknown[] }; summary: { auditorCount: number } }>("canonical-issues");
  const cacheRate = (values: readonly ModelActivityTraceRecord[]): number | null => {
    if (values.length === 0 || values.some(({ tokenUsage }) => tokenUsage?.inputTokens == null || tokenUsage.cacheReadTokens === null)) return null;
    const input = values.reduce((total, { tokenUsage }) => total + (tokenUsage?.inputTokens ?? 0), 0);
    return input === 0 ? null : values.reduce((total, { tokenUsage }) => total + (tokenUsage?.cacheReadTokens ?? 0), 0) / input;
  };
  const rows = queryActivityTraces(traces, { groupBy: ["model", "harness", "protocol"] }).map((row) => {
    const members = traces.filter((trace) => modelIdentity(trace) === row.group.model && harnessIdentity(trace) === row.group.harness && protocolIdentity(trace) === row.group.protocol);
    return {
    ...row, modelIdentity: row.group.model, harnessIdentity: row.group.harness, protocolIdentity: row.group.protocol,
    recall: null, precision: null, falsePositiveRate: null, uniqueTrueContribution: null, marginalTrueContribution: null,
    repairFrequency: null, invalidEvidenceRate: null, refusalRate: row.activityCount === 0 ? null : row.refusalCount / row.activityCount,
    cacheHitRate: cacheRate(members), latencyMs: members.reduce((total, trace) => total + trace.durationMs, 0) / members.length, independenceGroup: null,
  }; });
  const knownSum = (values: readonly (number | null)[]): number | null => values.length === 0 || values.some((value) => value === null) ? null : values.reduce<number>((total, value) => total + (value ?? 0), 0);
  const totalCostUsd = knownSum(traces.map(({ costUsd }) => costUsd));
  return {
    rows, denominator: { activityCount: traces.length, auditorCount: 0, groundTruthAvailable: false },
    configuredAuditorCount: issues?.summary.auditorCount ?? null,
    segmentation: ["model", "harness", "protocol"],
    independence: { applicable: false, reason: traces.length === 0 ? "no_recorded_provider_activity" : "no_ground_truth_measurement", groups: [] },
    totalCostUsd, currency: totalCostUsd === null ? null : "USD", costPerTrueAcceptedIssue: null,
    inputTokens: knownSum(traces.map(({ tokenUsage }) => tokenUsage?.inputTokens ?? null)),
    outputTokens: knownSum(traces.map(({ tokenUsage }) => tokenUsage?.outputTokens ?? null)),
    consensusPrecision: null, consensusRecall: null, verificationResolutionRate: verification === null || verificationCount === 0 ? null : verification.resolvedDisputes / verificationCount,
    cacheHitRate: cacheRate(traces), escalatedPairs: clustering?.metrics.escalatedPairs ?? null,
    securityOverlapBudget: null, suppressionCandidateCount: issues?.coverage.suppressionCandidates.length ?? null,
  };
}
