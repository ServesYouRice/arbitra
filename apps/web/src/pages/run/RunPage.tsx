import "./run.css";
import "../../views/operator.css";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useArtifactListing } from "../../api/artifacts.js";
import { useLoaded, useProgress, useRehydratedRun } from "../../api/runs.js";
import { useApis } from "../../app/apis.js";
import { basename, isActive, modeOfWorkflow } from "../../app/format.js";
import { Link, useNavigation, type RunTab } from "../../app/router.js";
import { ArtifactView } from "../../controls/ArtifactView.js";
import { ViewBoundary } from "../../controls/ViewBoundary.js";
import type { WorkflowNode } from "../../graph/GraphView.js";
import { recordedStages } from "../../graph/recorded-stages.js";
import { EvaluationView } from "../../views/evaluation/EvaluationView.js";
import { FeatureView } from "../../views/feature/FeatureView.js";
import { IssueBoardView } from "../../views/issue-board/IssueBoardView.js";
import { IssueDetails } from "../../views/issue-board/IssueDetails.js";
import { RUN_ARTIFACT_KINDS, useRunArtifact } from "../../views/issue-board/run-artifacts.js";
import { PlanView } from "../../views/plan/PlanView.js";
import { TraceDetails } from "../../views/plan/TraceDetails.js";
import { TestingView } from "../../views/testing/TestingView.js";
import { AttemptDetails } from "../../views/traces/TraceView.js";
import { ActivityTab } from "./ActivityTab.js";
import { DecisionBanner } from "./DecisionBanner.js";
import { DetailsPanel } from "./DetailsPanel.js";
import type { PreflightRecord } from "./facts.js";
import { HowItRanTab } from "./HowItRanTab.js";
import { NodeDetails } from "./NodeDetails.js";
import { useNoticeOnStop } from "./notify.js";
import { ResultsTab } from "./ResultsTab.js";
import { RunHeader } from "./RunHeader.js";
import { parseSelection, selectionItem, type Selection } from "./selection.js";
import { SummaryTab } from "./SummaryTab.js";
import { placesFor, RECORD_TABS, TAB_LABELS, tabsFor } from "./tabs.js";

/**
 * One run: what and where in the header, anything it waits on in the banner, then its tabs. Summary leads; the
 * records (Activity, Evaluation) are one click down from How it ran. The tab and the selected item are part of the
 * address; the run's state streams in over its event stream, every stop re-reads its durable record, and while this
 * arbitra executes the run its progress is read again every few seconds.
 */
export function RunPage({ runId, tab, item }: { readonly runId: string; readonly tab: RunTab | null; readonly item: string | null }): ReactElement {
  const apis = useApis();
  const { navigate } = useNavigation();
  const [version, setVersion] = useState(0);
  const { resource, events, reason, error } = useRehydratedRun(apis.runs, runId, version);
  const state = resource?.state ?? null;
  const overview = useLoaded(`overview:${runId}`, () => apis.runs.overview(runId), `${state ?? ""}:${version}`);
  const listing = useArtifactListing(apis.artifacts, runId, events.length);
  const artifacts = listing.artifacts;
  const working = isActive(state ?? overview.value?.state ?? null);
  const progress = useProgress(apis.runs, runId, `${events.length}:${state ?? ""}:${version}`, working && overview.value?.live === true);
  const preflight = useRunArtifact<PreflightRecord>(apis.artifacts, artifacts.some(({ kind }) => kind === "preflight") ? runId : null, "preflight", events.length).value;
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  const mode = overview.value?.mode ?? modeOfWorkflow(resource?.workflow?.id);
  const tabs = tabsFor(mode);
  const places = placesFor(mode);
  const known = resource !== null;
  useNoticeOnStop(state, overview.value?.repository == null ? runId : basename(overview.value.repository));
  // The header fills in from the overview, so the tab waits for it too: content that rendered
  // first was pushed down when the header grew, and a click aimed at a row landed on
  // whatever moved into its place.
  const settled = known && (overview.value !== null || overview.error !== null);
  const current: RunTab = tab !== null && places.includes(tab) ? tab : "summary";
  // A link naming a tab this run's mode does not have (an old link, say) lands on the Summary.
  const stray = known && overview.value !== null && tab !== null && !places.includes(tab);
  useEffect(() => { if (stray) navigate({ page: "run", runId, tab: null, item: null }, { replace: true }); }, [stray, navigate, runId]);
  const selection = parseSelection(item);
  const select = useCallback((next: Selection | null): void => {
    navigate({ page: "run", runId, tab: current === "summary" ? null : current, item: next === null ? null : selectionItem(next) }, { replace: true });
  }, [navigate, runId, current]);
  const selectNode = useCallback((id: string) => select({ kind: "node", id }), [select]);

  if (!known && error !== null) return <section className="surface run-missing">
    <h1 className="page-title">This run could not be opened</h1>
    <p className="prose">{/RUN_ABSENT|_404\b/u.test(error) ? "No run with this ID is recorded by this arbitra. It may have been started by another copy of arbitra, or its folder was removed." : "arbitra could not read this run's records just now. Reload the page to try again."}</p>
    <details className="disclosure"><summary>Details</summary><p className="data">{runId} · {error}</p></details>
    <p><Link to={{ page: "runs" }}>Back to all runs</Link></p>
  </section>;

  const refreshKey = events.length;
  const has = (kind: string): boolean => artifacts.some((artifact) => artifact.kind === kind);
  const selectedNode = selection?.kind === "node" ? selection.id : null;
  const content = !settled ? <p role="status">loading the run</p>
    : current === "summary" ? <SummaryTab runId={runId} mode={mode} run={resource} overview={overview.value} artifacts={artifacts} progress={progress} events={events} reason={reason} refreshKey={`${refreshKey}:${version}`} selectedNode={selectedNode} onSelectNode={selectNode} />
    : current === "issues" ? listing.loaded && !has(RUN_ARTIFACT_KINDS.canonicalIssues) ? <NotYet runId={runId} state={state ?? overview.value?.state ?? null} what="issues" />
      : <IssueBoardView api={apis.artifacts} runId={runId} refreshKey={refreshKey} selectedId={selection?.kind === "issue" ? selection.id : null} onSelect={(id) => select({ kind: "issue", id })} />
    : current === "plan" ? listing.loaded && !has(RUN_ARTIFACT_KINDS.plan) ? <NotYet runId={runId} state={state ?? overview.value?.state ?? null} what="plan" />
      : <PlanView api={apis.artifacts} runId={runId} refreshKey={refreshKey} selected={selection?.kind === "trace" ? selection : null} onSelect={(level, id) => select({ kind: "trace", level, id })} />
    : current === "results" ? <ResultsTab runId={runId} planned={has(RUN_ARTIFACT_KINDS.plan)} />
    : current === "how-it-ran" ? <HowItRanTab runId={runId} mode={mode} run={resource} overview={overview.value} progress={progress} events={events} artifacts={artifacts} refreshKey={`${refreshKey}:${version}`} selectedNode={selectedNode} onSelectNode={selectNode} />
    : current === "requirements" ? <FeatureView api={apis.requirements} artifactApi={apis.artifacts} runId={runId} run={resource} artifacts={artifacts} refreshKey={`${refreshKey}:${version}`} onDecided={refresh} />
    : current === "execution" ? <TestingView api={apis.testing} artifactApi={apis.artifacts} runId={runId} run={resource} artifacts={artifacts} refreshKey={refreshKey} />
    : <Records runId={runId} current={current}>{current === "activity" ? <ActivityTab runId={runId} run={resource} events={events} artifacts={artifacts} overview={overview.value} selection={selection} onSelect={select} /> : <EvaluationView api={apis.evaluation} runId={runId} />}</Records>;

  const details = selection === null || !settled ? null : (() => {
    const close = (): void => select(null);
    if (selection.kind === "node") {
      const node = findNode(resource, artifacts, selection.id);
      return <DetailsPanel title={node === null ? `node ${selection.id}` : node.label} onClose={close}>
        {node === null ? <p className="state" data-state="unexamined">node {selection.id} is not in this run's graph</p> : <NodeDetails key={node.id} runId={runId} node={node} overview={overview.value} events={events} artifacts={artifacts} onSelect={select} />}
      </DetailsPanel>;
    }
    if (selection.kind === "issue") return <DetailsPanel title={`issue ${selection.id}`} onClose={close}><IssueDetails key={selection.id} api={apis.artifacts} runId={runId} candidateId={selection.id} refreshKey={refreshKey} /></DetailsPanel>;
    if (selection.kind === "trace") return <DetailsPanel title={`${selection.level} ${selection.id}`} onClose={close}><TraceDetails api={apis.artifacts} runId={runId} level={selection.level} id={selection.id} refreshKey={refreshKey} onSelect={(level, id) => select({ kind: "trace", level, id })} /></DetailsPanel>;
    if (selection.kind === "attempt") return <DetailsPanel title={`model attempt ${selection.id}`} onClose={close}><AttemptDetails key={selection.id} api={apis.traces} runId={runId} traceId={selection.id} /></DetailsPanel>;
    return <DetailsPanel title="artifact" onClose={close}><ArtifactView key={selection.id} api={apis.artifacts} runId={runId} artifactId={selection.id} /></DetailsPanel>;
  })();

  return <div className="run-page">
    <RunHeader runId={runId} mode={mode} resource={resource} overview={overview.value} overviewError={overview.error} reason={reason} streamError={error}
      files={typeof preflight?.fileCount === "number" ? { files: preflight.fileCount, lines: typeof preflight.lineCount === "number" ? preflight.lineCount : null } : null} onChanged={refresh} />
    <DecisionBanner runId={runId} run={resource} onChanged={refresh} />
    <nav aria-label="run views" className="tabs">{tabs.map((key) => <Link aria-current={key === current || key === "how-it-ran" && RECORD_TABS.includes(current) ? "page" : undefined} key={key} to={{ page: "run", runId, tab: key === "summary" ? null : key, item: null }}>{TAB_LABELS[key]}</Link>)}</nav>
    <div className="run-body" data-details={details !== null}>
      <div className="run-main"><ViewBoundary resetKey={current} label={`the ${TAB_LABELS[current]} tab`}>{content}</ViewBoundary></div>
      {details}
    </div>
  </div>;
}

/** The run's records, one click down from How it ran. */
function Records({ runId, current, children }: { readonly runId: string; readonly current: RunTab; readonly children: ReactElement }): ReactElement {
  return <div className="records">
    <nav aria-label="records" className="records-nav">
      <Link to={{ page: "run", runId, tab: "how-it-ran", item: null }}>← How it ran</Link>
      <span className="panel-title">Records</span>
      {RECORD_TABS.map((key) => <Link aria-current={key === current ? "page" : undefined} key={key} to={{ page: "run", runId, tab: key, item: null }}>{TAB_LABELS[key]}</Link>)}
    </nav>
    {children}
  </div>;
}

/** What a tab will hold and when, before the run has recorded it. */
function NotYet({ runId, state, what }: { readonly runId: string; readonly state: string | null; readonly what: "issues" | "plan" }): ReactElement {
  const summary = <Link to={{ page: "run", runId, tab: null, item: null }}>Summary</Link>;
  const working = isActive(state);
  if (what === "issues") return <section aria-label="issues" className="not-yet">
    <h2 className="panel-title">Issues</h2>
    <p className="prose">{working ? <>No issue is checked yet. The issues appear here once the run has merged duplicates and checked each one; what it has found so far is on the {summary}.</>
      : state === "COMPLETED" ? <>This run recorded no issues to list.</>
      : <>This run stopped before it checked any issue, so it has none to list. What it found before it stopped is on the {summary}.</>}</p>
  </section>;
  return <section aria-label="plan" className="not-yet">
    <h2 className="panel-title">Plan</h2>
    <p className="prose">{working ? <>No plan yet. The run writes it once every issue is checked; the {summary} shows how far it has got.</>
      : state === "COMPLETED" ? <>This run wrote no plan: it found no issue that needs one.</>
      : <>This run stopped before it wrote a plan. The {summary} says why and what to do.</>}</p>
  </section>;
}

/** A graph node, or a recorded Feature/Testing stage that exists only once its artifacts do. */
function findNode(run: { readonly workflow?: { readonly id: string; readonly nodes: readonly WorkflowNode[]; readonly edges: readonly { readonly id: string; readonly from: string; readonly to: string }[] } } | null, artifacts: readonly { readonly kind: string }[], id: string): WorkflowNode | null {
  const workflow = run?.workflow;
  if (workflow === undefined) return null;
  const node = workflow.nodes.find((candidate) => candidate.id === id);
  if (node !== undefined) return node;
  for (const stages of recordedStages(workflow, artifacts).values()) {
    const stage = stages.find((candidate) => candidate.id === id);
    if (stage !== undefined) return { id: stage.id, kind: stage.kind, label: stage.label, config: { recordedStage: true, parentId: stage.parentId, artifactKinds: [...stage.artifactKinds] } };
  }
  return null;
}
