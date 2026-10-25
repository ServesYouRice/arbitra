import "./summary.css";
import { useState, type ReactElement, type ReactNode } from "react";
import type { ArtifactDescriptor } from "../../api/artifacts.js";
import { useLoaded, useNow, type Loaded, type RunOverview, type RunProgress, type RunResource } from "../../api/runs.js";
import type { RunEvent } from "../../api/sse.js";
import { useApis } from "../../app/apis.js";
import { formatTime, isActive } from "../../app/format.js";
import { Link, type RunTab } from "../../app/router.js";
import { tokens as limitWords } from "../../app/token-limit.js";
import { counted, duration, failureWords, SEVERITIES, severityWord, stepDoing, tokenWords, type Mode } from "../../app/words.js";
import { CopyButton } from "../../controls/CopyButton.js";
import { useEvaluationMetrics, type ConfirmedYield } from "../../views/evaluation/api.js";
import { FeatureOutcome, HandoffDownload } from "../../views/feature/FeatureView.js";
import type { PersistedPlan } from "../../views/plan/traceability.js";
import { RUN_ARTIFACT_KINDS, useRunArtifact } from "../../views/issue-board/run-artifacts.js";
import { Handoff, Outcome, Planning, useTestingView } from "../../views/testing/TestingView.js";
import { criticWords, runTime, stageNotes, stageTimes, stepModels, type CritiqueRecord, type PreflightRecord } from "./facts.js";
import { notificationsSupported, useNotifyChoice } from "./notify.js";
import { record } from "./models.js";
import { reportText } from "./RunReport.js";
import { StageGraph, stageViews } from "./StageGraph.js";

export interface SummaryProps {
  readonly runId: string;
  readonly mode: Mode;
  readonly run: RunResource | null;
  readonly overview: RunOverview | null;
  readonly artifacts: readonly ArtifactDescriptor[];
  readonly progress: Loaded<RunProgress>;
  readonly events: readonly RunEvent[];
  readonly reason: string | null;
  readonly refreshKey: unknown;
  readonly selectedNode: string | null;
  readonly onSelectNode: (id: string) => void;
}

/**
 * What a person needs from the run first. While it works: where it stands, the stages and what it has found so far.
 * When it stopped: what happened and what to do, in words. When it is done: the plan to save into the project, what
 * needs the person, the issues by verdict and how the run went.
 */
export function SummaryTab(props: SummaryProps): ReactElement {
  const state = props.run?.state ?? props.overview?.state ?? null;
  if (state === null) return <p role="status">reading the run</p>;
  // A Feature or Testing run's requirements, tests and handoff show while it works or waits, as they always have.
  const own = props.mode === "audit" ? null : <ModeSummary {...props} />;
  if (isActive(state)) return <div className="summary"><WatchView {...props} state={state} />{own}</div>;
  if (state === "COMPLETED") return <div className="summary">{props.mode === "audit" ? <AuditDone {...props} /> : <OtherDone {...props} />}</div>;
  return <div className="summary"><Stopped {...props} state={state} />{own}</div>;
}

function ModeSummary({ runId, mode, run, artifacts, refreshKey }: SummaryProps): ReactElement {
  return mode === "feature" ? <FeatureSummary runId={runId} run={run} artifacts={artifacts} refreshKey={refreshKey} /> : <TestingSummary runId={runId} run={run} artifacts={artifacts} refreshKey={refreshKey} />;
}

function useStageData({ runId, mode, run, overview, progress, events, artifacts, refreshKey }: SummaryProps, now: number) {
  const { artifacts: api } = useApis();
  const preflight = useRunArtifact<PreflightRecord>(api, artifacts.some(({ kind }) => kind === "preflight") ? runId : null, "preflight", refreshKey).value;
  const critique = useRunArtifact<CritiqueRecord>(api, artifacts.some(({ kind }) => kind === RUN_ARTIFACT_KINDS.criticFeedback) ? runId : null, RUN_ARTIFACT_KINDS.criticFeedback, refreshKey).value;
  const workflow = run?.workflow ?? null;
  if (workflow === null) return null;
  const notes = stageNotes({ workflow, progress: progress.value, preflight, critique });
  return { workflow, preflight, critique, stages: stageViews({ workflow, mode, progress: progress.value, events, now, models: stepModels(overview), notes }) };
}

/** The status line, the stages and what discovery has found so far: the run page while a run works. */
function WatchView(props: SummaryProps & { readonly state: string }): ReactElement {
  const { runId, mode, overview, progress, selectedNode, onSelectNode } = props;
  const live = overview?.live === true;
  const now = useNow(live);
  const data = useStageData(props, now);
  const value = progress.value;
  const running = data?.stages.filter(({ status }) => status === "running") ?? [];
  const first = running[0];
  const node = first === undefined ? undefined : data?.workflow.nodes.find(({ id }) => id === first.id);
  const time = runTime(value, overview, now);
  const stageTime = first?.elapsedMs ?? null;
  const doing = node === undefined ? data?.stages.some(({ status }) => status === "done") === true ? "Between stages" : "Starting" : stepDoing(node, mode);
  const parts = value?.auditors.reduce((total, { partsRead }) => total + partsRead, 0) ?? 0;
  const facts = [
    ...(value !== null && value.auditors.length > 0 && parts > 0 ? [`${counted(parts, "part")} read`] : []),
    ...(value !== null && value.auditors.length > 0 ? [`${counted(value.found.total, "issue")} found, not checked yet`] : []),
    ...(value === null ? [] : [`${tokenWords(value.tokens.used)}${value.tokens.limit === null ? "" : ` of ${limitWords(value.tokens.limit)}`} tokens`]),
  ];
  return <>
    {live ? null : <p className="state" data-state="degraded">This arbitra is not running this run. Another arbitra, such as the command line, may be running it, or it stopped when its process ended. Resume it from the header only if nothing else is running it.</p>}
    <section aria-label="now" className="watch-now">
      <p className="watch-now__line">{doing}{stageTime !== null ? ` · ${duration(stageTime)} so far` : time === null ? "" : ` · ${duration(time.ms)} so far`}</p>
      {facts.length === 0 ? null : <p className="watch-now__facts">{facts.join(" · ")}</p>}
      {progress.error === null ? null : <p className="note">The run's progress could not be read just now, so the stages below follow its live events and show no times. The page tries again by itself.</p>}
    </section>
    <section aria-labelledby="stages-title" className="summary-section">
      <h2 className="panel-title" id="stages-title">Stages</h2>
      {data === null ? <p className="note">The run's stages are not recorded yet.</p> : <StageGraph stages={data.stages} workflow={data.workflow} selectedId={selectedNode} onSelect={onSelectNode} />}
      {value === null || value.restarted.afterTimeout === 0 ? null : <Restarted restarted={value.restarted} />}
    </section>
    {value === null || value.auditors.length === 0 ? null : <FoundSoFar found={value.found} />}
    <div className="watch-foot">
      <NotifyToggle />
      <Link className="more-link" to={{ page: "run", runId, tab: "activity", item: null }}>Records</Link>
    </div>
  </>;
}

function Restarted({ restarted }: { readonly restarted: RunProgress["restarted"] }): ReactElement {
  const limit = restarted.timeoutMs === null ? "their time limit" : duration(restarted.timeoutMs);
  return <details className="disclosure restarted">
    <summary>{restarted.afterTimeout === 1 ? "1 model call" : `${restarted.afterTimeout} model calls`} ran past {limit} and {restarted.afterTimeout === 1 ? "was" : "were"} started again. Which</summary>
    <ul className="plain-list data">{restarted.activities.map((activity) => <li key={activity}>{activity.replace(/[0-9a-f]{16,}/gu, (hash) => `${hash.slice(0, 8)}…`)}</li>)}</ul>
  </details>;
}

/** Discovery's findings as each part is read, most severe first: not merged and not checked, and said so. */
function FoundSoFar({ found }: { readonly found: RunProgress["found"] }): ReactElement {
  const [all, setAll] = useState(false);
  const shown = all ? found.items : found.items.slice(0, 4);
  const counts = SEVERITIES.filter((severity) => found.bySeverity[severity] > 0).map((severity) => `${found.bySeverity[severity]} ${severityWord(severity)}`).join(" · ");
  return <section aria-labelledby="found-title" className="summary-section">
    <div className="summary-section__head">
      <h2 className="panel-title" id="found-title">Found so far · not checked yet</h2>
      {counts === "" ? null : <span className="data">{counts}</span>}
    </div>
    {found.total === 0 ? <p className="note">Nothing found yet. Issues appear here as each part of the project is read.</p> : <>
      <ul aria-label="issues found so far" className="found-list">{shown.map((item, index) => <li className="found-item" data-severity={item.severity} key={`${index}:${item.title}`}>
        <span className="found-item__title">{item.title}</span>
        <span className="found-item__place">{item.path === null ? "no place recorded" : `${item.path}${item.line === null ? "" : `:${item.line}`}`}</span>
      </li>)}</ul>
      {found.items.length > shown.length ? <button className="link-button more-link" type="button" onClick={() => setAll(true)}>All {found.total.toLocaleString("en")}, not checked yet</button> : null}
    </>}
  </section>;
}

function NotifyToggle(): ReactElement | null {
  const [on, choose] = useNotifyChoice();
  if (!notificationsSupported()) return null;
  return <label className="notify"><input checked={on} type="checkbox" onChange={(event) => choose(event.target.checked)} />Tell me when it ends, pauses or needs me</label>;
}

/** A run that stopped before it was done: what happened and what to do, then where it stopped. */
function Stopped(props: SummaryProps & { readonly state: string }): ReactElement {
  const { runId, state, overview, progress, reason, selectedNode, onSelectNode } = props;
  const data = useStageData(props, Date.now());
  const why = reason ?? overview?.reason ?? null;
  const limit = record(record(overview?.configuration?.["workflow"])["modelExecution"])["maximumTokens"];
  const note: ReactNode = state === "FAILED" ? <FailureNote reason={why} />
    : state === "SUSPENDED_RATE_LIMIT" ? <UsageLimitPause reason={why} />
    : state === "SUSPENDED_BUDGET" ? <Alert title="Paused at its token limit">The run reached its limit{typeof limit === "number" ? ` of ${limitWords(limit)} tokens` : ""}, with everything it has done kept. Raise the limit in the header to go on from where it stopped.</Alert>
    : state === "CANCELLED" ? <Alert title="Cancelled">The run was cancelled. What it finished is kept: resume it from the header to go on from where it stopped.</Alert>
    : state === "BLOCKED" ? <Alert title="Needs you" tone="attention">The run waits on the decisions above. Each is recorded at once; the run goes on when you resume it.</Alert>
    : <Alert title="Stopped">The run is not working and its state is not one this page knows.</Alert>;
  return <>
    {note}
    {data === null ? null : <section aria-labelledby="stages-title" className="summary-section">
      <h2 className="panel-title" id="stages-title">Where it stopped</h2>
      <StageGraph stages={data.stages} workflow={data.workflow} selectedId={selectedNode} onSelect={onSelectNode} />
    </section>}
    {progress.value === null || progress.value.found.total === 0 || props.artifacts.some(({ kind }) => kind === RUN_ARTIFACT_KINDS.canonicalIssues) ? null : <FoundSoFar found={progress.value.found} />}
    {props.mode === "audit" && props.artifacts.some(({ kind }) => kind === RUN_ARTIFACT_KINDS.canonicalIssues) ? <IssueCounts runId={runId} /> : null}
  </>;
}

function Alert({ title, tone = "degraded", children }: { readonly title: string; readonly tone?: "degraded" | "refuted" | "attention"; readonly children: ReactNode }): ReactElement {
  return <section aria-label={title} className="summary-alert" data-tone={tone}>
    <h2 className="summary-alert__title">{title}</h2>
    <div className="summary-alert__body">{children}</div>
  </section>;
}

/** What failed and what to do, plainly; the recorded reason one click down. */
function FailureNote({ reason }: { readonly reason: string | null }): ReactElement {
  const words = failureWords(reason);
  return <Alert title="The run failed" tone="refuted">
    <p className="prose">{words.what}</p>
    <p className="prose">{words.todo}</p>
    <details className="disclosure"><summary>What the run recorded</summary><pre className="artifact__content">{reason ?? "no reason recorded"}</pre></details>
  </Alert>;
}

/** Which allowance ran out and, when the provider said, when arbitra goes on by itself. */
export function UsageLimitPause({ reason }: { readonly reason: string | null }): ReactElement {
  const until = /\buntil (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/u.exec(reason ?? "")?.[1];
  const who = /\bthe (.+?) subscription's usage allowance/u.exec(reason ?? "")?.[1] ?? /^\w+: Provider (\S+)/u.exec(reason ?? "")?.[1];
  return <Alert title="Paused for usage">
    <p className="prose">The run paused because {who === undefined ? "a model's" : `${who}'s`} usage limit was reached. Everything it has done is kept.{" "}
      {until === undefined ? "Resume it from the header once the limit has reset." : <>The limit resets at {formatTime(until)}; arbitra resumes the run by itself a minute later while it stays open, or resume it from the header then.</>}</p>
  </Alert>;
}

/** A finished Audit: the plan to save first, then what needs the person, the issues by verdict, and how it ran. */
function AuditDone(props: SummaryProps): ReactElement {
  const { runId, artifacts, overview, progress, refreshKey } = props;
  const { artifacts: api, evaluation } = useApis();
  const plan = useRunArtifact<PersistedPlan>(api, artifacts.some(({ kind }) => kind === RUN_ARTIFACT_KINDS.plan) ? runId : null, RUN_ARTIFACT_KINDS.plan, refreshKey);
  const metrics = useEvaluationMetrics(evaluation, runId);
  const confirmed = metrics.metrics?.confirmedYield ?? null;
  const data = useStageData(props, Date.now());
  const questions = plan.value?.unresolvedQuestions.filter(({ blocking }) => blocking).length ?? 0;
  return <>
    {plan.value === null ? <p className="state" data-state="unexamined">{plan.state === "loading" ? "reading the plan" : plan.state === "error" ? `The plan could not be read (${plan.error ?? "error"}).` : "This run wrote no plan: it found no issue that needs one."}</p>
      : <PlanCard runId={runId} plan={plan.value} questions={questions} />}
    <NeedsYou runId={runId} questions={questions} confirmed={confirmed} reasons={overview?.gate?.reasons ?? []} />
    <IssueCounts runId={runId} />
    <RanFacts runId={runId} mode="audit" overview={overview} progress={progress.value} confirmed={confirmed} critique={data?.critique ?? null} workflow={props.run?.workflow ?? null} />
  </>;
}

/** The plan comes first, with saving it into the project as the page's one primary action; once saved, where and what next. */
function PlanCard({ runId, plan, questions }: { readonly runId: string; readonly plan: PersistedPlan; readonly questions: number }): ReactElement {
  const { runs } = useApis();
  const [version, setVersion] = useState(0);
  const saved = useLoaded(`saved-plans:${runId}`, () => runs.savedPlans(runId), version);
  const [saving, setSaving] = useState<{ readonly busy: boolean; readonly failure: string | null }>({ busy: false, failure: null });
  const latest = saved.value?.saved[0] ?? null;
  const save = (): void => {
    setSaving({ busy: true, failure: null });
    void runs.savePlan(runId).then(() => { setSaving({ busy: false, failure: null }); setVersion((value) => value + 1); },
      (cause: unknown) => setSaving({ busy: false, failure: cause instanceof Error ? cause.message : String(cause) }));
  };
  const request = latest === null ? "" : `Work through ${latest.relative}/README.md in this project, one task at a time, as its AGENTS.md says.${questions > 0 ? " Ask me its questions first." : ""}`;
  return <section aria-labelledby="plan-card-title" className="plan-card" data-saved={latest !== null}>
    <h2 className="plan-card__title" id="plan-card-title">The plan is ready · {counted(plan.tasks.length, "task")} for {counted(plan.acceptedIssueIds.length, "issue")}</h2>
    {latest === null ? <>
      <p className="prose">Save it into the project: a folder with one prompt per task, sorted by the model each needs, and a README your coding agent follows.</p>
      <div className="actions">
        <button className="button button--primary" disabled={saving.busy} type="button" onClick={save}>{saving.busy ? "Saving the plan" : "Save the plan into the project"}</button>
        <Link className="more-link" to={{ page: "run", runId, tab: "plan", item: null }}>Read it first</Link>
      </div>
      {saving.failure === null ? <p className="note">{saved.loading && saved.value === null ? "Checking whether it was saved before." : "Not saved yet. Nothing in the project changes until you save."}</p>
        : <p className="state" data-state="degraded" role="alert">The plan was not saved: {saving.failure}. Nothing in the project changed.</p>}
    </> : <>
      <p className="plan-card__saved"><span>Saved in the project</span> <code>{latest.relative}</code></p>
      <p className="prose">Next: open the project in Claude Code or Codex and ask it to work through <code>{latest.relative}/README.md</code>.{questions > 0 ? ` Answer the ${counted(questions, "question")} it asks first: they are decisions only you can make.` : ""}</p>
      <div className="actions">
        <CopyButton label="Copy that request" text={request} />
        <Link className="more-link" to={{ page: "run", runId, tab: "plan", item: null }}>Read the plan</Link>
      </div>
      <p className="note">Saved {formatTime(latest.savedAt)}.{(saved.value?.saved.length ?? 0) > 1 ? ` ${saved.value?.saved.length ?? 0} copies are in .arbitra/plans; this is the newest.` : ""}</p>
    </>}
  </section>;
}

/** What only the person can do now, each a link to where it is done. */
function NeedsYou({ runId, questions, confirmed, reasons }: { readonly runId: string; readonly questions: number; readonly confirmed: ConfirmedYield | null; readonly reasons: readonly string[] }): ReactElement {
  const items: { readonly text: string; readonly tab: RunTab; readonly action: string }[] = [
    ...(questions > 0 ? [{ text: `${counted(questions, "question")} only you can answer, before the tasks`, tab: "plan" as const, action: "Answer" }] : []),
    ...(confirmed !== null && confirmed.unsettled > 0 ? [{ text: `${counted(confirmed.unsettled, "issue")} the check could not settle: the plan checks them first`, tab: "issues" as const, action: "See them" }] : []),
    ...(reasons.includes("blocking_critic_feedback") ? [{ text: "An objection to the plan that its revision does not answer", tab: "plan" as const, action: "Read it" }] : []),
  ];
  return <section aria-labelledby="needs-title" className="summary-section">
    <h2 className="panel-title" id="needs-title">Needs you</h2>
    {items.length === 0 ? <p className="note">Nothing needs you before the plan is carried out.</p>
      : <ul className="needs-list">{items.map(({ text, tab, action }) => <li key={text}><Link to={{ page: "run", runId, tab, item: null }}><span>{text}</span><span aria-hidden="true">{action} →</span></Link></li>)}</ul>}
  </section>;
}

/** The issues by what the check decided: confirmed · unsettled · rejected · not checked. */
function IssueCounts({ runId }: { readonly runId: string }): ReactElement {
  const { evaluation } = useApis();
  const metrics = useEvaluationMetrics(evaluation, runId);
  const value = metrics.metrics?.confirmedYield ?? null;
  const severities = value === null ? "" : SEVERITIES.flatMap((severity) => (value.confirmedBySeverity[severity] ?? 0) > 0 ? [`${value.confirmedBySeverity[severity] ?? 0} ${severityWord(severity)}`] : []).join(", ");
  return <section aria-labelledby="issues-title" className="summary-section">
    <h2 className="panel-title" id="issues-title">Issues{value === null ? "" : ` · ${counted(value.candidates, "found", "found")}`}</h2>
    {value === null ? <p className="state" data-state={metrics.state === "error" ? "degraded" : "unexamined"}>{metrics.state === "error" ? `The issue counts could not be read (${metrics.error ?? "error"}).` : metrics.state === "loading" ? "reading the issues" : "No issue was recorded."}</p> : <>
      <div className="verdicts">
        <Verdict count={value.confirmed} word="confirmed" detail={severities} />
        <Verdict count={value.unsettled} word="unsettled" detail="the check could not settle them" />
        <Verdict count={value.rejected} word="rejected" detail="each with its reason" />
        <Verdict count={value.notChecked + value.acceptedUnchecked} word="not checked" detail={value.acceptedUnchecked === 0 ? "below the plan's bar, or left open" : `${value.acceptedUnchecked} of them accepted by the reviewers without a check`} />
      </div>
      <Link className="more-link" to={{ page: "run", runId, tab: "issues", item: null }}>Open the issues</Link>
    </>}
  </section>;
}

function Verdict({ count, word, detail }: { readonly count: number; readonly word: string; readonly detail: string }): ReactElement {
  return <div className="verdict" data-verdict={word}><span className="verdict__count">{count.toLocaleString("en")}</span><span className="verdict__words"><span className="verdict__word">{word}</span>{detail === "" ? "" : ` · ${detail}`}</span></div>;
}

/** How the run went, in a few facts: time, tokens, and which model did each step at what effort. */
export function RanFacts({ runId, mode, overview, progress, confirmed, critique, workflow, full = false }: {
  readonly runId: string; readonly mode: Mode; readonly overview: RunOverview | null; readonly progress: RunProgress | null; readonly confirmed: ConfirmedYield | null;
  readonly critique: CritiqueRecord | null; readonly workflow: RunResource["workflow"] | null; readonly full?: boolean;
}): ReactElement {
  const now = Date.now();
  const time = runTime(progress, overview, now);
  const perStage = workflow === null || workflow === undefined ? null : stageTimes(workflow, mode, progress, now);
  const models = stepModels(overview);
  const auditors = [...models].filter(([id]) => id.startsWith("auditor-")).map(([, label]) => label);
  const hasCritic = workflow?.nodes.some(({ id }) => id === "critic") === true;
  const scripted = overview?.executor === "scripted";
  const tokensUsed = progress?.tokens.used ?? confirmed?.tokens ?? null;
  return <section aria-labelledby={full ? "ran-facts-title" : "ran-title"} className="summary-section">
    {full ? <h2 className="panel-title" id="ran-facts-title">Time, tokens and models</h2> : <h2 className="panel-title" id="ran-title">How it ran</h2>}
    <dl className="facts ran-facts">
      <div><dt>time</dt><dd>{time === null ? "not recorded" : `${duration(time.ms)}${perStage === null ? time.recorded ? "" : " from its start to its last record" : ` · ${perStage}`}`}</dd></div>
      <div><dt>tokens</dt><dd>{scripted ? "none: scripted detectors call no model" : tokensUsed === null ? "not recorded" : `${tokenWords(tokensUsed)}${confirmed?.tokensPerConfirmed == null ? "" : ` · ${tokenWords(confirmed.tokensPerConfirmed)} per confirmed issue`}${(progress?.tokens.callsWithoutUsage ?? 0) > 0 ? ` · ${counted(progress?.tokens.callsWithoutUsage ?? 0, "call")} reported none` : ""}`}</dd></div>
      {mode !== "audit" ? null : scripted ? <div><dt>found issues</dt><dd>scripted detectors, no model calls</dd></div> : <>
        {auditors.length === 0 ? null : <div><dt>found issues</dt><dd>{auditors.join(", ")}</dd></div>}
        {models.has("verification") ? <div><dt>checked them</dt><dd>{models.get("verification")}</dd></div> : null}
        {models.has("planner") ? <div><dt>wrote the plan</dt><dd>{models.get("planner")}</dd></div> : null}
        {hasCritic ? <div><dt>reviewed the plan</dt><dd>{[models.get("critic"), critique === null ? null : criticWords(critique)].filter(Boolean).join(" · ") || "recorded no review"}</dd></div> : null}
      </>}
    </dl>
    {full ? null : <div className="summary-links">
      <CopyButton className="link-button more-link" label="Copy a report to send" read={() => reportText(runId)} />
      <Link className="more-link" to={{ page: "run", runId, tab: "how-it-ran", item: null }}>How it ran, in full</Link>
    </div>}
  </section>;
}

/** A finished Feature or Testing run: what it produced, as today, and how it ran. */
function OtherDone(props: SummaryProps): ReactElement {
  const { runId, mode, run, overview, progress } = props;
  return <>
    <ModeSummary {...props} />
    <RanFacts runId={runId} mode={mode} overview={overview} progress={progress.value} confirmed={null} critique={null} workflow={run?.workflow ?? null} />
  </>;
}

function FeatureSummary({ runId, run, artifacts, refreshKey }: { readonly runId: string; readonly run: RunResource | null; readonly artifacts: readonly ArtifactDescriptor[]; readonly refreshKey: unknown }): ReactElement {
  const apis = useApis();
  const contract = useLoaded(`requirements:${runId}`, () => apis.requirements.current(runId), refreshKey);
  const outcome = artifacts.find(({ kind }) => kind === "feature-outcome");
  const handoff = artifacts.find(({ kind }) => kind === "implementation");
  return <section aria-labelledby="feature-summary-title" className="summary-section">
    <h2 className="panel-title" id="feature-summary-title">Requirements and handoff</h2>
    {contract.error !== null ? <p className="state" data-state="degraded">The requirements could not be read ({contract.error}).</p>
      : contract.value === null ? <p className="state" data-state="unexamined">{contract.loading ? "reading the requirements" : "No requirements were recorded."}</p>
      : <>
        <p className="prose">{contract.value.contract.featureRequest}</p>
        <p className="data">{contract.value.contract.ambiguities.length} ambiguities · {contract.value.contract.acceptance.length} acceptance assertions</p>
        {contract.value.pendingAmbiguityIds.length === 0 ? null : <p className="state" data-state="attention">{counted(contract.value.pendingAmbiguityIds.length, "proposed default")} wait for your approval</p>}
      </>}
    {outcome === undefined ? <p className="state" data-state="unexamined">No outcome was recorded.</p> : <FeatureOutcome api={apis.artifacts} runId={runId} artifactId={outcome.artifactId} />}
    <HandoffDownload api={apis.artifacts} runId={runId} handoff={handoff} />
    {run === null ? null : <Link className="more-link" to={{ page: "run", runId, tab: "requirements", item: null }}>Open the requirements</Link>}
  </section>;
}

function TestingSummary({ runId, run, artifacts, refreshKey }: { readonly runId: string; readonly run: RunResource | null; readonly artifacts: readonly ArtifactDescriptor[]; readonly refreshKey: unknown }): ReactElement {
  const apis = useApis();
  const { view, error } = useTestingView(apis.testing, runId, run, refreshKey);
  return <section aria-labelledby="testing-summary-title" className="summary-section operator-view">
    <h2 className="panel-title" id="testing-summary-title">Tests</h2>
    {error !== null ? <p className="state" data-state="degraded">The testing result could not be read ({error}).</p> : view === null ? <p role="status">reading the testing result</p> : <>
      <p className="prose">{view.configuration.goal}</p>
      <Planning view={view} />
      {view.configuration.mode === "execute" && !view.noWork ? <Outcome view={view} /> : null}
      <Handoff view={view} api={apis.testing} runId={runId} planHandoff={artifacts.find(({ kind }) => kind === "implementation")} artifactApi={apis.artifacts} />
      <Link className="more-link" to={{ page: "run", runId, tab: "execution", item: null }}>Open the execution record</Link>
    </>}
  </section>;
}
