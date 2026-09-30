import "./issue-board.css";
import { useMemo, useState, type ReactElement } from "react";
import { ArtifactApi } from "../../api/artifacts.js";
import { EMPTY_FILTERS, filterIssues, filterOptions, issueRows, type IssueFilters, type IssueRow, type PersistedFinding, type PersistedIssueOp, type PersistedIssueSet, type PersistedVerification } from "./model.js";
import { RUN_ARTIFACT_KINDS, useRunArtifact, type RunArtifact } from "./run-artifacts.js";

export interface IssueBoard { readonly issueSet: RunArtifact<PersistedIssueSet>; readonly findings: readonly PersistedFinding[]; readonly rows: readonly IssueRow[] }

/** The four persisted artifacts the board reads, joined into rows. Nothing is computed that the run did not record. */
export function useIssueBoard(api: ArtifactApi, runId: string | null, refreshKey: unknown): IssueBoard {
  const issueSet = useRunArtifact<PersistedIssueSet>(api, runId, RUN_ARTIFACT_KINDS.canonicalIssues, refreshKey);
  const findings = useRunArtifact<readonly PersistedFinding[]>(api, runId, RUN_ARTIFACT_KINDS.sourceFindings, refreshKey);
  const operations = useRunArtifact<readonly PersistedIssueOp[]>(api, runId, RUN_ARTIFACT_KINDS.issueOperations, refreshKey);
  const verifications = useRunArtifact<readonly PersistedVerification[]>(api, runId, RUN_ARTIFACT_KINDS.verificationResults, refreshKey);
  const rows = useMemo(() => issueSet.value === null ? [] : issueRows({ issueSet: issueSet.value, findings: findings.value ?? [], operations: operations.value ?? [], verifications: verifications.value ?? [] }), [issueSet.value, findings.value, operations.value, verifications.value]);
  return { issueSet, findings: findings.value ?? [], rows };
}

export interface IssueBoardViewProps { readonly runId: string | null; readonly api?: ArtifactApi; readonly selectedId?: string | null; readonly onSelect?: (candidateId: string) => void; readonly refreshKey?: unknown }

/**
 * Canonical issues, one line each: severity as stripe width, then consensus and
 * verification as labelled states. Where reviewers disagreed, the disagreement is on the
 * row itself (R5); the full record opens in the details panel.
 */
export function IssueBoardView({ runId, api = SHARED_ARTIFACT_API, selectedId = null, onSelect, refreshKey = null }: IssueBoardViewProps): ReactElement {
  const { issueSet, rows } = useIssueBoard(api, runId, refreshKey);
  const [filters, setFilters] = useState<IssueFilters>(EMPTY_FILTERS);
  const options = useMemo(() => filterOptions(rows), [rows]);
  const visible = useMemo(() => filterIssues(rows, filters), [rows, filters]);
  if (issueSet.state !== "loaded" || issueSet.value === null) return <section aria-label="issue board"><h2 className="panel-title">issue board</h2><p className="state" data-state={issueSet.state === "error" ? "degraded" : "unexamined"}>canonical issue artifact {issueSet.state === "error" ? `unavailable · ${issueSet.error ?? "error"}` : issueSet.state}</p></section>;
  const { summary } = issueSet.value;
  const filtered = Object.values(filters).some((value) => value !== null);
  return <section aria-label="issue board" className="issue-board">
    <h2 className="panel-title">issue board</h2>
    <p className="board-summary">{summary.auditorCount} auditors · {summary.sourceFindingCount} source findings · {summary.acceptedCount} accepted · {summary.rejectedCount} rejected · {summary.unresolvedCount} unresolved · {summary.singleSourceCount} single-source</p>
    <CoverageSummary issueSet={issueSet.value} />
    <div className="board-filters" role="group" aria-label="issue filters">
      {(["severity", "consensusState", "verificationOutcome", "auditor", "category", "status"] as const).map((field) => <label className="field" key={field}>{FILTER_LABELS[field]}<select aria-label={FILTER_LABELS[field]} value={filters[field] ?? ""} onChange={(event) => setFilters((current) => ({ ...current, [field]: event.target.value === "" ? null : event.target.value }))}><option value="">any</option>{options[field].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>)}
      <label className="field">blocker<select aria-label="blocker" value={filters.blocker === null ? "" : String(filters.blocker)} onChange={(event) => setFilters((current) => ({ ...current, blocker: event.target.value === "" ? null : event.target.value === "true" }))}><option value="">any</option><option value="true">blockers only</option><option value="false">non-blockers</option></select></label>
      <button className="button" disabled={!filtered} type="button" onClick={() => setFilters(EMPTY_FILTERS)}>clear filters</button>
    </div>
    <p className="board-count" role="status">{visible.length} of {rows.length} canonical issues shown</p>
    {visible.length === 0 ? <p className="state" data-state="unexamined">no canonical issue matches these filters</p>
      : <ol aria-label="canonical issues" className="issue-rows">{visible.map((row) => <IssueRowView key={row.candidateId} row={row} selected={row.candidateId === selectedId} {...(onSelect === undefined ? {} : { onSelect })} />)}</ol>}
  </section>;
}

/** Coverage limits come before the issues: what was not examined bounds what the issues can mean. */
export function CoverageSummary({ issueSet }: { readonly issueSet: PersistedIssueSet }): ReactElement {
  const { coverage, limitations, minorityFindingIds } = issueSet;
  return <>
    <ul aria-label="run coverage summary" className="board-coverage">
      <li className="state" data-state={coverage.securityCoverage.degraded ? "degraded" : "verified"}>security coverage · {coverage.securityCoverage.degraded ? `degraded · ${coverage.securityCoverage.reason ?? "reason unavailable"}` : "complete"}</li>
      <li className="state" data-state={coverage.suppressionCandidates.length === 0 ? "verified" : "tainted"}>suppression candidates · {coverage.suppressionCandidates.length}</li>
      <li className="state" data-state={coverage.unexaminedSurfaces.length === 0 ? "verified" : "unexamined"}>unexamined surfaces · {coverage.unexaminedSurfaces.length}</li>
      <li className="state" data-state={minorityFindingIds.length === 0 ? "verified" : "dissent"}>minority findings retained · {minorityFindingIds.length}</li>
    </ul>
    {coverage.suppressionCandidates.length === 0 ? null : <ul aria-label="suppression candidates" className="board-coverage">{coverage.suppressionCandidates.map(({ path, instructionRisk, readBy, note }) => <li className="state" data-state="tainted" key={path}>{path} · instruction risk {instructionRisk} · read by {readBy.join(", ") || "no auditor"} · {note}</li>)}</ul>}
    {coverage.unexaminedSurfaces.length === 0 ? null : <ul aria-label="unexamined surfaces" className="board-coverage">{coverage.unexaminedSurfaces.map(({ surfaceId, weight, riskScore, paths, reasons }) => <li className="state" data-state="unexamined" key={surfaceId}>{surfaceId} · {weight} · risk {riskScore} · {paths.join(", ")} · {reasons.join(", ")}</li>)}</ul>}
    {limitations.length === 0 ? null : <ul aria-label="recorded limitations" className="board-coverage">{limitations.map((limitation) => <li className="state" data-state="degraded" key={limitation}>{limitation}</li>)}</ul>}
  </>;
}

function IssueRowView({ row, selected, onSelect }: { readonly row: IssueRow; readonly selected: boolean; readonly onSelect?: (candidateId: string) => void }): ReactElement {
  const location = row.locations[0];
  return <li className="issue-row" data-candidate-id={row.candidateId} data-selected={selected} data-severity={row.severity}>
    <div className="issue-row__head">
      <button aria-pressed={selected} className="issue-row__title" type="button" onClick={() => onSelect?.(row.candidateId)}>{row.title}</button>
      <span className="issue-row__severity">{row.severity}{row.blocker ? " · blocker" : ""}</span>
    </div>
    <p className="issue-row__facts">
      <span className="state" data-state={consensusToken(row.consensusState)}>{CONSENSUS_LABELS[row.consensusState]} · {row.supportCount} of {row.reviewDenominator} support</span>
      <span className="state" data-state={verificationToken(row.verificationOutcome)}>{verificationLabel(row)}</span>
      <span className="issue-row__location">{location === undefined ? "no location recorded" : `${location.path}:${location.startLine}-${location.endLine}`}{row.locations.length > 1 ? ` · ${row.locations.length - 1} more` : ""}</span>
    </p>
    {row.dissent.length === 0 ? null : <p className="issue-row__dissent state" data-state="dissent">dissent · {row.dissent.map(({ authorId, disposition, reason }) => `${authorId} ${disposition}: ${reason}`).join(" · ")}</p>}
  </li>;
}

export const CONSENSUS_LABELS: Readonly<Record<IssueRow["consensusState"], string>> = Object.freeze({ accepted: "accepted", rejected: "rejected", needs_verification: "needs verification", non_consensus: "no consensus", single_source: "single source",
  verified_single_source: "single source · confirmed by verification" });
export function consensusToken(state: IssueRow["consensusState"]): string { return state === "accepted" ? "verified" : state === "rejected" ? "refuted" : state === "single_source" || state === "verified_single_source" ? "unexamined" : "dissent"; }
export function verificationToken(outcome: IssueRow["verificationOutcome"]): string { return outcome === "CONFIRMED" ? "verified" : outcome === "REJECTED" ? "refuted" : outcome === null ? "unexamined" : "degraded"; }
export function verificationLabel(row: Pick<IssueRow, "verificationOutcome" | "verificationMethod">): string {
  if (row.verificationOutcome === null) return "not verified";
  const method = row.verificationMethod === null ? "" : ` · ${row.verificationMethod}`;
  return row.verificationOutcome === "CONFIRMED" ? `verified${method}` : row.verificationOutcome === "REJECTED" ? `refuted by verification${method}` : `verification inconclusive${method}`;
}
const FILTER_LABELS = Object.freeze({ severity: "severity", status: "status", auditor: "auditor", category: "category", consensusState: "consensus", verificationOutcome: "verification" });
const SHARED_ARTIFACT_API = new ArtifactApi();
