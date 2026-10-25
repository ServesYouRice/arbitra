import "./issues.css";
import { useMemo, useState, type KeyboardEvent, type ReactElement } from "react";
import type { ArtifactDescriptor } from "../../api/artifacts.js";
import type { RunOverview } from "../../api/runs.js";
import { Link } from "../../app/router.js";
import { counted, SEVERITIES, severityWord, VERDICTS, type Verdict } from "../../app/words.js";
import { describeSuppressionCandidate, describeUnexaminedSurface, type PersistedIssueSet, type PersistedVote } from "../../views/issue-board/model.js";
import { stepModels } from "./facts.js";
import { bySeverity, matches, placeText, useIssues, type IssueView } from "./issues.js";
import { listWords } from "./models.js";

/** How many issues a group shows before "Show N more". */
export const ISSUE_PAGE = 25;

/** The check began giving its reason on October 25, 2026 (54eb8f9); a run before that recorded none. */
export const NO_REASONS = "This run's check gave no reasons: runs before October 25, 2026 did not ask it for one.";

const GROUP_NOTES: Readonly<Record<Verdict, string>> = Object.freeze({
  confirmed: "Checked against the code and upheld.",
  unsettled: "The check could not settle these from the code alone. The plan checks them after its tasks; most such issues do not hold.",
  rejected: "The check found these are not problems, each with its reason.",
  "not checked": "Below the plan's bar, or left open: kept here, and not planned.",
});

/**
 * The issues, grouped by what the check decided (confirmed · unsettled · rejected · not checked), most severe first
 * within each group. Each row gives its place in the code, its severity, who found it and who checked it, by model and
 * effort, and says so where models disagreed; the evidence, the check's reason and the record are one click down.
 */
export function IssuesTab({ runId, overview, artifacts, refreshKey, selectedId, onSelect }: {
  readonly runId: string; readonly overview: RunOverview | null; readonly artifacts: readonly ArtifactDescriptor[]; readonly refreshKey: unknown;
  readonly selectedId: string | null; readonly onSelect: (candidateId: string) => void;
}): ReactElement {
  const { issueSet, views, pending } = useIssues(runId, overview, artifacts, refreshKey);
  const groups = useMemo(() => VERDICTS.map((verdict) => ({ verdict, views: bySeverity(views.filter((view) => view.verdict === verdict)) })), [views]);
  const [chosen, setChosen] = useState<Verdict | null>(null);
  const [query, setQuery] = useState("");
  const selected = views.find(({ issue }) => issue.candidateId === selectedId);
  // The group open: the one chosen, else the selected issue's, else the first that holds any.
  const current = chosen ?? selected?.verdict ?? groups.find(({ views: members }) => members.length > 0)?.verdict ?? "confirmed";
  if (issueSet.value === null) return <section aria-label="issues" className="not-yet">
    <p className="state" data-state={issueSet.state === "error" ? "degraded" : "unexamined"} role={issueSet.state === "loading" ? "status" : undefined}>{issueSet.state === "loading" ? "reading the issues" : `The issues could not be read${issueSet.error === null ? "" : ` (${issueSet.error})`}.`}</p>
  </section>;
  const keys = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    const next = VERDICTS[(index + step + VERDICTS.length) % VERDICTS.length] ?? "confirmed";
    setChosen(next);
    document.getElementById(tabId(next))?.focus();
  };
  const group = groups.find(({ verdict }) => verdict === current) ?? groups[0];
  return <section aria-label="issues" className="issues">
    <p className="issues__counts">{counted(views.length, "issue")} · {groups.map(({ verdict, views: members }) => `${members.length.toLocaleString("en")} ${verdict}`).join(" · ")}</p>
    {pending.length === 0 ? null : <p className="note" role="status">{pending.join(" · ")}; places, checkers and tasks may show as missing until then.</p>}
    {/* Only the open group's panel exists, so only its tab names a panel it controls. */}
    <div aria-label="verdict" className="verdict-tabs" role="tablist">{groups.map(({ verdict, views: members }, index) => <button aria-controls={verdict === current ? panelId(verdict) : undefined} aria-selected={verdict === current} className="verdict-tab" data-verdict={verdict}
      id={tabId(verdict)} key={verdict} role="tab" tabIndex={verdict === current ? 0 : -1} type="button" onClick={() => setChosen(verdict)} onKeyDown={(event) => keys(event, index)}>
      {verdict.charAt(0).toUpperCase()}{verdict.slice(1)} · {members.length.toLocaleString("en")}</button>)}</div>
    {group === undefined ? null : <IssueGroup key={group.verdict} runId={runId} verdict={group.verdict} views={group.views} query={query} onQuery={setQuery} selectedId={selectedId} onSelect={onSelect} models={stepModels(overview)} />}
    <Unseen issueSet={issueSet.value} models={stepModels(overview)} />
  </section>;
}

const slug = (verdict: Verdict): string => verdict.replace(/\s+/gu, "-");
const tabId = (verdict: Verdict): string => `verdict-tab-${slug(verdict)}`;
const panelId = (verdict: Verdict): string => `verdict-panel-${slug(verdict)}`;

function IssueGroup({ runId, verdict, views, query, onQuery, selectedId, onSelect, models }: {
  readonly runId: string; readonly verdict: Verdict; readonly views: readonly IssueView[]; readonly query: string; readonly onQuery: (query: string) => void;
  readonly selectedId: string | null; readonly onSelect: (candidateId: string) => void; readonly models: ReadonlyMap<string, string>;
}): ReactElement {
  const [all, setAll] = useState(false);
  const found = query.trim() === "" ? views : views.filter((view) => matches(view, query));
  // A selected issue stays in view even when it sorts past the first page.
  const selectedIndex = found.findIndex(({ issue }) => issue.candidateId === selectedId);
  const shown = all || query.trim() !== "" || selectedIndex >= ISSUE_PAGE ? found : found.slice(0, ISSUE_PAGE);
  const severities = SEVERITIES.flatMap((severity) => { const count = views.filter(({ issue }) => issue.severity === severity).length; return count === 0 ? [] : [`${count.toLocaleString("en")} ${severityWord(severity)}`]; });
  const planned = views.filter(({ tasks }) => tasks.length > 0).length;
  // A run before the check gave reasons has none at all: said once here, not on every row.
  const reasoned = views.some(({ issue }) => issue.verificationReason !== undefined);
  const plan = verdict !== "confirmed" || planned === 0 ? [] : [planned === views.length ? "all in the plan" : `${planned.toLocaleString("en")} in the plan`];
  return <section aria-label={`${verdict} issues`} className="issue-group" id={panelId(verdict)} role="tabpanel">
    <div className="issue-group__head">
      <span className="data">{[...severities, ...plan].join(" · ") || "none"}</span>
      <label className="find">Find<input placeholder="file or words" type="search" value={query} onChange={(event) => onQuery(event.target.value)} /></label>
    </div>
    <p className="note">{verdict === "rejected" && views.length > 0 && !reasoned ? `The check found these are not problems. ${NO_REASONS}`
      : `${GROUP_NOTES[verdict]}${verdict === "unsettled" && views.length > 0 && !reasoned ? ` ${NO_REASONS}` : ""}`}</p>
    {query.trim() === "" ? null : <p className="data" role="status">{found.length.toLocaleString("en")} of {views.length.toLocaleString("en")} match</p>}
    {shown.length === 0 ? <p className="state" data-state="unexamined">{views.length === 0 ? `No issue is ${verdict}.` : "No issue here matches."}</p>
      : <ol aria-label={`${verdict} issues, most severe first`} className="issue-rows">{shown.map((view) => <IssueRow key={view.issue.candidateId} runId={runId} view={view} reasoned={reasoned} selected={view.issue.candidateId === selectedId} onSelect={onSelect} models={models} />)}</ol>}
    {shown.length < found.length ? <button className="link-button more-link" type="button" onClick={() => setAll(true)}>Show {(found.length - shown.length).toLocaleString("en")} more</button> : null}
  </section>;
}

/** Who voted against the conclusion, as their model, and how. */
export function dissentText({ authorId, disposition, reason }: PersistedVote, models: ReadonlyMap<string, string>): string {
  const did = disposition === "reject" ? "rejected it" : disposition === "accept" ? "upheld it" : "could not decide";
  return `${models.get(authorId) ?? authorId} ${did}: ${reason}`;
}

function IssueRow({ runId, view, reasoned, selected, onSelect, models }: { readonly runId: string; readonly view: IssueView; readonly reasoned: boolean; readonly selected: boolean; readonly onSelect: (candidateId: string) => void; readonly models: ReadonlyMap<string, string> }): ReactElement {
  const { issue, verdict, places, foundBy, checkedBy } = view;
  const first = places[0];
  const reason = verdict !== "rejected" && verdict !== "unsettled" ? null : issue.verificationReason ?? (reasoned && verdict === "rejected" ? "The check recorded no reason for it." : null);
  return <li className="issue-row" data-candidate-id={issue.candidateId} data-selected={selected} data-severity={issue.severity}>
    <div className="issue-row__head">
      <button aria-pressed={selected} className="issue-row__title" type="button" onClick={() => onSelect(issue.candidateId)}>{issue.claim.title}</button>
      <span className="issue-row__severity">{severityWord(issue.severity)}</span>
    </div>
    <p className="issue-row__facts">
      <span className="issue-row__place">{first === undefined ? "no place recorded" : `${placeText(first)}${places.length > 1 ? ` · and ${counted(places.length - 1, "more place")}` : ""}`}</span>
      {foundBy.length === 0 ? null : <span>found by {listWords(foundBy)}</span>}
      {checkedBy === null ? null : <span>checked by {checkedBy}</span>}
    </p>
    {issue.dissent.length === 0 ? null : <p className="issue-row__dissent state" data-state="dissent">disputed · {issue.dissent.map((vote) => dissentText(vote, models)).join(" · ")}</p>}
    {reason === null ? null : <p className="issue-row__reason">{reason}</p>}
    {verdict === "not checked" ? <p className="issue-row__reason">not checked: {view.belowBar ? "below the plan's bar" : "left open"}</p> : null}
    {issue.variantOf === undefined ? null : <p className="issue-row__variant">variant of <Link to={{ page: "run", runId, tab: "issues", item: `issue:${issue.variantOf}` }}>{issue.variantOf}</Link></p>}
  </li>;
}

const SECURITY_WORDS: Readonly<Record<string, string>> = Object.freeze({
  source_snapshot_only_no_runtime_or_deployment_security_evidence: "It read the source only, not how the project runs or is deployed, so it cannot see security issues that depend on those.",
});

/** What bounds what the issues can mean, folded below them: what was not read in full, and the run's own notes. */
function Unseen({ issueSet, models }: { readonly issueSet: PersistedIssueSet; readonly models: ReadonlyMap<string, string> }): ReactElement {
  const { coverage, limitations } = issueSet;
  const security = coverage.securityCoverage;
  const unexamined = coverage.unexaminedSurfaces.map((entry) => {
    const fields = typeof entry === "object" && entry !== null ? entry as Readonly<Record<string, unknown>> : {};
    const module = typeof fields["surface"] === "string" ? /^module_joint_context:(.+)$/u.exec(fields["surface"])?.[1] : undefined;
    const who = typeof fields["auditorId"] === "string" ? models.get(fields["auditorId"]) ?? fields["auditorId"] : "a finder";
    return module === undefined ? describeUnexaminedSurface(entry) : `${who} did not read ${module} as a whole within its budget`;
  });
  return <details className="disclosure unseen">
    <summary>What the audit could not see</summary>
    <ul className="plain-list unseen__list">
      {coverage.complete ? null : <li>Not every part was read in full, so the issues may not cover everything in scope.</li>}
      {security.degraded ? <li>{SECURITY_WORDS[security.reason ?? ""] ?? `Its view of security is limited${security.reason === null ? "" : ` (${security.reason})`}.`}</li> : null}
      {unexamined.length === 0 ? null : <li>{counted(unexamined.length, "part")} not read in full:<ul className="plain-list">{unexamined.map((line, index) => <li className="data" key={index}>{line}</li>)}</ul></li>}
      {coverage.suppressionCandidates.length === 0 ? null : <li>{counted(coverage.suppressionCandidates.length, "file")} read like instructions to a model, and no issue cites them:<ul className="plain-list">{coverage.suppressionCandidates.map((entry, index) => <li className="data" key={index}>{describeSuppressionCandidate(entry)}</li>)}</ul></li>}
      {coverage.complete && !security.degraded && unexamined.length === 0 && coverage.suppressionCandidates.length === 0 ? <li>Nothing: every part in scope was read.</li> : null}
    </ul>
    {limitations.length === 0 ? null : <details className="disclosure"><summary>The run's notes · {limitations.length.toLocaleString("en")}</summary><ul className="plain-list data">{limitations.map((line, index) => <li key={index}>{line}</li>)}</ul></details>}
  </details>;
}
