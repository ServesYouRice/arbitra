import { useEffect, useMemo, useState, type ReactElement } from "react";
import { ArtifactApi, useArtifacts } from "../api/artifacts.js";
import { ConfigurationApi, useConfigurations } from "../api/configurations.js";
import { RunApi, useRehydratedRun } from "../api/runs.js";
import { GraphView } from "../columns/graph/GraphView.js";
import type { WorkflowJson } from "../columns/graph/layout.js";
import { InspectorView } from "../columns/inspector/InspectorView.js";
import { inspectorSelectionFor, type WorkflowNode } from "../columns/inspector/selection.js";
import type { ModelCardData } from "../columns/model-pool/model.js";
import { usePersistedPrompt } from "../columns/prompt/persisted.js";
import { PromptView, type PromptSelection } from "../columns/prompt/PromptView.js";
import { ConfigurationWorkspace } from "../configuration/ConfigurationWorkspace.js";
import { ArtifactView } from "../controls/ArtifactView.js";
import { InspectorOverlay, RunControls } from "../controls/RunControls.js";
import { EvaluationApi } from "../views/evaluation/api.js";
import { EvaluationView } from "../views/evaluation/EvaluationView.js";
import { IssueBoardView } from "../views/issue-board/IssueBoardView.js";
import { PlanView } from "../views/plan/PlanView.js";
import { AppShell } from "./AppShell.js";
export const INSPECTOR_OVERLAY_QUERY = "(max-width: 1180px)";
/** Column two is the only fluid column, so the run-level views share it with the graph. */
export const WORKSPACE_VIEWS = Object.freeze({ graph: "workflow graph", issues: "issue board", plan: "plan", evaluation: "evaluation" });
export type WorkspaceView = keyof typeof WORKSPACE_VIEWS;
export interface ArbitraWorkspaceProps { readonly api?: ConfigurationApi; readonly runApi?: RunApi; readonly artifactApi?: ArtifactApi; readonly evaluationApi?: EvaluationApi; readonly runId: string | null; readonly workflow: WorkflowJson; readonly models: readonly ModelCardData[]; readonly defaultConfiguration: Record<string, unknown>; readonly configurationId?: string | null; readonly repository?: string | null; readonly initialView?: WorkspaceView }
export function ArbitraWorkspace({ api, runApi, artifactApi, evaluationApi, runId, workflow, models, defaultConfiguration, configurationId = null, repository = null, initialView = "graph" }: ArbitraWorkspaceProps): ReactElement {
  const configurationApi = useMemo(() => api ?? new ConfigurationApi(), [api]); const lifecycleApi = useMemo(() => runApi ?? new RunApi(), [runApi]); const artifactStore = useMemo(() => artifactApi ?? new ArtifactApi(), [artifactApi]); const metricsApi = useMemo(() => evaluationApi ?? new EvaluationApi(), [evaluationApi]);
  const { resource, events, error } = useRehydratedRun(lifecycleApi, runId);
  const { configurations } = useConfigurations(configurationApi);
  const artifacts = useArtifacts(artifactStore, runId);
  const [assignments, setAssignments] = useState<Readonly<Record<string, string>>>({});
  const [node, setNode] = useState<WorkflowNode | null>(null);
  const [artifactId, setArtifactId] = useState<string | null>(null);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [view, setView] = useState<WorkspaceView>(initialView);
  const [finding, setFinding] = useState<string | null>(null);
  const overlay = useMediaQuery(INSPECTOR_OVERLAY_QUERY);
  const model = useMemo(() => models.find(({ alias }) => alias === (node === null ? undefined : assignments[node.id])) ?? null, [models, assignments, node]);
  const prompt = usePersistedPrompt(artifactStore, runId, node?.kind === "model" ? node.id : null);
  const promptSelection: PromptSelection = node === null || node.kind === "model" ? { kind: "model", artifact: node === null ? null : prompt } : { kind: "deterministic", nodeId: node.id, transformation: node.config ?? {} };
  const runConfigurationId = configurationId ?? configurations[0]?.id ?? null;
  const graph = <>
    <nav aria-label="workspace views" className="view-tabs">{(Object.keys(WORKSPACE_VIEWS) as WorkspaceView[]).map((key) => <button aria-current={view === key ? "page" : undefined} key={key} type="button" onClick={() => setView(key)}>{WORKSPACE_VIEWS[key]}</button>)}</nav>
    {view === "graph" ? <GraphView workflowJson={workflow} runEvents={events} modelAliases={models.map(({ alias }) => alias)} assignments={assignments} onAssign={(nodeId, alias) => setAssignments((current) => ({ ...current, [nodeId]: alias }))} onSelect={setNode} />
      : view === "issues" ? <IssueBoardView api={artifactStore} runId={runId} selectedFindingId={finding} onSelectFinding={setFinding} />
      : view === "plan" ? <PlanView api={artifactStore} runId={runId} />
      : <EvaluationView api={metricsApi} runId={runId} />}
  </>;
  const contract = <><ConfigurationWorkspace api={configurationApi} defaults={defaultConfiguration} /><PromptView selection={promptSelection} /></>;
  const inspector = <>
    <InspectorView selection={inspectorSelectionFor({ node, model, configuration: defaultConfiguration, run: resource, repository })} />
    {runConfigurationId === null ? <p className="state" data-state="unexamined">run controls unavailable · no saved configuration</p> : <RunControls api={lifecycleApi} configurationId={runConfigurationId} initialRunId={runId} />}
    {error === null ? null : <p className="state" data-state="degraded" role="alert">run stream unavailable · {error}</p>}
    <section aria-labelledby="artifacts-title"><h2 className="panel-title" id="artifacts-title">persisted artifacts</h2>{artifacts.length === 0 ? <p className="state" data-state="unexamined">no persisted artifacts</p> : <ul>{artifacts.map(({ artifactId: id, kind }) => <li key={id}><button type="button" onClick={() => setArtifactId(id)}>{kind} · {id}</button></li>)}</ul>}{artifactId === null || runId === null ? null : <ArtifactView api={artifactStore} runId={runId} artifactId={artifactId} />}</section>
  </>;
  return <AppShell models={models} graph={graph} contract={contract} inspector={overlay ? <><button type="button" onClick={() => setOverlayOpen(true)}>open inspector</button><InspectorOverlay open={overlayOpen} title="run inspector" onDismiss={() => setOverlayOpen(false)}>{inspector}</InspectorOverlay></> : inspector} />;
}
export function useMediaQuery(query: string): boolean { const [matches, setMatches] = useState(false); useEffect(() => { if (typeof window === "undefined" || typeof window.matchMedia !== "function") return; const list = window.matchMedia(query); setMatches(list.matches); const onChange = (event: MediaQueryListEvent): void => setMatches(event.matches); list.addEventListener("change", onChange); return () => list.removeEventListener("change", onChange); }, [query]); return matches; }
