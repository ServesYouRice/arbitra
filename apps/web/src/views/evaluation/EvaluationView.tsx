import "./evaluation.css";
import { useState, type ReactElement } from "react";
import { EvaluationApi, measured, useEvaluationMetrics, type ComparisonRefusal, type ComparisonResult, type ConfirmedYield, type EvaluationRow, type PlanResults } from "./api.js";
import { modelName } from "../../pages/run/models.js";
export interface EvaluationViewProps { readonly runId: string | null; readonly api?: EvaluationApi }
const AUDITOR_COLUMNS: readonly (readonly [string, (row: EvaluationRow) => string])[] = Object.freeze([
  ["model identity", (row) => [row.modelIdentity, row.protocolIdentity, row.harnessIdentity].filter(Boolean).join(" / ")],
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
    {metrics.confirmedYield === null || metrics.confirmedYield === undefined ? null : <Confirmed value={metrics.confirmedYield} carried={metrics.planResults ?? null} />}
    <p className="evaluation-denominator">segmented by {metrics.segmentation.join(", ") || "nothing"} · {metrics.denominator.activityCount} model activity attempts · {metrics.denominator.auditorCount} scored auditors · ground truth {metrics.denominator.groundTruthAvailable ? "available" : "unavailable"}</p>
    <p className="state" data-state={metrics.independence.applicable ? "verified" : "unexamined"}>independence · {metrics.independence.applicable ? `applicable · groups ${metrics.independence.groups.join(", ")}` : `not applicable · ${metrics.independence.reason ?? "reason unavailable"}`}</p>
    <table aria-label="per-auditor contribution"><thead><tr>{AUDITOR_COLUMNS.map(([label]) => <th key={label} scope="col">{label}</th>)}</tr></thead>
      <tbody>{metrics.rows.map((row) => <tr key={JSON.stringify([row.modelIdentity, row.protocolIdentity, row.harnessIdentity])}>{AUDITOR_COLUMNS.map(([label, read]) => { const value = read(row); return <td className={value === "unavailable" ? "state" : undefined} data-state={value === "unavailable" ? "unexamined" : undefined} key={label}>{value}</td>; })}</tr>)}</tbody></table>
    <dl aria-label="per-run evaluation">
      <div><dt>consensus precision</dt><dd>{measured(metrics.consensusPrecision)}</dd></div>
      <div><dt>consensus recall</dt><dd>{measured(metrics.consensusRecall)}</dd></div>
      <div><dt>verification resolution rate</dt><dd>{measured(metrics.verificationResolutionRate)}</dd></div>
      <div><dt>cache hit rate</dt><dd>{measured(metrics.cacheHitRate)}</dd></div>
      <div><dt>escalated pairs</dt><dd>{measured(metrics.escalatedPairs)}</dd></div>
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
/** "Confirmed" is the verifier's answer from the source, so the section says so rather than calling it precision. */
function Confirmed({ value, carried }: { readonly value: ConfirmedYield; readonly carried: PlanResults | null }): ReactElement {
  const severities = Object.entries(value.confirmedBySeverity).map(([severity, count]) => `${severity} ${count}`).join(", ");
  return <section aria-labelledby="confirmed-title" className="evaluation-confirmed">
    <h3 className="panel-title" id="confirmed-title">checked against the source</h3>
    <p>{value.confirmed} of {value.candidates} candidates confirmed{severities === "" ? "" : ` · ${severities}`} · {value.tokensPerConfirmed === null ? "tokens per confirmed issue unavailable" : `${tokenCount(value.tokensPerConfirmed)} tokens per confirmed issue`}</p>
    {carried === null ? null : <p>plan carried out · {carried.reported} of {carried.issues} issues reported · {carried.provenByFailingTest} proven by a failing test{carried.checkedEndToEnd === undefined ? "" : ` · ${carried.checkedEndToEnd} checked end to end`} · {Object.entries(carried.results).map(([result, count]) => `${result.replaceAll("_", " ")} ${count}`).join(" · ")}{(carried.foundWhileFixing?.reported ?? 0) === 0 ? "" : ` · ${carried.foundWhileFixing?.reported ?? 0} more found while fixing`}</p>}
    <p className="evaluation-denominator">{value.rejected} rejected · {value.unsettled} the source could not settle · {value.acceptedUnchecked} accepted without a check · {value.notChecked} not checked. Confirmed means the verifier found the defect in the source; no answer key checked it.</p>
    <table aria-label="confirmed by auditor"><thead><tr>{["auditor", "findings", "confirmed", "found by it alone", "discovery tokens"].map((label) => <th key={label} scope="col">{label}</th>)}</tr></thead>
      <tbody>{value.auditors.map((auditor) => <tr key={auditor.auditorId}><td>{auditor.modelId === null ? auditor.auditorId : modelName(auditor.modelId)}</td><td>{auditor.findings}</td><td>{auditor.confirmed}</td><td>{auditor.confirmedAlone}</td>
        <td className={auditor.discoveryTokens === null ? "state" : undefined} data-state={auditor.discoveryTokens === null ? "unexamined" : undefined}>{auditor.discoveryTokens === null ? "unavailable" : tokenCount(auditor.discoveryTokens)}</td></tr>)}</tbody></table>
  </section>;
}
const COMPACT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
function tokenCount(value: number): string { return COMPACT.format(value); }
const SHARED_EVALUATION_API = new EvaluationApi();
