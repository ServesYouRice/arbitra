import type { ReactElement } from "react";
import type { ArtifactDescriptor } from "../../api/artifacts.js";
import type { RunOverview } from "../../api/runs.js";
import { useApis } from "../../app/apis.js";
import { Link } from "../../app/router.js";
import { severityWord } from "../../app/words.js";
import { useRunArtifact } from "../../views/issue-board/run-artifacts.js";
import { stepModels } from "./facts.js";
import { placeRange, useCheckAttempts, useIssues, type IssueView } from "./issues.js";
import { dissentText, NO_REASONS } from "./IssuesTab.js";
import { attemptLabel, listWords, profileLabel } from "./models.js";

/** What the second model asked before a severe issue was rejected answered (`verification-second-opinion-<id>`). */
interface SecondOpinion { readonly modelProfileId: string; readonly second?: { readonly activityId?: string; readonly outcome?: string } }

const OUTCOME_WORDS: Readonly<Record<string, string>> = Object.freeze({ CONFIRMED: "confirmed", REJECTED: "rejected", STILL_NEEDS_VERIFICATION: "unsettled" });

/**
 * One issue one click down, from the run's own records: where models disagreed first (R5), then what the finder
 * reported in its own words (untrusted, shown as text), its evidence, who checked it and why, a second opinion asked
 * before rejecting it, who found it, the task that fixes it, and the recorded codes last.
 */
export function IssuePanel({ runId, candidateId, overview, artifacts, refreshKey }: {
  readonly runId: string; readonly candidateId: string; readonly overview: RunOverview | null; readonly artifacts: readonly ArtifactDescriptor[]; readonly refreshKey: unknown;
}): ReactElement {
  const { issueSet, views } = useIssues(runId, overview, artifacts, refreshKey);
  if (issueSet.value === null) return <p className="state" data-state={issueSet.state === "error" ? "degraded" : "unexamined"} role={issueSet.state === "loading" ? "status" : undefined}>{issueSet.state === "loading" ? "reading the issue" : "The issues could not be read."}</p>;
  const view = views.find(({ issue }) => issue.candidateId === candidateId);
  if (view === undefined) return <p className="state" data-state="unexamined">This run recorded no issue {candidateId}.</p>;
  return <IssueRecord runId={runId} view={view} reasoned={views.some(({ issue }) => issue.verificationReason !== undefined)} overview={overview} artifacts={artifacts} refreshKey={refreshKey} />;
}

function IssueRecord({ runId, view, reasoned, overview, artifacts, refreshKey }: {
  readonly runId: string; readonly view: IssueView; readonly reasoned: boolean; readonly overview: RunOverview | null; readonly artifacts: readonly ArtifactDescriptor[]; readonly refreshKey: unknown;
}): ReactElement {
  const { artifacts: api, traces } = useApis();
  const { issue, verdict, places, evidence, foundBy, checkedBy, tasks } = view;
  const kind = `verification-second-opinion-${issue.candidateId}`;
  const second = useRunArtifact<SecondOpinion>(api, artifacts.some((artifact) => artifact.kind === kind) ? runId : null, kind, refreshKey).value;
  const attempts = useCheckAttempts(traces, second === null || overview?.executor !== "models" ? null : runId, refreshKey).value;
  const models = stepModels(overview);
  const configuration = overview?.configuration ?? null;
  const first = places[0];
  const checked = checkedBy === null ? `Not checked: ${view.belowBar ? "below the plan's bar" : "left open"}.` : `Checked by ${checkedBy}${view.method === null ? " against the code" : ""}: ${verdict === "not checked" ? OUTCOME_WORDS[issue.verificationOutcome ?? ""] ?? "no outcome recorded" : verdict}.`;
  const recorded = second?.second?.activityId === undefined ? undefined : attempts?.get(second.second.activityId);
  const secondModel = second === null ? null : recorded !== undefined ? attemptLabel(configuration, recorded.modelId, recorded.level) : profileLabel(configuration, second.modelProfileId, "secondOpinion") ?? second.modelProfileId;
  const secondSaid = second?.second?.outcome === "REJECTED" ? "also rejected it" : second?.second?.outcome === "CONFIRMED" ? "upheld it" : "could not settle it";
  return <div className="details-stack issue-panel" data-candidate-id={issue.candidateId}>
    <h3 className="issue-panel__title">{issue.claim.title}</h3>
    <p className="data">{severityWord(issue.severity)} · {verdict}{first === undefined ? "" : ` · ${placeRange(first)}`}</p>
    {issue.dissent.length === 0 && issue.counterEvidence.length === 0 ? null : <section aria-label="disputed" className="details-section">
      <h4 className="panel-title">Disputed</h4>
      <ul className="plain-list">{issue.dissent.map((vote) => <li className="state" data-state="dissent" key={vote.authorId}>{dissentText(vote, models)}</li>)}
        {issue.counterEvidence.map(({ id, text }) => <li className="state" data-state="dissent" key={id}>against it: {text}</li>)}</ul>
    </section>}
    <section aria-label="what was found" className="details-section">
      <h4 className="panel-title">What was found</h4>
      <p className="state prose issue-panel__words" data-state="tainted">{issue.claim.description}</p>
      <p className="note">In the words of the model that found it.</p>
    </section>
    <section aria-label="evidence" className="details-section">
      <h4 className="panel-title">Evidence</h4>
      {evidence.length === 0 ? <p className="state" data-state="unexamined">No evidence was recorded with it.</p>
        : <ul className="plain-list issue-panel__evidence">{evidence.map(({ id, text, place }) => <li key={id}>{place === null ? null : <span className="data">{place}</span>}<pre className="issue-panel__quote">{text}</pre></li>)}</ul>}
    </section>
    <section aria-label="the check" className="details-section">
      <h4 className="panel-title">The check</h4>
      <p>{checked}</p>
      {issue.verificationReason === undefined ? checkedBy === null ? null : <p className="note">{reasoned ? "The check recorded no reason for it." : NO_REASONS}</p> : <p className="prose">{issue.verificationReason}</p>}
      {second === null ? null : <p>Asked a second model before rejecting it: {secondModel} {secondSaid}.</p>}
    </section>
    <dl className="facts">
      <div><dt>found by</dt><dd>{listWords(foundBy) || "not recorded"}</dd></div>
      <div><dt>places</dt><dd>{places.length === 0 ? "none recorded" : <ul className="plain-list">{places.map((place) => <li key={`${place.id}:${place.path}`}><code>{placeRange(place)}</code></li>)}</ul>}</dd></div>
      <div><dt>fixed by</dt><dd>{tasks.length > 0 ? <ul className="plain-list">{tasks.map(({ id, title }) => <li key={id}><Link to={{ page: "run", runId, tab: "plan", item: `trace:task:${id}` }}>{id} {title}</Link></li>)}</ul>
        : verdict === "unsettled" ? "a check after the plan's tasks, when it is in the plan's scope" : "no task in the plan"}</dd></div>
      {issue.variantOf === undefined ? null : <div><dt>variant of</dt><dd><Link to={{ page: "run", runId, tab: "issues", item: `issue:${issue.variantOf}` }}>{issue.variantOf}</Link></dd></div>}
    </dl>
    <details className="disclosure">
      <summary>Recorded codes</summary>
      <dl className="facts">
        <div><dt>issue</dt><dd><code>{issue.candidateId}</code></dd></div>
        <div><dt>disposition</dt><dd><code>{issue.disposition}</code></dd></div>
        <div><dt>verification</dt><dd><code>{issue.verificationOutcome ?? "none"}</code>{view.method === null ? "" : <> · <code>{view.method}</code></>}</dd></div>
        <div><dt>reviewed by</dt><dd>{issue.coverage.reviewedBy.join(", ") || "no review round"}</dd></div>
        <div><dt>recorded as</dt><dd><ul className="plain-list">{issue.sourceFindingIds.map((id) => <li key={id}><code>{id}</code></li>)}</ul></dd></div>
      </dl>
    </details>
  </div>;
}
