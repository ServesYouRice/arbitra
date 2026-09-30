import "@xyflow/react/dist/style.css";
import "./graph.css";
import { NODE_GLYPHS, STATE_LABELS, type NodeKind, type RunState } from "@arbitra/schemas/glyphs";
import { Background, Controls, ReactFlow, type Edge, type Node, type ReactFlowInstance } from "@xyflow/react";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { RunEvent } from "../api/sse.js";
import { layoutWorkflow, type WorkflowJson } from "./layout.js";
import { expandWorkflow, isRecordedStage, recordedStages } from "./recorded-stages.js";

const NO_ARTIFACTS: readonly { readonly kind: string }[] = Object.freeze([]);
// A small graph fitted without a cap renders its few nodes at several times their size.
const FIT = Object.freeze({ padding: 0.12, maxZoom: 1 });
export type WorkflowNode = WorkflowJson["nodes"][number];
/** The saved graph a run executes and the content version of what it actually ran. */
export interface ExecutedGraphIdentity { readonly id: string; readonly version: string; readonly executedVersion: string }
export const NODE_KIND_LABELS: Readonly<Record<NodeKind, string>> = Object.freeze({ deterministic: "deterministic step", model: "model call", gate: "gate", loop: "bounded loop", human: "human checkpoint", subgraph: "subgraph" });

export interface GraphViewProps {
  readonly workflowJson: WorkflowJson;
  readonly runEvents: readonly RunEvent[];
  /** Recorded run artifacts; Feature/Testing subgraphs expand into the stages these record. */
  readonly artifacts?: readonly { readonly kind: string }[];
  readonly selectedNodeId?: string | null;
  readonly onSelect?: (node: WorkflowNode) => void;
  readonly identity?: ExecutedGraphIdentity;
}
type RuntimeStatus = "not_started" | "running" | "completed" | "failed" | "replayed" | "recorded";
export interface NodeLiveState { readonly label: string; readonly kind: NodeKind; readonly semanticState: RunState | null; readonly runtimeStatus: RuntimeStatus; readonly detail: string | null; readonly retries: number }
interface CanvasNodeData extends Record<string, unknown> { readonly label: string }

/**
 * The graph a run executes, as it ran: the canvas and, beneath it, the same nodes as a
 * keyboard-reachable list with each node's status in words. Selecting either opens the
 * node's details. Feature and Testing subgraphs expand into the stages their run recorded.
 */
export function GraphView({ workflowJson: sourceWorkflow, runEvents, artifacts = NO_ARTIFACTS, selectedNodeId = null, onSelect, identity }: GraphViewProps): ReactElement {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const stages = useMemo(() => recordedStages(sourceWorkflow, artifacts), [sourceWorkflow, artifacts]);
  const workflowJson = useMemo(() => expandWorkflow(sourceWorkflow, stages, expanded), [sourceWorkflow, stages, expanded]);
  const toggle = (id: string): void => setExpanded((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const [positions, setPositions] = useState<ReadonlyMap<string, { x: number; y: number }>>(new Map());
  const [flow, setFlow] = useState<ReactFlowInstance<Node<CanvasNodeData>, Edge> | null>(null);
  useEffect(() => { let active = true; void layoutWorkflow(workflowJson).then((layout) => { if (active) setPositions(new Map(layout.map(({ id, x, y }) => [id, { x, y }]))); }); return () => { active = false; }; }, [workflowJson]);
  // `fitView` on the ReactFlow element only fits the graph present on the first render, and
  // that one is every node stacked at the origin: elkjs loads on demand and its layout
  // resolves a tick later. Re-fit when the real positions arrive, a frame later so React
  // Flow has measured them.
  useEffect(() => { if (flow === null || positions.size === 0) return; const frame = requestAnimationFrame(() => { void flow.fitView(FIT); }); return () => { cancelAnimationFrame(frame); }; }, [flow, positions]);
  // Opening the details panel narrows the canvas; fit again rather than leave nodes off-screen.
  const canvas = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = canvas.current;
    if (flow === null || element === null || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { void flow.fitView(FIT); }); });
    observer.observe(element);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [flow]);
  const live = useMemo(() => projectLiveState(workflowJson, runEvents), [workflowJson, runEvents]);
  const select = (id: string): void => { const node = workflowJson.nodes.find((item) => item.id === id); if (node !== undefined) onSelect?.(node); };
  const canvasNodes: Node<CanvasNodeData>[] = workflowJson.nodes.map((item) => {
    const state = requiredNodeData(live, item.id);
    return { id: item.id, position: positions.get(item.id) ?? { x: 0, y: 0 }, data: { label: `${NODE_GLYPHS[item.kind].glyph} ${item.label}` }, type: "default", draggable: false, selectable: true,
      selected: item.id === selectedNodeId, className: `graph-node graph-node--${state.runtimeStatus}`, ariaLabel: `${NODE_KIND_LABELS[item.kind]} ${item.label} · ${statusText(state)}` };
  });
  const edges: Edge[] = workflowJson.edges.map(({ id, from, to }) => ({ id, source: from, target: to, animated: live.get(from)?.runtimeStatus === "running" }));
  const positioned = positions.size > 0;
  return <section className="graph-region" aria-labelledby="graph-title">
    <h2 className="panel-title" id="graph-title">workflow graph{identity === undefined ? "" : ` · saved graph ${identity.id}`}</h2>
    {identity === undefined ? null : <p aria-label="executed graph identity" className="state" data-state={identity.version === identity.executedVersion ? "verified" : "refuted"}>executes {identity.id} @ {identity.version} · {identity.version === identity.executedVersion ? "executed graph matches the saved version" : `executed graph differs: ${identity.executedVersion}`}</p>}
    <div className="graph-canvas" data-positioned={positioned} ref={canvas}>
      {positioned ? null : <p className="graph-canvas__loading" role="status">laying out the graph</p>}
      <ReactFlow nodes={canvasNodes} edges={edges} fitView minZoom={0.1} nodesDraggable={false} nodesConnectable={false} onInit={setFlow} onNodeClick={(_, item) => select(item.id)}><Background /><Controls showInteractive={false} /></ReactFlow>
    </div>
    <p className="graph-legend" aria-label="node kinds">{(Object.keys(NODE_GLYPHS) as NodeKind[]).map((kind) => <span key={kind}><span aria-hidden="true" style={{ color: `var(${NODE_GLYPHS[kind].token})` }}>{NODE_GLYPHS[kind].glyph}</span> {NODE_KIND_LABELS[kind]}</span>)}</p>
    <ol aria-label="live run stages" className="run-stages">{workflowJson.nodes.map((node) => {
      const data = requiredNodeData(live, node.id);
      const recorded = stages.get(node.id);
      const parent = node.config?.["parentId"];
      const firstOfParent = typeof parent === "string" && stages.get(parent)?.[0]?.id === node.id;
      const tone = data.runtimeStatus === "failed" ? "refuted" : data.semanticState;
      return <li className={tone === null ? "run-stage" : "run-stage state"} data-state={tone ?? undefined} data-runtime={data.runtimeStatus} data-stage-of={typeof parent === "string" ? parent : undefined} data-selected={node.id === selectedNodeId} key={node.id}>
        <button aria-pressed={node.id === selectedNodeId} className="run-stage__select" type="button" onClick={() => select(node.id)}><span aria-hidden="true" style={{ color: `var(${NODE_GLYPHS[data.kind].token})` }}>{NODE_GLYPHS[data.kind].glyph}</span> <span className="visually-hidden">{data.kind} · </span>{data.label}</button>
        <span className="run-stage__status">{statusText(data)}</span>
        {recorded === undefined ? null : <button aria-expanded={false} className="link-button" type="button" onClick={() => toggle(node.id)}>expand {data.label} · {recorded.length} recorded stages</button>}
        {firstOfParent ? <button aria-expanded={true} className="link-button" type="button" onClick={() => toggle(parent)}>collapse {parent} stages</button> : null}
      </li>;
    })}</ol>
  </section>;
}

/** One line of plain status per node: what happened, then the recorded semantic state. */
export function statusText(data: NodeLiveState): string {
  const retry = data.retries > 1 ? ` · attempt ${data.retries}` : "";
  switch (data.runtimeStatus) {
    case "not_started": return "not started";
    case "running": return `running${retry}`;
    case "failed": return `failed${data.detail === null ? "" : ` · ${data.detail}`}${retry}`;
    case "replayed": return "reused from the source run";
    case "recorded": return data.detail ?? "recorded";
    case "completed": return `${data.semanticState === null ? "done" : `done · ${STATE_LABELS[data.semanticState]}`}${retry}`;
  }
}

export function projectLiveState(workflow: WorkflowJson, events: readonly RunEvent[]): ReadonlyMap<string, NodeLiveState> {
  const result = new Map<string, NodeLiveState>();
  for (const node of workflow.nodes) {
    const artifactKinds = node.config?.["artifactKinds"];
    result.set(node.id, isRecordedStage(node)
      // A recorded stage is known only by the artifacts it wrote; runtime events belong to its subgraph.
      ? { label: node.label, kind: node.kind, semanticState: null, runtimeStatus: "recorded", detail: `recorded · ${Array.isArray(artifactKinds) ? artifactKinds.length : 0} artifact kinds`, retries: 0 }
      : { label: node.label, kind: node.kind, semanticState: null, runtimeStatus: "not_started", detail: null, retries: 0 });
  }
  for (const event of events) {
    if (event.nodeId === undefined) continue;
    const current = result.get(event.nodeId);
    if (current === undefined) continue;
    const semanticState = isRunState(event.semanticState) ? event.semanticState : null;
    if (event.t === "node_dispatched") result.set(event.nodeId, { ...current, semanticState, runtimeStatus: "running", detail: null, retries: event.attempt ?? current.retries });
    if (event.t === "node_completed") result.set(event.nodeId, { ...current, semanticState, runtimeStatus: event.replayed === true ? "replayed" : "completed", detail: null, retries: event.attempt ?? current.retries });
    if (event.t === "node_failed") result.set(event.nodeId, { ...current, semanticState, runtimeStatus: "failed", detail: event.reason ?? null, retries: event.attempt ?? current.retries });
  }
  return result;
}
function requiredNodeData(values: ReadonlyMap<string, NodeLiveState>, id: string): NodeLiveState {
  const value = values.get(id);
  if (value === undefined) throw new Error(`GRAPH_NODE_STATE_MISSING:${id}`);
  return value;
}
function isRunState(value: string | undefined): value is RunState { return value !== undefined && ["verified", "dissent", "refuted", "tainted", "unexamined", "degraded"].includes(value); }
