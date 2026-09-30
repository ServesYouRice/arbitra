import type { ReactElement } from "react";
import type { ArtifactApi } from "../../api/artifacts.js";
import { CONSENSUS_LABELS, consensusToken, useIssueBoard, verificationLabel, verificationToken } from "./IssueBoardView.js";
import type { PersistedIssueOp } from "./model.js";

/**
 * One canonical issue's full record. Disagreement comes before the conclusion (R5), the
 * model-authored claim and evidence are marked untrusted and shown only as text, and each
 * source finding keeps its own evidence and locations.
 */
export function IssueDetails({ api, runId, candidateId, refreshKey = null }: { readonly api: ArtifactApi; readonly runId: string; readonly candidateId: string; readonly refreshKey?: unknown }): ReactElement {
  const { issueSet, findings, rows } = useIssueBoard(api, runId, refreshKey);
  if (issueSet.state === "loading") return <p role="status">loading the issue</p>;
  const row = rows.find((item) => item.candidateId === candidateId);
  if (row === undefined) return <p className="state" data-state="unexamined">issue {candidateId} is not in this run's issue set</p>;
  const linked = row.sourceFindingIds.map((id) => findings.find(({ sourceFindingId }) => sourceFindingId === id) ?? id);
  return <div className="details-stack" data-candidate-id={row.candidateId}>
    <p className="state prose" data-state="tainted">{row.title}</p>
    <dl className="facts">
      <div><dt>severity</dt><dd>{row.severity}{row.blocker ? " · production blocker" : ""}</dd></div>
      <div><dt>consensus</dt><dd className="state" data-state={consensusToken(row.consensusState)}>{CONSENSUS_LABELS[row.consensusState]} · {row.supportCount} of {row.reviewDenominator} reviewers support it</dd></div>
      <div><dt>verification</dt><dd className="state" data-state={verificationToken(row.verificationOutcome)}>{verificationLabel(row)}</dd></div>
      {row.status === "unavailable" ? null : <div><dt>board status</dt><dd>{row.status}</dd></div>}
      <div><dt>reviewed by</dt><dd>{row.auditors.join(", ") || "no reviewer recorded"}{row.missingReviewers.length === 0 ? "" : ` · missing ${row.missingReviewers.join(", ")}`}</dd></div>
      <div><dt>categories</dt><dd>{row.categories.join(", ") || "none recorded"}</dd></div>
    </dl>
    <section className="details-section" aria-label="dissent">
      <h3 className="panel-title">dissent</h3>
      {row.dissent.length === 0 ? <p className="state" data-state="verified">no dissent recorded</p> : <ul className="plain-list">{row.dissent.map(({ authorId, disposition, reason }) => <li className="state" data-state="dissent" key={authorId}>{authorId} · {disposition} · {reason}</li>)}</ul>}
      {row.counterEvidence.length === 0 ? null : <ul aria-label="counter-evidence" className="plain-list">{row.counterEvidence.map(({ id, text }) => <li className="state" data-state="dissent" key={id}>counter-evidence {id} · {text}</li>)}</ul>}
    </section>
    <section className="details-section" aria-label="claim">
      <h3 className="panel-title">claim · model-authored</h3>
      <p className="state prose" data-state="tainted">{row.description}</p>
    </section>
    <section className="details-section" aria-label="locations">
      <h3 className="panel-title">locations</h3>
      {row.locations.length === 0 ? <p className="state" data-state="unexamined">no repository location recorded</p> : <ul className="plain-list">{row.locations.map(({ id, path, startLine, endLine }) => <li key={`${id}-${path}`}><code>{path}:{startLine}-{endLine}</code></li>)}</ul>}
    </section>
    <section className="details-section" aria-label="peer review">
      <h3 className="panel-title">peer review · {row.votes.length} votes · {row.objections.length} objections · {row.supplements.length} supplements</h3>
      {row.votes.length + row.objections.length + row.supplements.length === 0 ? <p className="state" data-state="unexamined">no peer operation recorded</p>
        : <ul className="plain-list">{[...row.votes, ...row.objections, ...row.supplements].sort((a, b) => a.round - b.round).map((operation) => <li key={operation.operationId}>round {operation.round} · {operation.actorId} · {OPERATION_LABELS[operation.kind] ?? operation.kind}{reasonOf(operation)}</li>)}</ul>}
    </section>
    <section className="details-section" aria-label="source findings">
      <h3 className="panel-title">source findings · {linked.length}</h3>
      {linked.map((finding) => typeof finding === "string" ? <p className="state" data-state="unexamined" key={finding}>{finding} · source finding unavailable</p> : <details className="disclosure" key={finding.sourceFindingId}>
        <summary>{finding.sourceFindingId} · {finding.severity} · {finding.category}</summary>
        <div className="details-stack">
          <p className="state prose" data-state="tainted">{finding.title}</p>
          {finding.evidence.length === 0 ? <p className="state" data-state="unexamined">no persisted evidence</p> : <ul aria-label={`evidence for ${finding.sourceFindingId}`} className="plain-list">{finding.evidence.map(({ id, text, locationIds }) => <li className="state" data-state="tainted" key={id}>{id} · {text}{locationIds.length === 0 ? "" : ` · ${locationIds.join(", ")}`}</li>)}</ul>}
        </div>
      </details>)}
    </section>
  </div>;
}

const OPERATION_LABELS: Readonly<Record<string, string>> = Object.freeze({ cast_vote: "vote", add_objection: "objection", add_supplement: "supplement" });
function reasonOf(operation: PersistedIssueOp): string {
  const vote = operation.payload["vote"] ?? operation.payload["disposition"];
  const reason = operation.payload["reason"];
  return `${typeof vote === "string" ? ` · ${vote}` : ""}${typeof reason === "string" ? ` · ${reason}` : ""}`;
}
