import "../operator.css";
import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import type { TestingOperatorView, TestingVerificationSummary, TestingVerifiedChangeSet } from "@arbitra/schemas/testing-operator.js";
import { ArtifactApi, type ArtifactDescriptor } from "../../api/artifacts.js";
import { downloadJson, failure, TestingApi } from "../../api/operator.js";
import type { RunResource } from "../../api/runs.js";

export interface TestingViewProps {
  readonly runId: string | null;
  readonly run: RunResource | null;
  readonly artifacts: readonly ArtifactDescriptor[];
  readonly api?: TestingApi;
  readonly artifactApi?: ArtifactApi;
  readonly refreshKey?: unknown;
}

/**
 * Testing configuration and authority review, plan versus execution, attempts, checks,
 * repair lineage and the verified change set, all from the read-only Testing routes.
 *
 * Nothing here applies a change: the download is the exact verified bytes, each with the
 * `expectedHash` an applying tool must compare first. A no-work result is shown as no work,
 * never as coverage.
 */
export function TestingView({ runId, run, artifacts, api = SHARED_TESTING, artifactApi = SHARED_ARTIFACTS, refreshKey = null }: TestingViewProps): ReactElement {
  const testing = run?.workflow?.id === "testing-plan" || run?.workflow?.id === "testing-execute";
  const [reload, setReload] = useState(0);
  const [view, setView] = useState<TestingOperatorView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setView(null); setError(null);
    if (runId === null || !testing) return;
    let active = true;
    void api.view(runId).then((value) => { if (active) setView(value); }, (cause: unknown) => { if (active) setError(failure(cause)); });
    return () => { active = false; };
  }, [api, runId, testing, refreshKey, reload, run?.state]);

  if (runId === null || run === null) return <Frame><p className="state" data-state="unexamined">select a Testing run to review its authority and execution</p></Frame>;
  if (!testing) return <Frame><p className="state" data-state="unexamined">not a Testing run · workflow {run.workflow?.id ?? "unavailable"}</p></Frame>;
  if (error !== null) return <Frame><p className="state" data-state="degraded" role="alert">Testing view unavailable · {error}</p><button type="button" onClick={() => setReload((value) => value + 1)}>reload Testing view</button></Frame>;
  if (view === null) return <Frame><p role="status">loading Testing view</p></Frame>;
  const planHandoff = artifacts.find(({ kind }) => kind === "implementation");
  return <Frame>
    <p className="operator-run">run {view.runId} · {view.runState} · mode {view.configuration.mode}</p>
    <Authority view={view} />
    <Planning view={view} />
    {view.configuration.mode === "execute" && !view.noWork ? <>
      <PlanVersusExecution view={view} />
      <Attempts view={view} />
      <Repair view={view} />
      <Outcome view={view} />
    </> : null}
    <Handoff view={view} api={api} runId={runId} planHandoff={planHandoff} artifactApi={artifactApi} />
  </Frame>;
}

function Frame({ children }: { readonly children: ReactNode }): ReactElement {
  return <section aria-label="testing execution" className="operator-view"><h2 className="panel-title">testing execution</h2>{children}</section>;
}
function Section({ id, title, children }: { readonly id: string; readonly title: string; readonly children: ReactNode }): ReactElement {
  return <section aria-labelledby={id} className="operator-section"><h3 className="panel-title" id={id}>{title}</h3>{children}</section>;
}

function Authority({ view }: { readonly view: TestingOperatorView }): ReactElement {
  const { configuration } = view;
  const execution = configuration.execution;
  return <Section id="testing-authority-title" title="configuration and write authority">
    <dl className="operator-facts">
      <div><dt>mode</dt><dd>{configuration.mode}</dd></div>
      <div><dt>goal</dt><dd>{configuration.goal}</dd></div>
      <div><dt>analyst / planner</dt><dd>{configuration.roles.analyst} / {configuration.roles.planner}</dd></div>
      <div><dt>custom commands</dt><dd>{configuration.commands.length === 0 ? "none" : configuration.commands.map(({ command, evidencePath }) => `${command} (${evidencePath})`).join(", ")}</dd></div>
    </dl>
    {execution === null ? <p className="state" data-state="unexamined">plan mode · no write authority · commands are never run</p> : <>
      <p className="operator-note">Write grants and check bindings are operator authority recorded with the run. They are not model output, and repair never widens them.</p>
      <dl className="operator-facts">
        <div><dt>parallel writers</dt><dd>{execution.authorization.maximumParallelTasks}</dd></div>
        <div><dt>attempts per task</dt><dd>{execution.maximumAttempts}</dd></div>
        <div><dt>repair rounds</dt><dd>{execution.maximumRepairRounds} · {execution.repairRoundsSource === "default" ? "runtime default" : "configured"}</dd></div>
        <div><dt>task models</dt><dd>fast {execution.models.fast} · balanced {execution.models.balanced} · frontier {execution.models.frontier}</dd></div>
        <div><dt>sandbox</dt><dd>{execution.sandbox.driver} · {execution.sandbox.image} · network {execution.sandbox.network} · {execution.sandbox.maximumRuns} runs · {execution.sandbox.timeoutMs} ms</dd></div>
      </dl>
      <div className="operator-table"><table aria-label="write partitions"><thead><tr><th scope="col">partition</th><th scope="col">writable paths</th><th scope="col">granted tasks</th></tr></thead><tbody>
        {execution.authorization.partitions.map(({ id, paths }) => <tr key={id}><td>{id}</td><td>{paths.join(", ")}</td><td>{execution.authorization.tasks.filter(({ partitionId }) => partitionId === id).map(({ taskId, exclusive }) => `${taskId}${exclusive ? " (exclusive)" : ""}`).join(", ") || "none"}</td></tr>)}
      </tbody></table></div>
      <div className="operator-table"><table aria-label="check bindings"><thead><tr><th scope="col">planned command</th><th scope="col">check</th><th scope="col">argv</th><th scope="col">authorization</th><th scope="col">expected exit</th></tr></thead><tbody>
        {execution.bindings.map((binding) => { const check = execution.checks.find(({ id }) => id === binding.checkId); return <tr key={binding.command}><td>{binding.command}</td><td>{binding.checkId}</td><td>{check === undefined ? "unavailable" : [check.executable, ...check.arguments].join(" ")}</td><td>{binding.authorization.replace("_", " ")}</td><td>{binding.expectedExitCode}</td></tr>; })}
      </tbody></table></div>
    </>}
  </Section>;
}

function Planning({ view }: { readonly view: TestingOperatorView }): ReactElement {
  const { planning } = view;
  return <Section id="testing-planning-title" title="planning gate">
    {planning === null ? <p className="state" data-state="unexamined">no planning result recorded</p> : <>
      <p className="state" data-state={planning.passed ? "verified" : "refuted"}>planning · {planning.passed ? "passed" : "failed"} · {planning.selectedGaps} selected gaps · tests executed during planning · no{planning.reasons.length === 0 ? "" : ` · ${planning.reasons.join(", ")}`}</p>
      {!view.noWork ? null : <p className="state" data-state="unexamined" role="status">no work · analysis selected no gaps, so nothing was written or executed · this is not evidence of test coverage</p>}
    </>}
  </Section>;
}

function PlanVersusExecution({ view }: { readonly view: TestingOperatorView }): ReactElement {
  return <Section id="testing-plan-execution-title" title="plan versus execution">
    {view.tasks.length === 0 ? <p className="state" data-state="unexamined">no planned tasks recorded</p> : <div className="operator-table"><table aria-label="task plan versus execution"><thead><tr>
      <th scope="col">task</th><th scope="col">planned scope</th><th scope="col">write grant</th><th scope="col">planned checks</th><th scope="col">attempts</th><th scope="col">task state</th><th scope="col">final verification</th>
    </tr></thead><tbody>
      {view.tasks.map((task) => <tr key={task.taskId} data-task={task.taskId}>
        <td><span className="state" data-state="tainted">{task.taskId} · {task.title}</span></td>
        <td>{task.writeScope.join(", ")}</td>
        <td className={task.grant === null ? "state" : undefined} data-state={task.grant === null ? "refuted" : undefined}>{task.grant === null ? "no grant" : `${task.grant.partitionId}${task.grant.exclusive ? " · exclusive" : ""}`}</td>
        <td>{task.commands.map(({ command }) => command).join(", ")}</td>
        <td>{task.attempts.length} of {view.configuration.execution?.maximumAttempts ?? "unavailable"}</td>
        <td className="state" data-state={task.stale ? "degraded" : task.ledgerState === "completed" ? "verified" : task.ledgerState === "blocked" ? "refuted" : "unexamined"}>{task.ledgerState.replace("_", " ")}{task.stale ? " · stale" : ""}</td>
        <td className="state" data-state={statusToken(task.finalVerification?.status)}>{task.finalVerification === null ? "not run" : task.finalVerification.status}</td>
      </tr>)}
    </tbody></table></div>}
  </Section>;
}

function Attempts({ view }: { readonly view: TestingOperatorView }): ReactElement {
  return <Section id="testing-attempts-title" title="task attempts and check results">
    {view.tasks.map((task) => <details className="operator-task" key={task.taskId}>
      <summary>{task.taskId} · {task.attempts.length} attempts · {task.ledgerState.replace("_", " ")}</summary>
      {task.attempts.length === 0 ? <p className="state" data-state="unexamined">no attempt reserved</p> : <ol className="operator-list">{task.attempts.map((attempt) => <li key={attempt.attemptId}>
        <p className="state" data-state={statusToken(attempt.result ?? undefined)}>attempt {attempt.ordinal} · {attempt.capability} · {attempt.result ?? (attempt.state === "reserved" ? "in progress" : "unavailable")}{attempt.repairVerificationArtifactId === null ? "" : ` · repair of ${attempt.repairVerificationArtifactId}`}</p>
        <Checks verification={attempt.verification} />
      </li>)}</ol>}
      {task.finalVerification === null ? null : <><p>final verification</p><Checks verification={task.finalVerification} /></>}
    </details>)}
  </Section>;
}

function Checks({ verification }: { readonly verification: TestingVerificationSummary | null }): ReactElement {
  if (verification === null) return <p className="state" data-state="unexamined">no verification evidence recorded</p>;
  return <>
    <ul className="operator-list" aria-label={`checks for ${verification.attemptId}`}>{verification.checks.map((check) => <li className="state" data-state={statusToken(check.status)} key={`${check.checkId}:${check.executionId ?? "none"}`}>
      {check.checkId} · {check.command} · {check.status} · exit {check.actualExitCode ?? "unavailable"} (expected {check.expectedExitCode})
    </li>)}</ul>
    {verification.reasons.length === 0 ? null : <p className="state" data-state="degraded">{verification.reasons.join(", ")}</p>}
  </>;
}

function Repair({ view }: { readonly view: TestingOperatorView }): ReactElement {
  const { repair } = view;
  return <Section id="testing-repair-title" title="repair">
    <p>{repair.rounds.length} of {view.configuration.execution?.maximumRepairRounds ?? "unavailable"} repair rounds used</p>
    {repair.rounds.length === 0 ? <p className="state" data-state="unexamined">no repair round recorded</p> : <ol className="operator-list" aria-label="repair rounds">{repair.rounds.map((round) => <li className="state" data-state="degraded" key={round.round}>
      round {round.round} · {round.state} · invalidated snapshot {round.snapshotFingerprint.slice(0, 12)} · failed {round.failedTaskIds.join(", ") || "none"} · reopened {round.reopened.map(({ taskId, causeTaskId }) => taskId === causeTaskId ? taskId : `${taskId} (via ${causeTaskId})`).join(", ") || "none"} · stale {round.staleTaskIds.join(", ") || "none"}
    </li>)}</ol>}
    {repair.terminal === null ? null : <p className="state" data-state="refuted">repair stopped · {repair.terminal.reason}</p>}
  </Section>;
}

function Outcome({ view }: { readonly view: TestingOperatorView }): ReactElement {
  const { execution } = view;
  return <Section id="testing-outcome-title" title="execution outcome">
    {execution === null ? <p className="state" data-state="unexamined">no execution outcome recorded</p> : <>
      <p className="state" data-state={execution.passed ? "verified" : "refuted"}>execution · {execution.passed ? "passed" : "failed"}{execution.reasons.length === 0 ? "" : ` · ${execution.reasons.join(", ")}`}</p>
      <p className="state" data-state={execution.planMatches ? "verified" : "refuted"}>plan fingerprint · {execution.planMatches ? "matches the passed plan" : "does not match the passed plan"}</p>
    </>}
  </Section>;
}

function Handoff({ view, api, runId, planHandoff, artifactApi }: { readonly view: TestingOperatorView; readonly api: TestingApi; readonly runId: string; readonly planHandoff: ArtifactDescriptor | undefined; readonly artifactApi: ArtifactApi }): ReactElement {
  const [changeSet, setChangeSet] = useState<TestingVerifiedChangeSet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const available = view.handoff.verifiedChangeSet;
  const retrieve = async (): Promise<TestingVerifiedChangeSet | null> => {
    try { const value = changeSet ?? await api.changeSet(runId); setChangeSet(value); setError(null); return value; }
    catch (cause) { setError(failure(cause)); return null; }
  };
  return <Section id="testing-handoff-title" title="handoff">
    {planHandoff === undefined ? <p className="state" data-state="unexamined">no plan handoff</p>
      : <button type="button" onClick={() => { void artifactApi.load(runId, planHandoff.artifactId).then((artifact) => downloadJson(`${runId}-test-plan-handoff.json`, JSON.parse(artifact.content) as unknown), (cause: unknown) => setError(failure(cause))); }}>download plan handoff</button>}
    {view.configuration.mode !== "execute" ? null : available === null
      ? <p className="state" data-state="unexamined">no verified change set · {view.noWork ? "no work was selected" : "withheld until fresh final verification passes"}</p>
      : <>
        <p className="state" data-state="verified">verified change set · {available.files} files · {available.changeSetArtifactId}</p>
        <div className="operator-actions">
          <button type="button" onClick={() => { void retrieve(); }}>inspect verified change set</button>
          <button type="button" onClick={() => { void retrieve().then((value) => { if (value !== null) downloadJson(`${runId}-verified-change-set.json`, value); }); }}>download verified change set</button>
        </div>
        <p className="operator-note">Apply a file only when the destination bytes match its expected hash; a null expected hash means the file must not exist yet.</p>
      </>}
    {error === null ? null : <p className="state" data-state="degraded" role="alert">handoff unavailable · {error}</p>}
    {changeSet === null ? null : <ul className="operator-list" aria-label="verified files">{changeSet.changeSet.files.map((file) => <li key={file.path}>
      <p>{file.path} · {file.expectedHash === null ? "create" : `replace ${file.expectedHash.slice(0, 12)}`} · content {file.contentHash.slice(0, 12)}</p>
      <p className="state" data-state="tainted">model-written content · untrusted text</p>
      <pre>{file.content}</pre>
    </li>)}</ul>}
  </Section>;
}

function statusToken(status: string | undefined): string { return status === "passed" ? "verified" : status === "failed" ? "refuted" : status === "incomplete" ? "degraded" : "unexamined"; }

const SHARED_TESTING = new TestingApi();
const SHARED_ARTIFACTS = new ArtifactApi();
