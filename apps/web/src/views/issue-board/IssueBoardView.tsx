import { useMemo, useState, type ReactElement } from "react";
import { ArtifactApi } from "../../api/artifacts.js";
import { EMPTY_FILTERS, filterIssues, filterOptions, issueRows, type IssueFilters, type IssueRow, type PersistedFinding, type PersistedIssueOp, type PersistedIssueSet, type PersistedVerification } from "./model.js";
import { RUN_ARTIFACT_KINDS, useRunArtifact } from "./run-artifacts.js";
export interface IssueBoardViewProps { readonly runId: string | null; readonly api?: ArtifactApi; readonly selectedFindingId?: string | null; readonly onSelectFinding?: (sourceFindingId: string | null) => void }
export function IssueBoardView({ runId, api = SHARED_ARTIFACT_API, selectedFindingId = null, onSelectFinding }: IssueBoardViewProps): ReactElement {
  const issueSet = useRunArtifact<PersistedIssueSet>(api, runId, RUN_ARTIFACT_KINDS.canonicalIssues);
  const findings = useRunArtifact<readonly PersistedFinding[]>(api, runId, RUN_ARTIFACT_KINDS.sourceFindings);
  const operations = useRunArtifact<readonly PersistedIssueOp[]>(api, runId, RUN_ARTIFACT_KINDS.issueOperations);
  const verifications = useRunArtifact<readonly PersistedVerification[]>(api, runId, RUN_ARTIFACT_KINDS.verificationResults);
  const [filters, setFilters] = useState<IssueFilters>(EMPTY_FILTERS);
  const [expanded, setExpanded] = useState<string | null>(null);
  const rows = useMemo(() => issueSet.value === null ? [] : issueRows({ issueSet: issueSet.value, findings: findings.value ?? [], operations: operations.value ?? [], verifications: verifications.value ?? [] }), [issueSet.value, findings.value, operations.value, verifications.value]);
  const options = useMemo(() => filterOptions(rows), [rows]);
  const visible = useMemo(() => filterIssues(rows, filters), [rows, filters]);
  if (issueSet.state !== "loaded" || issueSet.value === null) return <section aria-label="issue board"><h2 className="panel-title">issue board</h2><p className="state" data-state={issueSet.state === "error" ? "degraded" : "unexamined"}>canonical issue artifact {issueSet.state === "error" ? `unavailable · ${issueSet.error ?? "error"}` : issueSet.state}</p></section>;
  const { summary, coverage, limitations, minorityFindingIds } = issueSet.value;
  return <section aria-label="issue board" className="issue-board">
    <h2 className="panel-title">issue board</h2>
    <p className="board-summary">{summary.auditorCount} auditors · {summary.sourceFindingCount} source findings · {summary.acceptedCount} accepted · {summary.rejectedCount} rejected · {summary.unresolvedCount} unresolved · {summary.singleSourceCount} single-source</p>
    <ul aria-label="run coverage summary" className="board-coverage">
      <li className="state" data-state={coverage.securityCoverage.degraded ? "degraded" : "verified"}>security coverage · {coverage.securityCoverage.degraded ? `degraded · ${coverage.securityCoverage.reason ?? "reason unavailable"}` : "complete"}</li>
      <li className="state" data-state={coverage.suppressionCandidates.length === 0 ? "verified" : "tainted"}>suppression candidates · {coverage.suppressionCandidates.length}</li>
      <li className="state" data-state={coverage.unexaminedSurfaces.length === 0 ? "verified" : "unexamined"}>unexamined surfaces · {coverage.unexaminedSurfaces.length}</li>
      <li className="state" data-state={minorityFindingIds.length === 0 ? "verified" : "dissent"}>minority findings retained · {minorityFindingIds.length}</li>
    </ul>
    {coverage.suppressionCandidates.length === 0 ? null : <ul aria-label="suppression candidates">{coverage.suppressionCandidates.map(({ path, instructionRisk, readBy, note }) => <li className="state" data-state="tainted" key={path}>{path} · instruction risk {instructionRisk} · read by {readBy.join(", ") || "no auditor"} · {note}</li>)}</ul>}
    {coverage.unexaminedSurfaces.length === 0 ? null : <ul aria-label="unexamined surfaces">{coverage.unexaminedSurfaces.map(({ surfaceId, weight, riskScore, paths, reasons }) => <li className="state" data-state="unexamined" key={surfaceId}>{surfaceId} · {weight} · risk {riskScore} · {paths.join(", ")} · {reasons.join(", ")}</li>)}</ul>}
    {limitations.length === 0 ? null : <ul aria-label="recorded limitations">{limitations.map((limitation) => <li className="state" data-state="degraded" key={limitation}>{limitation}</li>)}</ul>}
    <div className="board-filters">
      {(["severity", "status", "auditor", "category", "consensusState", "verificationOutcome"] as const).map((field) => <label key={field}>{FILTER_LABELS[field]}<select aria-label={FILTER_LABELS[field]} value={filters[field] ?? ""} onChange={(event) => setFilters((current) => ({ ...current, [field]: event.target.value === "" ? null : event.target.value }))}><option value="">any</option>{options[field].map((value) => <option key={value}>{value}</option>)}</select></label>)}
      <label>blocker<select aria-label="blocker" value={filters.blocker === null ? "" : String(filters.blocker)} onChange={(event) => setFilters((current) => ({ ...current, blocker: event.target.value === "" ? null : event.target.value === "true" }))}><option value="">any</option><option value="true">true</option><option value="false">false</option></select></label>
      <button type="button" onClick={() => setFilters(EMPTY_FILTERS)}>clear filters</button>
    </div>
    <p className="board-count">{visible.length} of {rows.length} canonical issues shown</p>
    {visible.length === 0 ? <p className="state" data-state="unexamined">no canonical issue matches these filters</p> : <ol className="issue-rows">{visible.map((row) => <IssueRowView expanded={expanded === row.candidateId} key={row.candidateId} onToggle={() => setExpanded((current) => current === row.candidateId ? null : row.candidateId)} {...(onSelectFinding === undefined ? {} : { onSelectFinding })} row={row} selectedFindingId={selectedFindingId} />)}</ol>}
  </section>;
}
function IssueRowView({ row, expanded, onToggle, selectedFindingId, onSelectFinding }: { readonly row: IssueRow; readonly expanded: boolean; readonly onToggle: () => void; readonly selectedFindingId: string | null; readonly onSelectFinding?: (sourceFindingId: string | null) => void }): ReactElement {
  return <li className="issue-row" data-severity={row.severity} data-candidate-id={row.candidateId}>
    <div className="issue-row__head"><button className="issue-row__title" type="button" onClick={onToggle}>{row.title}</button><span className="issue-row__severity">severity {row.severity}</span><span>{row.blocker ? "blocker · yes" : "blocker · no"}</span><span>status {row.status}</span><span className="state" data-state={consensusStateToken(row.consensusState)}>consensus {row.consensusState}</span><span>support {row.supportCount} of {row.reviewDenominator} reviewers</span><span className="state" data-state={row.verificationOutcome === "CONFIRMED" ? "verified" : row.verificationOutcome === "REJECTED" ? "refuted" : row.verificationOutcome === null ? "unexamined" : "degraded"}>verification {row.verificationOutcome ?? "not run"} · method {row.verificationMethod ?? "unavailable"}</span></div>
    <p className="issue-row__auditors">source auditors · {row.auditors.join(", ") || "unavailable"}{row.missingReviewers.length === 0 ? "" : ` · missing ${row.missingReviewers.join(", ")}`}{row.singleSource ? " · single source" : ""}{row.categories.length === 0 ? "" : ` · ${row.categories.join(", ")}`}</p>
    <p className="issue-row__dissent state" data-state={row.dissent.length === 0 ? "verified" : "dissent"}>dissent · {row.dissent.length === 0 ? "none recorded" : row.dissent.map(({ authorId, disposition, reason }) => `${authorId} ${disposition}: ${reason}`).join(" · ")}</p>
    {row.counterEvidence.length === 0 ? null : <p className="state" data-state="dissent">counter-evidence · {row.counterEvidence.map(({ id, text }) => `${id}: ${text}`).join(" · ")}</p>}
    <p className="issue-row__ops">votes {row.votes.length} · objections {row.objections.length} · supplements {row.supplements.length}</p>
    <p className="issue-row__locations">{row.locations.length === 0 ? "no repository location recorded" : row.locations.map(({ path, startLine, endLine }) => `${path}:${startLine}-${endLine}`).join(" · ")}</p>
    <ul aria-label={`source findings for ${row.candidateId}`} className="issue-row__findings">{row.sourceFindingIds.map((id) => <li key={id}><button aria-pressed={selectedFindingId === id} type="button" onClick={() => onSelectFinding?.(selectedFindingId === id ? null : id)}>{id}</button></li>)}</ul>
    {!expanded ? null : <div className="issue-row__evidence"><p className="state" data-state="tainted">{row.description}</p>{row.evidence.length === 0 ? <p className="state" data-state="unexamined">no persisted evidence for this issue</p> : <ul aria-label={`evidence for ${row.candidateId}`}>{row.evidence.map(({ id, text, locationIds }) => <li key={id}>{id} · {text} · {locationIds.join(", ") || "no location"}</li>)}</ul>}</div>}
  </li>;
}
function consensusStateToken(state: IssueRow["consensusState"]): string { return state === "accepted" ? "verified" : state === "rejected" ? "refuted" : state === "single_source" ? "unexamined" : "dissent"; }
const FILTER_LABELS = Object.freeze({ severity: "severity", status: "status", auditor: "auditor", category: "category", consensusState: "consensus state", verificationOutcome: "verification outcome" });
const SHARED_ARTIFACT_API = new ArtifactApi();
