import { useEffect, useState } from "react";
/**
 * Typed client for the localhost evaluation routes.
 *
 * The web view never imports the persistence package and never derives a metric: every
 * number here was produced by the guarded query layer, and a refusal arrives as a refusal.
 */
export interface EvaluationRow {
  readonly modelIdentity: string; readonly activityCount: number; readonly successCount: number; readonly refusalCount: number; readonly errorCount: number;
  readonly cacheHitRate: number | null; readonly repairCount: number;
  readonly recall: number | null; readonly precision: number | null; readonly falsePositiveRate: number | null;
  readonly uniqueTrueContribution: number | null; readonly marginalTrueContribution: number | null;
  readonly repairFrequency: number | null; readonly invalidEvidenceRate: number | null; readonly refusalRate: number | null;
  readonly costUsd: number | null; readonly latencyMs: number | null; readonly independenceGroup: string | null;
}
export interface EvaluationMetrics {
  readonly rows: readonly EvaluationRow[];
  readonly denominator: { readonly activityCount: number; readonly auditorCount: number; readonly groundTruthAvailable: boolean };
  readonly segmentation: readonly string[];
  readonly independence: { readonly applicable: boolean; readonly reason: string | null; readonly groups: readonly string[] };
  readonly totalCostUsd?: number | null; readonly currency?: string | null; readonly costPerTrueAcceptedIssue?: number | null;
  readonly consensusPrecision?: number | null; readonly consensusRecall?: number | null;
  readonly verificationResolutionRate?: number | null; readonly cacheHitRate?: number | null; readonly escalatedPairs?: number | null;
  readonly securityOverlapBudget?: { readonly budget: number; readonly used: number; readonly usage: number | null } | null;
  readonly suppressionCandidateCount?: number | null;
}
export interface ComparisonSide { readonly protocolIdentity: string; readonly runIds?: readonly string[] }
export interface ComparisonResult { readonly comparable: true; readonly protocolIdentity: string; readonly sides: readonly { readonly protocolIdentity: string; readonly rows: readonly unknown[] }[] }
export interface ComparisonRefusal { readonly comparable: false; readonly error: string; readonly message: string }
export const AGGREGATION_REFUSAL_STATUS = 409 as const;
export class EvaluationApi {
  constructor(private readonly baseUrl = "") {}
  async metrics(runId: string): Promise<EvaluationMetrics> {
    const response = await fetch(`${this.baseUrl}/runs/${encodeURIComponent(runId)}/metrics`);
    if (response.status === AGGREGATION_REFUSAL_STATUS) { const refusal = await response.json() as ComparisonRefusal; throw new Error(refusal.message); }
    if (!response.ok) throw new Error(`EVALUATION_API_${response.status}`);
    return await response.json() as EvaluationMetrics;
  }
  async compare(a: ComparisonSide, b: ComparisonSide): Promise<ComparisonResult | ComparisonRefusal> {
    const response = await fetch(`${this.baseUrl}/runs/compare`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ a, b }) });
    if (response.status === AGGREGATION_REFUSAL_STATUS) return await response.json() as ComparisonRefusal;
    if (!response.ok) throw new Error(`EVALUATION_API_${response.status}`);
    return await response.json() as ComparisonResult;
  }
}
export interface EvaluationState { readonly metrics: EvaluationMetrics | null; readonly state: "loading" | "loaded" | "absent" | "error"; readonly error: string | null }
export function useEvaluationMetrics(api: EvaluationApi, runId: string | null): EvaluationState {
  const [value, setValue] = useState<EvaluationState>({ metrics: null, state: "loading", error: null });
  useEffect(() => { if (runId === null) { setValue({ metrics: null, state: "absent", error: null }); return; } let active = true; setValue({ metrics: null, state: "loading", error: null });
    void api.metrics(runId).then((metrics) => { if (active) setValue({ metrics, state: "loaded", error: null }); }, (cause: unknown) => { if (active) setValue({ metrics: null, state: "error", error: cause instanceof Error ? cause.message : String(cause) }); });
    return () => { active = false; }; }, [api, runId]);
  return value;
}
/** Rendering helper: a measurement the run did not produce is never shown as zero. */
export function measured(value: number | null | undefined, suffix = ""): string { return value === null || value === undefined ? "unavailable" : `${value}${suffix}`; }
