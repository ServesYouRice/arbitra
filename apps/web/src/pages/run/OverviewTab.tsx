import type { ReactElement } from "react";
import type { ArtifactDescriptor } from "../../api/artifacts.js";
import type { RunOverview, RunResource } from "../../api/runs.js";
import { useLoaded } from "../../api/runs.js";
import { useApis } from "../../app/apis.js";
import { isActive } from "../../app/format.js";
import { GateVerdict } from "../../app/marks.js";
import { Link, type RunTab } from "../../app/router.js";
import { FeatureOutcome, HandoffDownload } from "../../views/feature/FeatureView.js";
import { CONSENSUS_LABELS, CoverageSummary, useIssueBoard } from "../../views/issue-board/IssueBoardView.js";
import { usePlan } from "../../views/plan/PlanView.js";
import { Handoff, Outcome, Planning, useTestingView } from "../../views/testing/TestingView.js";
import { executorText } from "./RunHeader.js";
import { ModelTable } from "./NodeDetails.js";
import { modelProfiles } from "./models.js";
import { selectionItem } from "./selection.js";

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "informational"];

/** What the run concluded, what it produced, and how it was set up, each read from its own records. */
export function OverviewTab({ runId, mode, run, overview, artifacts, reason, refreshKey }: {
  readonly runId: string;
  readonly mode: "audit" | "feature" | "testing";
  readonly run: RunResource | null;
  readonly overview: RunOverview | null;
  readonly artifacts: readonly ArtifactDescriptor[];
  readonly reason: string | null;
  readonly refreshKey: unknown;
}): ReactElement {
  return <div className="overview">
    <Result run={run} overview={overview} reason={reason} />
    {mode === "audit" ? <AuditSummary runId={runId} refreshKey={refreshKey} />
      : mode === "feature" ? <FeatureSummary runId={runId} run={run} artifacts={artifacts} refreshKey={refreshKey} />
      : <TestingSummary runId={runId} run={run} artifacts={artifacts} refreshKey={refreshKey} />}
    {mode === "audit" ? null : <PlanSummary runId={runId} refreshKey={refreshKey} />}
    <HowItRan overview={overview} />
  </div>;
}

function Result({ run, overview, reason }: { readonly run: RunResource | null; readonly overview: RunOverview | null; readonly reason: string | null }): ReactElement {
  const state = run?.state ?? overview?.state ?? null;
  return <section aria-labelledby="result-title" className="section">
    <h2 className="panel-title" id="result-title">result</h2>
    {state === "COMPLETED" ? overview?.gate == null ? <p role="status">reading the gate</p> : <>
      <GateVerdict gate={overview.gate} />
      {overview.executor === "scripted" && overview.gate.reasons.includes("degraded_coverage") ? <p className="note">Scripted detectors do not cover the security protocol, so a scripted run always fails the gate on coverage. That is expected and is not a crash.</p> : null}
    </>
      : state === "BLOCKED" ? <p className="state" data-state="attention">The run is waiting for your decision. The banner above lists what it needs.</p>
      : state === "FAILED" ? <p className="state" data-state="refuted">The run failed · {reason ?? overview?.reason ?? "no reason recorded"}. Resume it from the header to retry from where it stopped.</p>
      : state === "CANCELLED" ? <p className="state" data-state="unexamined">The run was cancelled. Resume it from the header to continue from where it stopped.</p>
      : state === "SUSPENDED_BUDGET" ? <p className="state" data-state="degraded">The run paused when it reached its token budget. It stays paused until you resume it, and a resume continues only as far as the budget allows.</p>
      : state === "SUSPENDED_RATE_LIMIT" ? <p className="state" data-state="degraded">The run paused on a provider rate limit. Resume it once the limit has reset.</p>
      : isActive(state) ? <p className="note">The run is still working. Results appear below as its stages record them.</p>
      : <p role="status">reading the run</p>}
  </section>;
}

function AuditSummary({ runId, refreshKey }: { readonly runId: string; readonly refreshKey: unknown }): ReactElement {
  const { artifacts } = useApis();
  const { issueSet, rows } = useIssueBoard(artifacts, runId, refreshKey);
  const ranked = [...rows].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || Number(b.blocker) - Number(a.blocker)).slice(0, 5);
  return <>
    <section aria-labelledby="issues-summary-title" className="section">
      <h2 className="panel-title" id="issues-summary-title">issues</h2>
      {issueSet.state !== "loaded" || issueSet.value === null ? <p className="state" data-state={issueSet.state === "error" ? "degraded" : "unexamined"}>{issueSet.state === "error" ? `issue set unavailable · ${issueSet.error ?? "error"}` : issueSet.state === "loading" ? "reading the issue set" : "no canonical issue set recorded yet"}</p> : <>
        <p className="board-summary">{rows.length} canonical issues from {issueSet.value.summary.sourceFindingCount} source findings by {issueSet.value.summary.auditorCount} auditors · {issueSet.value.summary.acceptedCount} accepted · {issueSet.value.summary.rejectedCount} rejected · {issueSet.value.summary.unresolvedCount} unresolved · {rows.filter(({ blocker }) => blocker).length} blockers</p>
        <CoverageSummary issueSet={issueSet.value} />
        {ranked.length === 0 ? null : <ul aria-label="most severe issues" className="plain-list">{ranked.map((row) => <li className="overview-issue" data-severity={row.severity} key={row.candidateId}>
          <Link to={{ page: "run", runId, tab: "issues", item: selectionItem({ kind: "issue", id: row.candidateId }) }}>{row.title}</Link>
          <span className="muted"> {row.severity}{row.blocker ? " · blocker" : ""} · {CONSENSUS_LABELS[row.consensusState]}{row.dissent.length === 0 ? "" : " · dissent recorded"}</span>
        </li>)}</ul>}
        <p><TabLink runId={runId} tab="issues">open the issue board</TabLink></p>
      </>}
    </section>
    <PlanSummary runId={runId} refreshKey={refreshKey} />
  </>;
}

function PlanSummary({ runId, refreshKey }: { readonly runId: string; readonly refreshKey: unknown }): ReactElement {
  const { artifacts } = useApis();
  const { plan, critique } = usePlan(artifacts, runId, refreshKey);
  const value = plan.value;
  return <section aria-labelledby="plan-summary-title" className="section">
    <h2 className="panel-title" id="plan-summary-title">plan</h2>
    {value === null ? <p className="state" data-state={plan.state === "error" ? "degraded" : "unexamined"}>{plan.state === "error" ? `plan unavailable · ${plan.error ?? "error"}` : plan.state === "loading" ? "reading the plan" : "no plan recorded yet"}</p> : <>
      <p className="data">{value.title} · {value.tasks.length} tasks · {value.validationContract.validation.length} validation assertions</p>
      {value.unresolvedQuestions.some(({ blocking }) => blocking) ? <p className="state" data-state="refuted">{value.unresolvedQuestions.filter(({ blocking }) => blocking).length} blocking open questions</p> : null}
      {critique.value !== null && critique.value.items.some(({ blocking }) => blocking) ? <p className="state" data-state="refuted">{critique.value.items.filter(({ blocking }) => blocking).length} blocking critic objections</p> : null}
      <p className="state" data-state={value.premiseReport.status === "positive" ? "verified" : value.premiseReport.status === "negative" ? "refuted" : "unexamined"}>premise · {value.premiseReport.interpretation}</p>
      <p><TabLink runId={runId} tab="plan">open the plan</TabLink></p>
    </>}
  </section>;
}

function FeatureSummary({ runId, run, artifacts, refreshKey }: { readonly runId: string; readonly run: RunResource | null; readonly artifacts: readonly ArtifactDescriptor[]; readonly refreshKey: unknown }): ReactElement {
  const apis = useApis();
  const contract = useLoaded(`requirements:${runId}`, () => apis.requirements.current(runId), refreshKey);
  const outcome = artifacts.find(({ kind }) => kind === "feature-outcome");
  const handoff = artifacts.find(({ kind }) => kind === "implementation");
  return <section aria-labelledby="feature-summary-title" className="section">
    <h2 className="panel-title" id="feature-summary-title">requirements and handoff</h2>
    {contract.error !== null ? <p className="state" data-state="degraded">requirements unavailable · {contract.error}</p>
      : contract.value === null ? <p className="state" data-state="unexamined">{contract.loading ? "reading the requirements contract" : "no requirements contract recorded yet"}</p>
      : <>
        <p className="prose">{contract.value.contract.featureRequest}</p>
        <p className="data">{contract.value.contract.decision.mode} decisions · {contract.value.contract.ambiguities.length} ambiguities · {contract.value.contract.acceptance.length} acceptance assertions</p>
        {contract.value.pendingAmbiguityIds.length === 0 ? null : <p className="state" data-state="attention">{contract.value.pendingAmbiguityIds.length} proposed defaults wait for your approval</p>}
      </>}
    {outcome === undefined ? <p className="state" data-state="unexamined">no Feature outcome recorded</p> : <FeatureOutcome api={apis.artifacts} runId={runId} artifactId={outcome.artifactId} />}
    <HandoffDownload api={apis.artifacts} runId={runId} handoff={handoff} />
    {run === null ? null : <p><TabLink runId={runId} tab="requirements">open the requirements</TabLink></p>}
  </section>;
}

function TestingSummary({ runId, run, artifacts, refreshKey }: { readonly runId: string; readonly run: RunResource | null; readonly artifacts: readonly ArtifactDescriptor[]; readonly refreshKey: unknown }): ReactElement {
  const apis = useApis();
  const { view, error } = useTestingView(apis.testing, runId, run, refreshKey);
  return <section aria-labelledby="testing-summary-title" className="section operator-view">
    <h2 className="panel-title" id="testing-summary-title">tests</h2>
    {error !== null ? <p className="state" data-state="degraded">Testing view unavailable · {error}</p> : view === null ? <p role="status">reading the Testing result</p> : <>
      <p className="prose">{view.configuration.goal}</p>
      <Planning view={view} />
      {view.configuration.mode === "execute" && !view.noWork ? <Outcome view={view} /> : null}
      <Handoff view={view} api={apis.testing} runId={runId} planHandoff={artifacts.find(({ kind }) => kind === "implementation")} artifactApi={apis.artifacts} />
      <p><TabLink runId={runId} tab="execution">open the execution record</TabLink></p>
    </>}
  </section>;
}

function HowItRan({ overview }: { readonly overview: RunOverview | null }): ReactElement {
  if (overview === null) return <section className="section"><h2 className="panel-title">how it ran</h2><p role="status">reading the run's settings</p></section>;
  const profiles = overview.configuration === null ? [] : modelProfiles(overview.configuration);
  const scope = Object.entries(overview.scope).filter(([key]) => key !== "kind").map(([key, value]) => `${key} ${Array.isArray(value) ? value.join(", ") : String(value)}`).join(" · ");
  return <section aria-labelledby="how-title" className="section">
    <h2 className="panel-title" id="how-title">how it ran</h2>
    <dl className="facts">
      <div><dt>executed by</dt><dd>{executorText(overview)}</dd></div>
      <div><dt>repository</dt><dd>{overview.repository ?? "unavailable"}</dd></div>
      <div><dt>scope</dt><dd>{overview.scope.kind}{scope === "" ? "" : ` · ${scope}`}</dd></div>
      {overview.mode === "audit" ? <>
        <div><dt>peer review</dt><dd>{overview.consensusPolicy.replace("_", "-")} · up to {overview.maximumRounds} {overview.maximumRounds === 1 ? "round" : "rounds"}</dd></div>
        <div><dt>critic</dt><dd>{overview.criticEnabled ? "reviews the plan" : "not in this workflow"}</dd></div>
      </> : null}
      <div><dt>checkpoints</dt><dd>{overview.checkpointMode ?? "none in this workflow"}</dd></div>
      {overview.workflowGraph === null ? null : <div><dt>saved graph</dt><dd>{overview.workflowGraph.id} @ {overview.workflowGraph.version}</dd></div>}
      {overview.replayOf === null ? null : <div><dt>replay of</dt><dd><Link to={{ page: "run", runId: overview.replayOf, tab: null, item: null }}>{overview.replayOf}</Link></dd></div>}
    </dl>
    {profiles.length === 0 ? null : <ModelTable profiles={profiles} />}
    {overview.configuration === null ? null : <details className="disclosure"><summary>stored configuration · JSON</summary><pre className="artifact__content">{JSON.stringify(overview.configuration, null, 2)}</pre></details>}
  </section>;
}

function TabLink({ runId, tab, children }: { readonly runId: string; readonly tab: RunTab; readonly children: string }): ReactElement {
  return <Link className="more-link" to={{ page: "run", runId, tab, item: null }}>{children}</Link>;
}

