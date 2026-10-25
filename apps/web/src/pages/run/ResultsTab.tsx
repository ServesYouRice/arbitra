import { useState, type ReactElement } from "react";
import { useApis } from "../../app/apis.js";
import { Link } from "../../app/router.js";
import { counted } from "../../app/words.js";
import { useEvaluationMetrics, type PlanResults } from "../../views/evaluation/api.js";

/**
 * What came of carrying out the plan, from the `results.json` the coding agent writes into the saved plan's folder.
 * Until it exists, the tab says so and how it comes to exist; "Read results again" reads the folder afresh.
 */
export function ResultsTab({ runId, planned }: { readonly runId: string; readonly planned: boolean }): ReactElement {
  const { evaluation } = useApis();
  const [version, setVersion] = useState(0);
  const metrics = useEvaluationMetrics(evaluation, planned ? runId : null, version);
  const results = metrics.metrics?.planResults ?? null;
  const again = <button className="button" disabled={metrics.state === "loading"} type="button" onClick={() => setVersion((value) => value + 1)}>Read results again</button>;
  if (!planned) return <section aria-label="results" className="summary"><p className="state" data-state="unexamined">This run has no plan, so there is nothing to carry out.</p></section>;
  if (metrics.state === "loading" && results === null) return <section aria-label="results" className="summary"><p role="status">reading the results</p></section>;
  if (metrics.state === "error") return <section aria-label="results" className="summary"><p className="state" data-state="degraded">The results could not be read ({metrics.error ?? "error"}).</p>{again}</section>;
  if (results === null) return <section aria-label="results" className="summary">
    <div className="summary-section">
      <h2 className="panel-title">Not carried out yet</h2>
      <p className="prose">Results appear here once the plan has been carried out. Save the plan into the project from the <Link to={{ page: "run", runId, tab: null, item: null }}>Summary</Link>, then ask your coding agent to work through it: it records each issue's result in <code>results.json</code> in the plan's folder, which this tab reads.</p>
      <div className="actions">{again}</div>
    </div>
  </section>;
  return <section aria-label="results" className="summary"><Carried results={results} again={again} /></section>;
}

function Carried({ results, again }: { readonly results: PlanResults; readonly again: ReactElement }): ReactElement {
  const fixed = results.results["fixed"] ?? 0;
  const unchanged = results.results["no_change_needed"] ?? 0;
  const notReproducible = results.results["not_reproducible"] ?? 0;
  const blocked = results.results["blocked"] ?? 0;
  const found = results.foundWhileFixing?.reported ?? 0;
  return <div className="summary-section">
    <div className="summary-section__head"><h2 className="panel-title">Results · {counted(results.reported, "issue")} reported of {results.issues}</h2>{again}</div>
    <div className="verdicts">
      <div className="verdict"><span className="verdict__count">{fixed}</span><span className="verdict__words">fixed, of {results.issues}</span></div>
      <div className="verdict"><span className="verdict__count">{results.provenByFailingTest}</span><span className="verdict__words">proven by a test that failed first</span></div>
      <div className="verdict"><span className="verdict__count">{unchanged}</span><span className="verdict__words">no change needed</span></div>
      <div className="verdict"><span className="verdict__count">{found}</span><span className="verdict__words">more defects found while fixing</span></div>
    </div>
    <p className="data">{notReproducible} not reproducible · {blocked} blocked · {results.notProvenByTest} no test could show{results.checkedEndToEnd === undefined ? "" : ` · ${results.checkedEndToEnd} checked end to end`}</p>
  </div>;
}
