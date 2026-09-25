import "@xyflow/react/dist/style.css";
import "./graph.css";
import { NODE_GLYPHS, STATE_LABELS, type NodeKind, type RunState } from "@arbitra/schemas/glyphs";
import { Background, Controls, ReactFlow, type Edge, type Node, type ReactFlowInstance } from "@xyflow/react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import type { RunEvent } from "../../api/sse.js";
import type { GraphVersionRecord, WorkflowApi } from "../../api/workflows.js";
import { UnsavedChangesDialog } from "../../controls/UnsavedChangesDialog.js";
import { layoutWorkflow, type WorkflowJson } from "./layout.js";
import { expandWorkflow, isRecordedStage, recordedStages } from "./recorded-stages.js";
const NO_ARTIFACTS: readonly { readonly kind: string }[] = Object.freeze([]);
// The editor is its own chunk: a read-only run view never loads it.
const GraphEditor = lazy(async () => ({ default: (await import("./GraphEditor.js")).GraphEditor }));
/** Edit mode: operator-authored graphs are validated and saved as versions by the server. */
export interface GraphEditing { readonly api: WorkflowApi; readonly configurationId: string | null; readonly preferredSource?: string | null; readonly onDirtyChange?: (dirty: boolean) => void; readonly onSaved?: (record: GraphVersionRecord) => void }
/** The saved graph a run executes and the content version of what it actually ran. */
export interface ExecutedGraphIdentity { readonly id: string; readonly version: string; readonly executedVersion: string }
interface GraphViewProps { readonly workflowJson: WorkflowJson; readonly runEvents: readonly RunEvent[]; readonly modelAliases: readonly string[]; readonly assignments: Readonly<Record<string, string>>; readonly onAssign: (nodeId: string, alias: string) => void; readonly onSelect?: (node: WorkflowJson["nodes"][number] | null) => void; /** Recorded run artifacts; Feature/Testing subgraphs expand into the stages these record. */ readonly artifacts?: readonly { readonly kind: string }[]; readonly editing?: GraphEditing; readonly identity?: ExecutedGraphIdentity }
interface GraphNodeData extends Record<string, unknown> { readonly label: string; readonly kind: NodeKind; readonly semanticState: RunState | null; readonly runtimeStatus: "not_started" | "running" | "completed" | "failed" | "replayed" | "recorded"; readonly activity: string; readonly assignment: string | null; readonly retries: number }
export function GraphView(props: GraphViewProps): ReactElement {
  const { editing, identity } = props;
  const [mode, setMode] = useState<"run" | "edit">("run");
  const [dirty, setDirty] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const { onDirtyChange } = editing ?? {};
  const dirtyChanged = useCallback((value: boolean): void => { setDirty(value); onDirtyChange?.(value); }, [onDirtyChange]);
  const toRunView = (): void => { if (dirty) setLeaving(true); else setMode("run"); };
  const toggle = editing === undefined ? null : <div aria-label="graph mode" className="graph-mode" role="group">
    <button aria-pressed={mode === "run"} type="button" onClick={toRunView}>run view · read only</button>
    <button aria-pressed={mode === "edit"} type="button" onClick={() => setMode("edit")}>edit graph</button>
  </div>;
  if (mode === "edit" && editing !== undefined) {
    return <>{toggle}
      <Suspense fallback={<p className="state" data-state="unexamined">loading editor</p>}><GraphEditor api={editing.api} configurationId={editing.configurationId} preferredSource={editing.preferredSource ?? (identity === undefined ? null : `saved:${identity.id}:${identity.version}`)} onDirtyChange={dirtyChanged} {...(editing.onSaved === undefined ? {} : { onSaved: editing.onSaved })} /></Suspense>
      <UnsavedChangesDialog open={leaving} action="Returning to the read-only run view" onKeep={() => setLeaving(false)} onDiscard={() => { setLeaving(false); dirtyChanged(false); setMode("run"); }} />
    </>;
  }
  return <>{toggle}<RunGraphView {...props} /></>;
}

function RunGraphView({ workflowJson: sourceWorkflow, runEvents, modelAliases, assignments, onAssign, onSelect, artifacts = NO_ARTIFACTS, identity }: GraphViewProps): ReactElement {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const stages = useMemo(() => recordedStages(sourceWorkflow, artifacts), [sourceWorkflow, artifacts]);
  const workflowJson = useMemo(() => expandWorkflow(sourceWorkflow, stages, expanded), [sourceWorkflow, stages, expanded]);
  const toggle = (id: string): void => setExpanded((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const [positions, setPositions] = useState<ReadonlyMap<string, { x: number; y: number }>>(new Map()); const [selected, setSelected] = useState<string | null>(null); const [flow, setFlow] = useState<ReactFlowInstance<Node<GraphNodeData>, Edge> | null>(null);
  useEffect(() => { let active = true; void layoutWorkflow(workflowJson).then((layout) => { if (active) setPositions(new Map(layout.map(({ id, x, y }) => [id, { x, y }]))); }); return () => { active = false; }; }, [workflowJson]);
  // `fitView` on the ReactFlow element only fits the graph present on the first render, and
  // that one is every node stacked at the origin: elkjs loads on demand and its layout
  // resolves a tick later. Fitting a zero-extent graph clamps to maxZoom, which left seven
  // of the eight audit-deep nodes outside the canvas with nothing to indicate they existed.
  // Re-fit when the real positions arrive, a frame later so React Flow has measured them.
  useEffect(() => { if (flow === null || positions.size === 0) return; const frame = requestAnimationFrame(() => { void flow.fitView({ padding: 0.12 }); }); return () => { cancelAnimationFrame(frame); }; }, [flow, positions]);
  const live = useMemo(() => projectLiveState(workflowJson, runEvents, assignments), [workflowJson, runEvents, assignments]);
  const nodes: Node<GraphNodeData>[] = workflowJson.nodes.map((item) => ({ id: item.id, position: positions.get(item.id) ?? { x: 0, y: 0 }, data: requiredNodeData(live, item.id), type: "default", draggable: false, selectable: true, ariaLabel: `${item.kind} node ${item.label}` }));
  // The canvas label carries the node's glyph: the six-kind taxonomy is the icon set.
  const canvasNodes: Node<GraphNodeData>[] = nodes.map((node) => ({ ...node, data: { ...node.data, label: `${NODE_GLYPHS[node.data.kind].glyph} ${node.data.label}` } }));
  const edges: Edge[] = workflowJson.edges.map(({ id, from, to }) => ({ id, source: from, target: to, animated: live.get(from)?.runtimeStatus === "running" }));
  const selectedNode = workflowJson.nodes.find(({ id }) => id === selected);
  const select = (id: string): void => { setSelected(id); onSelect?.(workflowJson.nodes.find((item) => item.id === id) ?? null); };
  return <section className="graph-region" aria-labelledby="graph-title"><h2 className="panel-title" id="graph-title">workflow graph · read only{identity === undefined ? "" : ` · saved graph ${identity.id}`}</h2>
    {identity === undefined ? null : <p aria-label="executed graph identity" className="state" data-state={identity.version === identity.executedVersion ? "verified" : "refuted"}>executes {identity.id} @ {identity.version} · {identity.version === identity.executedVersion ? "executed graph matches the saved version" : `executed graph differs: ${identity.executedVersion}`}</p>}<div className="graph-canvas"><ReactFlow nodes={canvasNodes} edges={edges} fitView minZoom={0.1} nodesDraggable={false} nodesConnectable={false} onInit={setFlow} onNodeClick={(_, item) => select(item.id)}><Background /><Controls showInteractive={false} /></ReactFlow></div>
    <ol aria-label="live run stages" className="run-stages">{nodes.map(({ id, data }) => {
      const recorded = stages.get(id);
      const parent = workflowJson.nodes.find((item) => item.id === id)?.config?.["parentId"];
      const firstOfParent = typeof parent === "string" && stages.get(parent)?.[0]?.id === id;
      return <li className={data.semanticState === null ? "run-stage" : "run-stage state"} data-state={data.semanticState ?? undefined} data-runtime={data.runtimeStatus} data-stage-of={typeof parent === "string" ? parent : undefined} key={id}>
        <button aria-pressed={selected === id} className="run-stage__select" type="button" onClick={() => select(id)}><span aria-hidden="true" style={{ color: `var(${NODE_GLYPHS[data.kind].token})` }}>{NODE_GLYPHS[data.kind].glyph}</span> <span className="visually-hidden">{data.kind} · </span>{data.label}</button> · {data.semanticState === null ? data.runtimeStatus.replace("_", " ") : STATE_LABELS[data.semanticState]} · {data.activity}{data.assignment === null ? "" : ` · ${data.assignment}`}{data.retries === 0 ? "" : ` · retry ${data.retries}`}
        {recorded === undefined ? null : <> · <button aria-expanded={false} type="button" onClick={() => toggle(id)}>expand {data.label} · {recorded.length} recorded stages</button></>}
        {firstOfParent ? <> · <button aria-expanded={true} type="button" onClick={() => toggle(parent)}>collapse {parent} stages</button></> : null}
      </li>;
    })}</ol>
    {selectedNode?.kind !== "model" || isRecordedStage(selectedNode) ? null : <label>model assignment<select aria-label="model assignment" value={assignments[selectedNode.id] ?? ""} onChange={(event) => onAssign(selectedNode.id, event.target.value)}><option value="">unassigned</option>{modelAliases.map((alias) => <option key={alias}>{alias}</option>)}</select></label>}
  </section>;
}
export function projectLiveState(workflow: WorkflowJson, events: readonly RunEvent[], assignments: Readonly<Record<string, string>>): ReadonlyMap<string, GraphNodeData> {
  const result = new Map<string, GraphNodeData>();
  for (const node of workflow.nodes) {
    const artifactKinds = node.config?.["artifactKinds"];
    result.set(node.id, isRecordedStage(node)
      // A recorded stage is known only by the artifacts it wrote; runtime events belong to its subgraph.
      ? { label: node.label, kind: node.kind, semanticState: null, runtimeStatus: "recorded", activity: `${Array.isArray(artifactKinds) ? artifactKinds.length : 0} recorded artifact kinds`, assignment: null, retries: 0 }
      : { label: node.label, kind: node.kind, semanticState: "unexamined", runtimeStatus: "not_started", activity: "not started", assignment: assignments[node.id] ?? null, retries: 0 });
  }
  for (const event of events) {
    if (event.nodeId === undefined) continue;
    const current = result.get(event.nodeId);
    if (current === undefined) continue;
    const semanticState = isRunState(event.semanticState) ? event.semanticState : null;
    if (event.t === "node_dispatched") result.set(event.nodeId, { ...current, semanticState, runtimeStatus: "running", activity: event.activityId ?? "active", retries: event.attempt ?? current.retries });
    if (event.t === "node_completed") result.set(event.nodeId, { ...current, semanticState, runtimeStatus: event.replayed === true ? "replayed" : "completed", activity: event.replayed === true ? "replayed artifact" : "completed", retries: event.attempt ?? current.retries });
    if (event.t === "node_failed") result.set(event.nodeId, { ...current, semanticState, runtimeStatus: "failed", activity: event.reason ?? "failed", retries: event.attempt ?? current.retries });
  }
  return result;
}
function requiredNodeData(values: ReadonlyMap<string, GraphNodeData>, id: string): GraphNodeData {
  const value = values.get(id);
  if (value === undefined) throw new Error(`GRAPH_NODE_STATE_MISSING:${id}`);
  return value;
}
function isRunState(value: string | undefined): value is RunState { return value !== undefined && ["verified", "dissent", "refuted", "tainted", "unexamined", "degraded"].includes(value); }
