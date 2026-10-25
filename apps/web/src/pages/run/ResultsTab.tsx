import { useState, type ReactElement } from "react";
import { useLoaded, type PlanResultRecord } from "../../api/runs.js";
import { useApis } from "../../app/apis.js";
import { formatTime } from "../../app/format.js";
import { Link } from "../../app/router.js";
import { counted, RESULT_WORDS, severityWord } from "../../app/words.js";
import { bySeverity } from "./issues.js";

type Entry = PlanResultRecord["issues"][number];

/**
 * What came of carrying out the plan, from the `results.json` the coding agent writes into the saved plan's folder:
 * the counts first, then each issue under what the agent recorded (fixed, no change needed, not reproducible, blocked,
 * or a result in its own words), whether a test failed before the fix and whether the fix was checked end to end, and
 * the defects it found while fixing. The proofs are one click down. Until the file exists the tab says so and how it
 * comes to exist; "Read results again" reads the folder afresh.
 */
export function ResultsTab({ runId, planned }: { readonly runId: string; readonly planned: boolean }): ReactElement {
  const { runs } = useApis();
  const [version, setVersion] = useState(0);
  const read = useLoaded(planned ? `plan-results:${runId}` : null, () => runs.planResults(runId), version);
  const again = <button className="button" disabled={read.loading} type="button" onClick={() => setVersion((value) => value + 1)}>Read results again</button>;
  if (!planned) return <section aria-label="results" className="summary"><p className="state" data-state="unexamined">This run has no plan, so there is nothing to carry out.</p></section>;
  if (read.value === null && read.error === null) return <section aria-label="results" className="summary"><p role="status">reading the results</p></section>;
  if (read.value === null) return <section aria-label="results" className="summary"><p className="state" data-state="degraded">The results could not be read just now. Read them again in a moment.</p>
    <details className="disclosure"><summary>What arbitra recorded</summary><p className="data">{read.error}</p></details>{again}</section>;
  const record = read.value.results;
  if (record === null) return <section aria-label="results" className="summary">
    <div className="summary-section">
      <h2 className="panel-title">Not carried out yet</h2>
      <p className="prose">The plan has not been carried out yet, or its results are not written down. Save the plan into the project from the <Link to={{ page: "run", runId, tab: null, item: null }}>Summary</Link>, then ask your coding agent to work through it: it records each issue's result in <code>results.json</code> in the plan's folder, which this tab reads.</p>
      <div className="actions">{again}</div>
    </div>
  </section>;
  return <section aria-label="results" className="summary"><Carried record={record} again={again} /></section>;
}

/** The groups an entry falls in, in this order; a result the agent wrote in its own words keeps its words. */
const GROUPS = ["fixed", "no_change_needed", "not_reproducible", "blocked"] as const;

/** How many entries a group shows before "Show all". */
export const RESULT_PAGE = 10;

/**
 * What came of one kind of work, in a line: the tasks' issues ("125 fixed, 1 recorded in the agent's own words; none
 * turned out wrong"), or the issues checked after the tasks ("5 held and were fixed, 15 did not hold"). The saved
 * plan names a check's entry `check 01`, a task's `TASK-001`.
 */
function workLine(entries: readonly Entry[], checks: boolean): string | null {
  if (entries.length === 0) return null;
  const count = (result: string) => entries.filter((entry) => entry.result === result).length;
  const own = entries.filter(({ result }) => result !== null && !(GROUPS as readonly string[]).includes(result)).length;
  const wrong = count("no_change_needed") + count("not_reproducible");
  const parts = [
    ...count("fixed") === 0 ? [] : [checks ? `${count("fixed")} held and ${count("fixed") === 1 ? "was" : "were"} fixed` : `${count("fixed")} fixed`],
    ...checks ? wrong === 0 ? [] : [`${wrong} did not hold`]
      : [...count("no_change_needed") === 0 ? [] : [`${count("no_change_needed")} needed no change`], ...count("not_reproducible") === 0 ? [] : [`${count("not_reproducible")} could not be reproduced`]],
    ...count("blocked") === 0 ? [] : [`${count("blocked")} blocked`],
    ...own === 0 ? [] : [`${own} recorded in the agent's own words`],
    ...entries.filter(({ result }) => result === null).length === 0 ? [] : [`${entries.filter(({ result }) => result === null).length} not reported yet`],
  ];
  const head = checks ? `${counted(entries.length, "issue")} checked after the tasks` : `The tasks' ${counted(entries.length, "issue")}`;
  return `${head}: ${parts.join(", ")}${!checks && wrong === 0 ? "; none turned out wrong" : ""}.`;
}

function Carried({ record, again }: { readonly record: PlanResultRecord; readonly again: ReactElement }): ReactElement {
  const { summary } = record;
  const own = record.issues.filter(({ result }) => result !== null && !(GROUPS as readonly string[]).includes(result));
  const unreported = record.issues.filter(({ result }) => result === null);
  const checks = record.issues.filter(({ task }) => /^check\b/u.test(task ?? ""));
  const lines = [workLine(record.issues.filter((entry) => !checks.includes(entry)), false), workLine(checks, true)].filter((line) => line !== null);
  return <>
    <div className="summary-section">
      <div className="summary-section__head"><h2 className="panel-title">Results · {counted(summary.reported, "issue")} reported of {summary.issues}</h2>{again}</div>
      <p className="data">From <code>{record.relative}/results.json</code> · last written {formatTime(record.modifiedAt)}</p>
      <div className="verdicts">
        <div className="verdict"><span className="verdict__count">{summary.results["fixed"] ?? 0}</span><span className="verdict__words">fixed, of {summary.issues}</span></div>
        <div className="verdict"><span className="verdict__count">{summary.provenByFailingTest}</span><span className="verdict__words">proven by a test that failed first</span></div>
        <div className="verdict"><span className="verdict__count">{summary.results["no_change_needed"] ?? 0}</span><span className="verdict__words">no change needed</span></div>
        <div className="verdict"><span className="verdict__count">{summary.foundWhileFixing.reported}</span><span className="verdict__words">more defects found while fixing</span></div>
      </div>
      <p className="data">{summary.results["not_reproducible"] ?? 0} not reproducible · {summary.results["blocked"] ?? 0} blocked · {summary.notProvenByTest} no test could show · {summary.checkedEndToEnd} checked end to end</p>
      {lines.map((line) => <p className="prose" key={line}>{line}</p>)}
    </div>
    {GROUPS.map((result) => <ResultGroup key={result} title={RESULT_WORDS[result] ?? result} entries={record.issues.filter((entry) => entry.result === result)} />)}
    <ResultGroup title="As the agent wrote it" entries={own} ownWords />
    <ResultGroup title="Not reported yet" entries={unreported} />
    {record.foundWhileFixing.length === 0 ? null : <section aria-labelledby="found-fixing-title" className="summary-section">
      <h2 className="panel-title" id="found-fixing-title">Found while fixing · {record.foundWhileFixing.length.toLocaleString("en")}</h2>
      <ul className="result-list">{record.foundWhileFixing.map((entry, index) => <li data-severity={entry.severity ?? undefined} key={index}>
        <span className="result-list__title">{entry.title}</span>
        <span className="result-list__facts">{[entry.severity === null ? null : severityWord(entry.severity), entry.where, entry.result === null ? null : RESULT_WORDS[entry.result]?.toLowerCase() ?? entry.result, proven(entry.failedBefore)].filter((part) => part !== null).join(" · ")}</span>
        <Proof test={entry.test} proof={entry.proof} />
      </li>)}</ul>
    </section>}
  </>;
}

function proven(failedBefore: boolean | null): string | null { return failedBefore === true ? "a test failed first" : failedBefore === false ? "no test could show it" : null; }

/** One result's entries, most severe first, the first ten until "Show all" is asked for. */
function ResultGroup({ title, entries, ownWords = false }: { readonly title: string; readonly entries: readonly Entry[]; readonly ownWords?: boolean }): ReactElement | null {
  const [all, setAll] = useState(false);
  if (entries.length === 0) return null;
  const id = `results-${title.toLowerCase().replace(/\W+/gu, "-")}`;
  const sorted = bySeverity(entries.map((entry) => ({ issue: { severity: entry.severity ?? "informational" }, entry }))).map(({ entry }) => entry);
  const shown = all ? sorted : sorted.slice(0, RESULT_PAGE);
  return <section aria-labelledby={id} className="summary-section">
    <h2 className="panel-title" id={id}>{title} · {entries.length.toLocaleString("en")}</h2>
    <ul className="result-list">{shown.map((entry) => <li data-severity={entry.severity ?? undefined} key={`${entry.issue}:${entry.task ?? ""}`}>
      <span className="result-list__title">{entry.title ?? entry.issue}</span>
      <span className="result-list__facts">{[entry.severity === null ? null : severityWord(entry.severity), entry.task, ownWords ? entry.result : null, proven(entry.failedBefore), entry.checkedEndToEnd === true ? "checked end to end" : null].filter((part) => part !== null).join(" · ")}</span>
      <Proof test={entry.test} proof={entry.proof} />
    </li>)}</ul>
    {shown.length < sorted.length ? <button className="link-button more-link" type="button" onClick={() => setAll(true)}>Show all {sorted.length.toLocaleString("en")}</button> : null}
  </section>;
}

function Proof({ test, proof }: { readonly test: string | null; readonly proof: string | null }): ReactElement | null {
  if (test === null && proof === null) return null;
  return <details className="disclosure result-list__proof">
    <summary>Proof</summary>
    {test === null ? null : <p className="data">test · {test}</p>}
    {proof === null ? null : <p className="prose">{proof}</p>}
  </details>;
}
