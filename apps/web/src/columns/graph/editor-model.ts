import type { AuthoredEdge, AuthoredGraph, AuthoredNode, ContextMode, ContextTrust, JsonValue, NodeKind } from "../../api/workflows.js";

/**
 * The editor's state: the graph being edited, undo/redo history and the saved baseline
 * that decides whether there are unsaved changes. Every edit is a pure function over an
 * immutable graph, so history is a list of snapshots and undo can never half-apply.
 *
 * The editor does not validate. It lets an operator build an invalid graph and shows the
 * server's diagnostics for it; the server refuses to save it.
 */
export interface EditorState {
  readonly graph: AuthoredGraph;
  readonly past: readonly AuthoredGraph[];
  readonly future: readonly AuthoredGraph[];
  /** The graph as last loaded or saved; unsaved changes are any difference from it. */
  readonly baseline: AuthoredGraph;
  /** The saved version the baseline is, when it is one. */
  readonly baselineVersion: string | null;
  /** Consecutive edits to one text field coalesce into a single undo step. */
  readonly lastEdit: string | null;
}

export type NodePatch = Partial<Pick<AuthoredNode, "id" | "label" | "maximum" | "purpose">> & { readonly objective?: string; readonly config?: Readonly<Record<string, JsonValue>> };
export type EditorAction =
  | { readonly type: "load"; readonly graph: AuthoredGraph; readonly version: string | null }
  | { readonly type: "saved"; readonly graph: AuthoredGraph; readonly version: string }
  | { readonly type: "undo" }
  | { readonly type: "redo" }
  | { readonly type: "edit"; readonly edit: GraphEdit; readonly coalesce?: string };
export type GraphEdit =
  | { readonly type: "setGraphId"; readonly id: string }
  | { readonly type: "addNode"; readonly kind: NodeKind; readonly id?: string }
  | { readonly type: "removeNode"; readonly id: string }
  | { readonly type: "updateNode"; readonly id: string; readonly patch: NodePatch }
  | { readonly type: "setEntry"; readonly id: string }
  | { readonly type: "connect"; readonly from: string; readonly to: string }
  | { readonly type: "removeEdge"; readonly id: string }
  | { readonly type: "updateEdgeContext"; readonly id: string; readonly mode?: ContextMode; readonly trust?: ContextTrust };

export const HISTORY_LIMIT = 100;
export const NODE_KINDS: readonly NodeKind[] = Object.freeze(["deterministic", "model", "gate", "loop", "human", "subgraph"]);

export function initialEditorState(graph: AuthoredGraph, version: string | null = null): EditorState {
  return Object.freeze({ graph, past: [], future: [], baseline: graph, baselineVersion: version, lastEdit: null });
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "load": return initialEditorState(action.graph, action.version);
    case "saved": return Object.freeze({ ...state, graph: action.graph, baseline: action.graph, baselineVersion: action.version, lastEdit: null });
    case "undo": {
      const previous = state.past.at(-1);
      if (previous === undefined) return state;
      return Object.freeze({ ...state, graph: previous, past: state.past.slice(0, -1), future: [state.graph, ...state.future], lastEdit: null });
    }
    case "redo": {
      const [next, ...rest] = state.future;
      if (next === undefined) return state;
      return Object.freeze({ ...state, graph: next, past: [...state.past, state.graph].slice(-HISTORY_LIMIT), future: rest, lastEdit: null });
    }
    case "edit": {
      const graph = applyEdit(state.graph, action.edit);
      if (graph === state.graph) return state;
      const coalesce = action.coalesce !== undefined && action.coalesce === state.lastEdit;
      return Object.freeze({ ...state, graph, past: coalesce ? state.past : [...state.past, state.graph].slice(-HISTORY_LIMIT), future: [], lastEdit: action.coalesce ?? null });
    }
  }
}

export function isDirty(state: EditorState): boolean { return stableJson(state.graph) !== stableJson(state.baseline); }

/** The version to record as parent: the baseline's, while the graph keeps its ID. */
export function parentVersionOf(state: EditorState): string | null {
  return state.baselineVersion !== null && state.baseline.id === state.graph.id ? state.baselineVersion : null;
}

export function applyEdit(graph: AuthoredGraph, edit: GraphEdit): AuthoredGraph {
  switch (edit.type) {
    case "setGraphId": return edit.id === graph.id ? graph : { ...graph, id: edit.id };
    case "addNode": {
      const id = edit.id ?? uniqueId(graph.nodes.map(({ id: existing }) => existing), edit.kind === "model" ? "auditor-new" : edit.kind);
      if (graph.nodes.some((node) => node.id === id)) return graph;
      return { ...graph, nodes: [...graph.nodes, newNode(edit.kind, id)] };
    }
    case "removeNode": {
      if (!graph.nodes.some(({ id }) => id === edit.id)) return graph;
      const nodes = graph.nodes.filter(({ id }) => id !== edit.id);
      return { ...graph, nodes, edges: graph.edges.filter(({ from, to }) => from !== edit.id && to !== edit.id), entryNodeId: graph.entryNodeId === edit.id ? nodes[0]?.id ?? "" : graph.entryNodeId };
    }
    case "updateNode": {
      const target = graph.nodes.find(({ id }) => id === edit.id);
      if (target === undefined) return graph;
      const { objective, id: renamed, ...rest } = edit.patch;
      const nextId = renamed ?? target.id;
      if (nextId !== target.id && graph.nodes.some(({ id }) => id === nextId)) return graph;
      const updated: AuthoredNode = { ...target, ...rest, id: nextId, ...(objective === undefined ? {} : { goal: { ...target.goal, objective } }) };
      const rename = (value: string): string => value === target.id ? nextId : value;
      return { ...graph, entryNodeId: rename(graph.entryNodeId), nodes: graph.nodes.map((node) => node.id === target.id ? updated : node),
        edges: nextId === target.id ? graph.edges : graph.edges.map((edge) => ({ ...edge, from: rename(edge.from), to: rename(edge.to) })) };
    }
    case "setEntry": return graph.entryNodeId === edit.id || !graph.nodes.some(({ id }) => id === edit.id) ? graph : { ...graph, entryNodeId: edit.id };
    case "connect": {
      if (!graph.nodes.some(({ id }) => id === edit.from) || !graph.nodes.some(({ id }) => id === edit.to)) return graph;
      return { ...graph, edges: [...graph.edges, newEdge(uniqueId(graph.edges.map(({ id }) => id), `${edit.from}-${edit.to}`), edit.from, edit.to)] };
    }
    case "removeEdge": return graph.edges.some(({ id }) => id === edit.id) ? { ...graph, edges: graph.edges.filter(({ id }) => id !== edit.id) } : graph;
    case "updateEdgeContext": return { ...graph, edges: graph.edges.map((edge) => edge.id !== edit.id ? edge : { ...edge, context: { ...edge.context, policy: { ...edge.context.policy, ...(edit.mode === undefined ? {} : { mode: edit.mode }), ...(edit.trust === undefined ? {} : { trust: edit.trust }) } } }) };
  }
}

function newNode(kind: NodeKind, id: string): AuthoredNode {
  const label = `New ${kind}`;
  const base = { id, kind, label, goal: { objective: label, doneWhen: [], stopWhen: [], blockedWhen: [] } };
  if (kind === "loop") return { ...base, maximum: 1 };
  if (kind === "subgraph") return { ...base, purpose: label };
  if (kind === "gate") return { ...base, config: { policy: "quality_gate" } };
  if (kind === "human") return { ...base, config: { prompt: label } };
  return base;
}

export function newEdge(id: string, from: string, to: string): AuthoredEdge {
  return { id, from, to, input: { artifacts: [] }, prompt: { protocolLayers: [] },
    context: { policy: { mode: "selected_artifacts", trust: "derived", include: [], exclude: [] }, tokenEstimate: null },
    output: { schema: "json", requiredFields: [], validationBehaviour: "strict" } };
}

function uniqueId(existing: readonly string[], base: string): string {
  if (!existing.includes(base)) return base;
  for (let suffix = 2; ; suffix += 1) if (!existing.includes(`${base}-${suffix}`)) return `${base}-${suffix}`;
}

/** Key-order-independent JSON, so dirty state reflects content rather than construction order. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) return `{${Object.entries(value).filter(([, child]) => child !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  return JSON.stringify(value);
}
