import "./run.css";
import "../../views/operator.css";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useArtifacts } from "../../api/artifacts.js";
import { useLoaded, useRehydratedRun } from "../../api/runs.js";
import { useApis } from "../../app/apis.js";
import { modeOfWorkflow } from "../../app/format.js";
import { Link, useNavigation, type RunTab } from "../../app/router.js";
import { ArtifactView } from "../../controls/ArtifactView.js";
import type { WorkflowNode } from "../../graph/GraphView.js";
import { recordedStages } from "../../graph/recorded-stages.js";
import { EvaluationView } from "../../views/evaluation/EvaluationView.js";
import { FeatureView } from "../../views/feature/FeatureView.js";
import { IssueBoardView } from "../../views/issue-board/IssueBoardView.js";
import { IssueDetails } from "../../views/issue-board/IssueDetails.js";
import { PlanView } from "../../views/plan/PlanView.js";
import { TraceDetails } from "../../views/plan/TraceDetails.js";
import { TestingView } from "../../views/testing/TestingView.js";
import { AttemptDetails } from "../../views/traces/TraceView.js";
import { ActivityTab } from "./ActivityTab.js";
import { DecisionBanner } from "./DecisionBanner.js";
import { DetailsPanel } from "./DetailsPanel.js";
import { NodeDetails } from "./NodeDetails.js";
import { OverviewTab } from "./OverviewTab.js";
import { RunHeader } from "./RunHeader.js";
import { parseSelection, selectionItem, type Selection } from "./selection.js";
import { TAB_LABELS, tabsFor } from "./tabs.js";

/**
 * One run: who and what in the header, anything it waits on in the banner, then the tabs its
 * mode has. The tab and the selected item are part of the address; the run's state streams
 * in over its event stream and every stop re-reads its durable record.
 */
export function RunPage({ runId, tab, item }: { readonly runId: string; readonly tab: RunTab | null; readonly item: string | null }): ReactElement {
  const apis = useApis();
  const { navigate } = useNavigation();
  const [version, setVersion] = useState(0);
  const { resource, events, reason, error } = useRehydratedRun(apis.runs, runId, version);
  const state = resource?.state ?? null;
  const overview = useLoaded(`overview:${runId}`, () => apis.runs.overview(runId), `${state ?? ""}:${version}`);
  const artifacts = useArtifacts(apis.artifacts, runId, events.length);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  const mode = overview.value?.mode ?? modeOfWorkflow(resource?.workflow?.id);
  const tabs = tabsFor(mode);
  const known = resource !== null;
  // The header fills in from the overview, so the tab waits for it too: content that rendered
  // first was pushed down when the header grew, and a click aimed at a row landed on
  // whatever moved into its place.
  const settled = known && (overview.value !== null || overview.error !== null);
  const current: RunTab = tab !== null && tabs.includes(tab) ? tab : "overview";
  // A link naming a tab this run's mode does not have (an old link, say) lands on the overview.
  const stray = known && overview.value !== null && tab !== null && !tabs.includes(tab);
  useEffect(() => { if (stray) navigate({ page: "run", runId, tab: null, item: null }, { replace: true }); }, [stray, navigate, runId]);
  const selection = parseSelection(item);
  const select = useCallback((next: Selection | null): void => {
    navigate({ page: "run", runId, tab: current === "overview" ? null : current, item: next === null ? null : selectionItem(next) }, { replace: true });
  }, [navigate, runId, current]);

  if (!known && error !== null) return <section className="surface run-missing">
    <h1 className="page-title">This run could not be opened</h1>
    <p className="state" data-state="degraded" role="alert">{runId} · {error}</p>
    <p><Link to={{ page: "runs" }}>back to all runs</Link></p>
  </section>;

  const refreshKey = events.length;
  const content = !settled ? <p role="status">loading the run</p>
    : current === "overview" ? <OverviewTab runId={runId} mode={mode} run={resource} overview={overview.value} artifacts={artifacts} reason={reason} refreshKey={`${refreshKey}:${version}`} />
    : current === "issues" ? <IssueBoardView api={apis.artifacts} runId={runId} refreshKey={refreshKey} selectedId={selection?.kind === "issue" ? selection.id : null} onSelect={(id) => select({ kind: "issue", id })} />
    : current === "plan" ? <PlanView api={apis.artifacts} runId={runId} refreshKey={refreshKey} selected={selection?.kind === "trace" ? selection : null} onSelect={(level, id) => select({ kind: "trace", level, id })} />
    : current === "requirements" ? <FeatureView api={apis.requirements} artifactApi={apis.artifacts} runId={runId} run={resource} artifacts={artifacts} refreshKey={`${refreshKey}:${version}`} onDecided={refresh} />
    : current === "execution" ? <TestingView api={apis.testing} artifactApi={apis.artifacts} runId={runId} run={resource} artifacts={artifacts} refreshKey={refreshKey} />
    : current === "activity" ? <ActivityTab runId={runId} run={resource} events={events} artifacts={artifacts} overview={overview.value} selection={selection} onSelect={select} />
    : <EvaluationView api={apis.evaluation} runId={runId} />;

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
    <RunHeader runId={runId} mode={mode} resource={resource} overview={overview.value} overviewError={overview.error} reason={reason} streamError={error} onChanged={refresh} />
    <DecisionBanner runId={runId} run={resource} onChanged={refresh} />
    <nav aria-label="run views" className="tabs">{tabs.map((key) => <Link aria-current={key === current ? "page" : undefined} key={key} to={{ page: "run", runId, tab: key === "overview" ? null : key, item: null }}>{TAB_LABELS[key]}</Link>)}</nav>
    <div className="run-body" data-details={details !== null}>
      <div className="run-main">{content}</div>
      {details}
    </div>
  </div>;
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
