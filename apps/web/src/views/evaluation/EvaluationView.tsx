import { useState, type ReactElement } from "react";
import { EvaluationApi, measured, useEvaluationMetrics, type ComparisonRefusal, type ComparisonResult, type EvaluationRow } from "./api.js";
export interface EvaluationViewProps { readonly runId: string | null; readonly api?: EvaluationApi }
const AUDITOR_COLUMNS: readonly (readonly [string, (row: EvaluationRow) => string])[] = Object.freeze([
  ["model identity", (row) => row.modelIdentity],
  ["independence group", (row) => row.independenceGroup ?? "unavailable"],
  ["recall", (row) => measured(row.recall)],
  ["precision", (row) => measured(row.precision)],
  ["false-positive rate", (row) => measured(row.falsePositiveRate)],
  ["unique true contribution", (row) => measured(row.uniqueTrueContribution)],
  ["marginal contribution", (row) => measured(row.marginalTrueContribution)],
  ["repair frequency", (row) => measured(row.repairFrequency)],
  ["invalid-evidence rate", (row) => measured(row.invalidEvidenceRate)],
  ["refusal rate", (row) => measured(row.refusalRate)],
  ["cost", (row) => measured(row.costUsd)],
  ["latency", (row) => measured(row.latencyMs, "ms")],
]);
export function EvaluationView({ runId, api = SHARED_EVALUATION_API }: EvaluationViewProps): ReactElement {
  const { metrics, state, error } = useEvaluationMetrics(api, runId);
  const [comparison, setComparison] = useState<ComparisonResult | ComparisonRefusal | null>(null);
  const [sides, setSides] = useState({ a: "", b: "" });
  if (state !== "loaded" || metrics === null) return <section aria-label="evaluation"><h2 className="panel-title">evaluation</h2><p className="state" data-state={state === "error" ? "degraded" : "unexamined"}>{state === "error" ? `metrics unavailable · ${error ?? "error"}` : `metrics ${state}`}</p></section>;
  return <section aria-label="evaluation" className="evaluation">
    <h2 className="panel-title">evaluation</h2>
    <p className="evaluation-denominator">segmented by {metrics.segmentation.join(", ") || "nothing"} · {metrics.denominator.activityCount} model activities · {metrics.denominator.auditorCount} scored auditors · ground truth {metrics.denominator.groundTruthAvailable ? "available" : "unavailable"}</p>
    <p className="state" data-state={metrics.independence.applicable ? "verified" : "unexamined"}>independence · {metrics.independence.applicable ? `applicable · groups ${metrics.independence.groups.join(", ")}` : `not applicable · ${metrics.independence.reason ?? "reason unavailable"}`}</p>
    <table aria-label="per-auditor contribution"><thead><tr>{AUDITOR_COLUMNS.map(([label]) => <th key={label} scope="col">{label}</th>)}</tr></thead>
      <tbody>{metrics.rows.map((row) => <tr key={row.modelIdentity}>{AUDITOR_COLUMNS.map(([label, read]) => { const value = read(row); return <td className={value === "unavailable" ? "state" : undefined} data-state={value === "unavailable" ? "unexamined" : undefined} key={label}>{value}</td>; })}</tr>)}</tbody></table>
    <dl aria-label="per-run evaluation">
      <div><dt>consensus precision</dt><dd>{measured(metrics.consensusPrecision)}</dd></div>
      <div><dt>consensus recall</dt><dd>{measured(metrics.consensusRecall)}</dd></div>
      <div><dt>verification resolution rate</dt><dd>{measured(metrics.verificationResolutionRate)}</dd></div>
      <div><dt>cache hit rate</dt><dd>{measured(metrics.cacheHitRate)}</dd></div>
      <div><dt>escalated pairs</dt><dd>{measured(metrics.escalatedPairs)}</dd></div>
      <div><dt>security overlap budget</dt><dd>{metrics.securityOverlapBudget === null || metrics.securityOverlapBudget === undefined ? "unavailable" : `${metrics.securityOverlapBudget.used} of ${metrics.securityOverlapBudget.budget} · usage ${measured(metrics.securityOverlapBudget.usage)}`}</dd></div>
      <div><dt>suppression candidates</dt><dd>{measured(metrics.suppressionCandidateCount)}</dd></div>
      <div><dt>total cost</dt><dd>{measured(metrics.totalCostUsd)} {metrics.currency ?? ""}</dd></div>
      <div><dt>cost per true accepted issue</dt><dd>{measured(metrics.costPerTrueAcceptedIssue)}</dd></div>
    </dl>
    <section aria-labelledby="comparison-title" className="evaluation-comparison">
      <h3 className="panel-title" id="comparison-title">protocol comparison</h3>
      <label>protocol a<input aria-label="protocol a" value={sides.a} onChange={(event) => setSides((current) => ({ ...current, a: event.target.value }))} /></label>
      <label>protocol b<input aria-label="protocol b" value={sides.b} onChange={(event) => setSides((current) => ({ ...current, b: event.target.value }))} /></label>
      <button type="button" onClick={() => { void api.compare({ protocolIdentity: sides.a }, { protocolIdentity: sides.b }).then(setComparison, (cause: unknown) => setComparison({ comparable: false, error: "EVALUATION_API_ERROR", message: cause instanceof Error ? cause.message : String(cause) })); }}>compare</button>
      {comparison === null ? <p className="state" data-state="unexamined">no comparison requested</p> : comparison.comparable
        ? <p className="state" data-state="verified">comparable · {comparison.protocolIdentity} · {comparison.sides.length} segments</p>
        : <p className="state" data-state="refuted" role="alert">refused · {comparison.error} · {comparison.message}</p>}
    </section>
  </section>;
}
const SHARED_EVALUATION_API = new EvaluationApi();
