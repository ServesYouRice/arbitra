import "./runs.css";
import { useEffect, useState, type ReactElement } from "react";
import type { RunListItem } from "../api/runs.js";
import { useLoaded } from "../api/runs.js";
import { useApis } from "../app/apis.js";
import { basename, formatTime, isActive, MODE_LABELS, shortRunId } from "../app/format.js";
import { GateVerdict, StateChip } from "../app/marks.js";
import { Link, useNavigation } from "../app/router.js";

const POLL_MS = 4_000;
/** A running run no process here executes is still watched while its records keep changing. */
const QUIET_MS = 10 * 60_000;

/**
 * Every recorded run, newest first, with where it stands and what it concluded. Runs that
 * wait on the operator are counted first, because they do nothing until someone acts.
 */
export function RunsPage(): ReactElement {
  const { runs } = useApis();
  const { navigate } = useNavigation();
  const [tick, setTick] = useState(0);
  const listed = useLoaded("runs", () => runs.list(), tick);
  const repository = useLoaded("repository", () => runs.selectedRepository(), null);
  const items = listed.value ?? [];
  const active = items.some(({ state, live, updatedAt }) => isActive(state) && (live || (updatedAt !== null && Date.now() - Date.parse(updatedAt) < QUIET_MS)));
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((value) => value + 1), POLL_MS);
    return () => clearInterval(timer);
  }, [active]);
  const waiting = items.filter(({ state }) => state === "BLOCKED");
  return <>
    <div className="page-head">
      <div className="page-head__text">
        <h1 className="page-title">Runs</h1>
        <p className="note">{repository.value === null ? "Runs read the repository the control plane was started in unless a run names another." : <>Runs read <code title={repository.value.repository}>{repository.value.repository}</code> unless a run names another.</>}</p>
      </div>
      <div className="actions">
        <button className="button" type="button" onClick={() => setTick((value) => value + 1)}>refresh</button>
        <Link className="button button--primary run-list__new" to={{ page: "new-run", from: null, graph: null }}>New run</Link>
      </div>
    </div>
    {listed.error === null ? null : <div className="state" data-state="degraded" role="alert"><p>The control plane did not answer · {listed.error}</p><p className="note">Start it with <code>node apps/server/dist/src/serve.js</code> after <code>pnpm build</code>, then refresh.</p></div>}
    {waiting.length === 0 ? null : <p className="state" data-state="attention" role="status">{waiting.length === 1 ? "1 run is" : `${waiting.length} runs are`} waiting for your decision.</p>}
    {listed.value === null && listed.error === null ? <p role="status">loading runs</p> : null}
    {listed.value !== null && items.length === 0 ? <section className="surface empty-state">
      <h2 className="panel-title">no runs yet</h2>
      <p className="prose">A run audits a repository with independent auditors (Audit), plans a feature against a requirements contract (Feature), or plans and optionally writes tests in an isolated sandbox (Testing). The repository itself is never modified.</p>
      <p><Link className="button button--primary" to={{ page: "new-run", from: null, graph: null }}>Start a run</Link></p>
    </section> : null}
    {items.length === 0 ? null : <div className="table-scroll surface run-list">
      <table aria-label="runs" className="table">
        <thead><tr><th scope="col">run</th><th scope="col">status</th><th scope="col">what ran</th><th scope="col">result</th><th scope="col">repository</th><th scope="col">started</th></tr></thead>
        <tbody>{items.map((item) => <tr key={item.runId} data-state={item.state ?? "unreadable"} onClick={(event) => { if (!(event.target instanceof Element && event.target.closest("a, button"))) navigate({ page: "run", runId: item.runId, tab: null, item: null }); }}>
          <td className="nowrap"><Link aria-label={`open run ${item.runId}`} className="run-list__id" to={{ page: "run", runId: item.runId, tab: null, item: null }}>{shortRunId(item.runId)}</Link></td>
          <td><StateChip state={item.state} /></td>
          <td>{whatRan(item)}</td>
          <td><Result item={item} /></td>
          <td>{item.repository === null ? "unavailable" : <span title={item.repository}>{basename(item.repository)}</span>}</td>
          <td className="nowrap"><span title={item.updatedAt === null ? undefined : `last activity ${formatTime(item.updatedAt)}`}>{formatTime(item.createdAt)}</span></td>
        </tr>)}</tbody>
      </table>
    </div>}
  </>;
}

function whatRan(item: RunListItem): ReactElement {
  const mode = item.mode === null ? "unknown mode" : MODE_LABELS[item.mode];
  const executor = item.executor === "scripted" ? "scripted detectors, no model calls" : item.executor === "models" ? "models" : "unavailable";
  return <span className="run-list__what"><span>{mode}{item.workflowId === null ? null : <> · <span className="nowrap">{item.workflowId}</span></>}</span><span className="note">{executor}{item.replayOf === null ? "" : ` · replay of ${shortRunId(item.replayOf)}`}</span></span>;
}

function Result({ item }: { readonly item: RunListItem }): ReactElement {
  if (item.problem !== null) return <p className="state" data-state="degraded">records unreadable · {item.problem}</p>;
  if (item.state === "BLOCKED") return <p className="state" data-state="attention">needs you · {item.pendingDecisions === 1 ? "1 decision" : `${item.pendingDecisions} decisions`}</p>;
  if (item.gate !== null) return <GateVerdict gate={item.gate} compact />;
  if (item.state === "FAILED") return <p className="state" data-state="refuted">failed · {item.reason ?? "no reason recorded"}</p>;
  if (item.state === "CANCELLED" || item.state?.startsWith("SUSPENDED") === true) return <p className="note">can be resumed</p>;
  if (!item.live) return <p className="state" data-state="degraded">not executed by this control plane · running elsewhere or interrupted</p>;
  return <p className="note">in progress</p>;
}
