import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { ArtifactApi, useArtifacts } from "../api/artifacts.js";
import { ConfigurationApi, useConfigurations, type StoredConfiguration } from "../api/configurations.js";
import { RunApi, useRehydratedRun, type RunResource } from "../api/runs.js";
import type { WorkflowJson } from "../columns/graph/layout.js";
import { PRESET_WORKFLOWS } from "../columns/graph/presets.js";
import { InspectorView } from "../columns/inspector/InspectorView.js";
import { inspectorSelectionFor, type WorkflowNode } from "../columns/inspector/selection.js";
import type { ModelCardData } from "../columns/model-pool/model.js";
import { usePersistedPrompt } from "../columns/prompt/persisted.js";
import { PromptView, type PromptSelection } from "../columns/prompt/PromptView.js";
import { ConfigurationWorkspace } from "../configuration/ConfigurationWorkspace.js";
import { ArtifactView } from "../controls/ArtifactView.js";
import { InspectorOverlay, RunControls } from "../controls/RunControls.js";
import { EvaluationApi } from "../views/evaluation/api.js";
import { RequirementsApi, TestingApi } from "../api/operator.js";
import { AppShell } from "./AppShell.js";
// Column two shows one view at a time, so each is its own chunk. This keeps React Flow and
// the per-view code out of the entry chunk, and a deep link to a non-graph view never pays
// for the graph renderer. elkjs stays lazy behind the graph chunk (see graph/layout.ts).
const GraphView = lazy(async () => ({ default: (await import("../columns/graph/GraphView.js")).GraphView }));
const IssueBoardView = lazy(async () => ({ default: (await import("../views/issue-board/IssueBoardView.js")).IssueBoardView }));
const PlanView = lazy(async () => ({ default: (await import("../views/plan/PlanView.js")).PlanView }));
const EvaluationView = lazy(async () => ({ default: (await import("../views/evaluation/EvaluationView.js")).EvaluationView }));
const TraceView = lazy(async () => ({ default: (await import("../views/traces/TraceView.js")).TraceView }));
const FeatureView = lazy(async () => ({ default: (await import("../views/feature/FeatureView.js")).FeatureView }));
const TestingView = lazy(async () => ({ default: (await import("../views/testing/TestingView.js")).TestingView }));
export const INSPECTOR_OVERLAY_QUERY = "(max-width: 1180px)";
/** Column two is the only fluid column, so the run-level views share it with the graph. */
export const WORKSPACE_VIEWS = Object.freeze({ graph: "workflow graph", issues: "issue board", plan: "plan", feature: "feature contract", testing: "testing execution", evaluation: "evaluation", traces: "traces" });
export type WorkspaceView = keyof typeof WORKSPACE_VIEWS;
export interface ArbitraWorkspaceProps { readonly api?: ConfigurationApi; readonly runApi?: RunApi; readonly artifactApi?: ArtifactApi; readonly evaluationApi?: EvaluationApi; readonly requirementsApi?: RequirementsApi; readonly testingApi?: TestingApi; readonly runId: string | null; readonly workflow: WorkflowJson; readonly models: readonly ModelCardData[]; readonly defaultConfiguration: Record<string, unknown>; readonly configurationId?: string | null; readonly repository?: string | null; readonly initialView?: WorkspaceView }
export function ArbitraWorkspace({ api, runApi, artifactApi, evaluationApi, requirementsApi, testingApi, runId, workflow, models, defaultConfiguration, configurationId = null, repository = null, initialView = "graph" }: ArbitraWorkspaceProps): ReactElement {
  const configurationApi = useMemo(() => api ?? new ConfigurationApi(), [api]); const lifecycleApi = useMemo(() => runApi ?? new RunApi(), [runApi]); const artifactStore = useMemo(() => artifactApi ?? new ArtifactApi(), [artifactApi]); const metricsApi = useMemo(() => evaluationApi ?? new EvaluationApi(), [evaluationApi]); const contractApi = useMemo(() => requirementsApi ?? new RequirementsApi(), [requirementsApi]); const executionApi = useMemo(() => testingApi ?? new TestingApi(), [testingApi]);
  const [activeRunId, setActiveRunId] = useState(runId);
  const [runVersion, setRunVersion] = useState(0);
  const [selectedConfiguration, setSelectedConfiguration] = useState<StoredConfiguration<Record<string, unknown>> | null | undefined>(undefined);
  useEffect(() => { setActiveRunId(runId); }, [runId]);
  const runStarted = useCallback((run: RunResource): void => { setActiveRunId(run.runId); setRunVersion((current) => current + 1); }, []);
  const { resource, events, error } = useRehydratedRun(lifecycleApi, activeRunId, runVersion);
  const { configurations } = useConfigurations(configurationApi);
  const artifacts = useArtifacts(artifactStore, activeRunId, events.length);
  const [assignments, setAssignments] = useState<Readonly<Record<string, string>>>({});
  const [node, setNode] = useState<WorkflowNode | null>(null);
  const [artifactId, setArtifactId] = useState<string | null>(null);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [view, setView] = useState<WorkspaceView>(initialView);
  const [finding, setFinding] = useState<string | null>(null);
  const overlay = useMediaQuery(INSPECTOR_OVERLAY_QUERY);
  const model = useMemo(() => models.find(({ alias }) => alias === (node === null ? undefined : assignments[node.id])) ?? null, [models, assignments, node]);
  const prompt = usePersistedPrompt(artifactStore, activeRunId, node?.kind === "model" ? node.id : null);
  const promptSelection: PromptSelection = node === null || node.kind === "model" ? { kind: "model", artifact: node === null ? null : prompt } : { kind: "deterministic", nodeId: node.id, transformation: node.config ?? {} };
  const runConfigurationId = selectedConfiguration === undefined ? configurationId ?? configurations[0]?.id ?? null : selectedConfiguration?.id ?? null;
  const preset = (selectedConfiguration?.config["workflow"] as { preset?: unknown } | undefined)?.preset;
  const selectedWorkflow = typeof preset === "string" && Object.hasOwn(PRESET_WORKFLOWS, preset) ? PRESET_WORKFLOWS[preset as keyof typeof PRESET_WORKFLOWS] : workflow;
  const displayedWorkflow = resource?.workflow ?? selectedWorkflow;
  useEffect(() => { setArtifactId(null); setFinding(null); }, [activeRunId]);
  const graph = <>
    <nav aria-label="workspace views" className="view-tabs">{(Object.keys(WORKSPACE_VIEWS) as WorkspaceView[]).map((key) => <button aria-current={view === key ? "page" : undefined} key={key} type="button" onClick={() => setView(key)}>{WORKSPACE_VIEWS[key]}</button>)}</nav>
    <Suspense fallback={<p className="state" data-state="unexamined">loading view</p>}>
      {view === "graph" ? <GraphView workflowJson={displayedWorkflow} artifacts={artifacts} runEvents={events} modelAliases={models.map(({ alias }) => alias)} assignments={assignments} onAssign={(nodeId, alias) => setAssignments((current) => ({ ...current, [nodeId]: alias }))} onSelect={setNode} />
        : view === "issues" ? <IssueBoardView api={artifactStore} runId={activeRunId} selectedFindingId={finding} onSelectFinding={setFinding} refreshKey={events.length} />
        : view === "plan" ? <PlanView api={artifactStore} runId={activeRunId} refreshKey={events.length} />
        : view === "traces" ? <TraceView runId={activeRunId} refreshKey={events.length} />
        : view === "feature" ? <FeatureView api={contractApi} runApi={lifecycleApi} artifactApi={artifactStore} runId={activeRunId} run={resource} artifacts={artifacts} refreshKey={events.length} onResumed={runStarted} />
        : view === "testing" ? <TestingView api={executionApi} artifactApi={artifactStore} runId={activeRunId} run={resource} artifacts={artifacts} refreshKey={events.length} />
        : <EvaluationView api={metricsApi} runId={activeRunId} />}
    </Suspense>
  </>;
  const contract = <><ConfigurationWorkspace api={configurationApi} defaults={defaultConfiguration} initialConfigurationId={configurationId ?? configurations[0]?.id ?? null} onSelect={setSelectedConfiguration} /><PromptView selection={promptSelection} /></>;
  const inspector = <>
    <InspectorView selection={inspectorSelectionFor({ node, model, configuration: selectedConfiguration?.config ?? defaultConfiguration, run: resource, repository })} />
    {runConfigurationId === null && activeRunId === null ? <p className="state" data-state="unexamined">run controls unavailable · no saved configuration</p> : <RunControls api={lifecycleApi} configurationId={runConfigurationId} initialRunId={activeRunId} initialRepository={repository ?? ""} currentRun={resource} onRunStarted={runStarted} />}
    {error === null ? null : <p className="state" data-state="degraded" role="alert">run stream unavailable · {error}</p>}
    <section aria-labelledby="artifacts-title"><h2 className="panel-title" id="artifacts-title">persisted artifacts</h2>{artifacts.length === 0 ? <p className="state" data-state="unexamined">no persisted artifacts</p> : <ul>{artifacts.map(({ artifactId: id, kind }) => <li key={id}><button type="button" onClick={() => setArtifactId(id)}>{kind} · {id}</button></li>)}</ul>}{artifactId === null || activeRunId === null ? null : <ArtifactView api={artifactStore} runId={activeRunId} artifactId={artifactId} />}</section>
  </>;
  return <AppShell models={models} graph={graph} contract={contract} inspector={overlay ? <><button type="button" onClick={() => setOverlayOpen(true)}>open inspector</button><InspectorOverlay open={overlayOpen} title="run inspector" onDismiss={() => setOverlayOpen(false)}>{inspector}</InspectorOverlay></> : inspector} />;
}
export function useMediaQuery(query: string): boolean { const [matches, setMatches] = useState(false); useEffect(() => { if (typeof window === "undefined" || typeof window.matchMedia !== "function") return; const list = window.matchMedia(query); setMatches(list.matches); const onChange = (event: MediaQueryListEvent): void => setMatches(event.matches); list.addEventListener("change", onChange); return () => list.removeEventListener("change", onChange); }, [query]); return matches; }
