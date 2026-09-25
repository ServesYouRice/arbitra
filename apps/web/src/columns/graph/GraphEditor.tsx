import "./graph-editor.css";
import { NODE_GLYPHS } from "@arbitra/schemas/glyphs";
import { Background, Controls, ReactFlow, type Connection, type Edge, type Node, type ReactFlowInstance } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactElement } from "react";
import { WorkflowApiError, type AuthoredGraph, type AuthoredNode, type ContextMode, type ContextTrust, type GraphListing, type GraphValidation, type GraphVersionRecord, type NodeKind, type WorkflowApi } from "../../api/workflows.js";
import { UnsavedChangesDialog } from "../../controls/UnsavedChangesDialog.js";
import { editorReducer, initialEditorState, isDirty, NODE_KINDS, parentVersionOf, type EditorAction, type EditorState, type GraphEdit, type NodePatch } from "./editor-model.js";
import { layoutWorkflow } from "./layout.js";

/**
 * Edit mode of the workflow graph column.
 *
 * Every operation has a keyboard path: the node and edge lists, the add/connect forms and
 * the inspector are ordinary form controls, and Ctrl/⌘+Z, Ctrl/⌘+Shift+Z (or Ctrl+Y),
 * Ctrl/⌘+S and Delete work anywhere in the editor. The canvas mirrors the same state and
 * accepts pointer connections. Validation messages come only from the server's validator.
 */
export interface GraphEditorProps {
  readonly api: WorkflowApi;
  /** Validation includes this configuration's model roles and checkpoint policy. */
  readonly configurationId: string | null;
  /** `saved:<graph>:<version>` or `template:<id>` to open first, when it exists. */
  readonly preferredSource?: string | null;
  readonly onDirtyChange?: (dirty: boolean) => void;
  readonly onSaved?: (record: GraphVersionRecord) => void;
}
type Selection = { readonly kind: "node" | "edge"; readonly id: string } | null;
interface ValidationState { readonly result: GraphValidation | null; readonly pending: boolean; readonly error: string | null }
const CONTEXT_MODES: readonly ContextMode[] = ["none", "selected_artifacts", "summary", "delta", "recent_turns", "full_context"];
const CONTEXT_TRUST: readonly ContextTrust[] = ["system", "derived", "untrusted"];

function reducer(state: EditorState | null, action: EditorAction): EditorState | null {
  if (action.type === "load") return initialEditorState(action.graph, action.version);
  return state === null ? null : editorReducer(state, action);
}

export function GraphEditor({ api, configurationId, preferredSource = null, onDirtyChange, onSaved }: GraphEditorProps): ReactElement {
  const [listing, setListing] = useState<GraphListing | null>(null);
  const [listingError, setListingError] = useState<string | null>(null);
  const [state, dispatch] = useReducer(reducer, null);
  const [source, setSource] = useState("");
  const [loadedSource, setLoadedSource] = useState("");
  const [selection, setSelection] = useState<Selection>(null);
  const [validation, setValidation] = useState<ValidationState>({ result: null, pending: false, error: null });
  const [saveStatus, setSaveStatus] = useState<{ readonly kind: "saved" | "refused"; readonly text: string; readonly record?: GraphVersionRecord } | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingSource, setPendingSource] = useState<string | null>(null);
  const region = useRef<HTMLElement>(null);
  const [connectFrom, setConnectFrom] = useState("");
  const [connectTo, setConnectTo] = useState("");
  const dirty = state !== null && isDirty(state);
  const graph = state?.graph ?? null;

  const load = useCallback(async (key: string, available: GraphListing): Promise<void> => {
    setSaveStatus(null); setSelection(null);
    const [type, first, second] = key.split(":");
    if (type === "template") {
      const template = available.templates.find(({ id }) => id === first);
      if (template !== undefined) { dispatch({ type: "load", graph: template, version: null }); setSource(key); setLoadedSource(key); }
      return;
    }
    if (type === "saved" && first !== undefined && second !== undefined) {
      try { const record = await api.version(first, second); dispatch({ type: "load", graph: record.graph, version: record.version }); setSource(key); setLoadedSource(key); }
      catch (cause) { setListingError(message(cause)); }
    }
  }, [api]);

  useEffect(() => {
    let active = true;
    void api.list().then((value) => {
      if (!active) return;
      setListing(value);
      const keys = sourceKeys(value);
      void load(preferredSource !== null && keys.includes(preferredSource) ? preferredSource : keys.find((key) => key === "template:audit-deep") ?? keys[0] ?? "", value);
    }, (cause: unknown) => { if (active) setListingError(message(cause)); });
    return () => { active = false; };
  }, [api, load, preferredSource]);

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => { onDirtyChange?.(false); }, [onDirtyChange]);
  // A browser navigation or reload with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent): void => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  // Live validation: the latest graph wins; a slower earlier response is discarded.
  const ticket = useRef(0);
  useEffect(() => {
    if (graph === null) return;
    const current = ++ticket.current;
    setValidation((previous) => ({ ...previous, pending: true }));
    const timer = setTimeout(() => {
      void api.validate(graph, configurationId).then(
        (result) => { if (ticket.current === current) setValidation({ result, pending: false, error: null }); },
        (cause: unknown) => { if (ticket.current === current) setValidation({ result: null, pending: false, error: message(cause) }); });
    }, 200);
    return () => clearTimeout(timer);
  }, [api, graph, configurationId]);

  const edit = useCallback((change: GraphEdit, coalesce?: string): void => { setSaveStatus(null); dispatch({ type: "edit", edit: change, ...(coalesce === undefined ? {} : { coalesce }) }); }, []);
  const undo = (): void => { setSaveStatus(null); dispatch({ type: "undo" }); };
  const redo = (): void => { setSaveStatus(null); dispatch({ type: "redo" }); };
  const save = async (): Promise<void> => {
    if (state === null || saving || !dirty) return;
    setSaving(true);
    try {
      const saved = await api.save(state.graph, parentVersionOf(state), configurationId);
      dispatch({ type: "saved", graph: saved.record.graph, version: saved.record.version });
      const key = `saved:${saved.record.graphId}:${saved.record.version}`;
      setSource(key); setLoadedSource(key);
      setListing(await api.list());
      setSaveStatus({ kind: "saved", text: `saved ${saved.record.graphId} @ ${saved.record.version}${saved.created ? "" : " · identical version already saved"}`, record: saved.record });
      onSaved?.(saved.record);
    } catch (cause) {
      setSaveStatus({ kind: "refused", text: `save refused · ${cause instanceof WorkflowApiError ? cause.code : message(cause)}` });
    } finally { setSaving(false); }
  };
  const removeSelected = (): void => {
    if (selection === null) return;
    edit(selection.kind === "node" ? { type: "removeNode", id: selection.id } : { type: "removeEdge", id: selection.id });
    setSelection(null);
  };
  const onKeyDown = (event: globalThis.KeyboardEvent): void => {
    // Shortcuts apply inside the editor, or when focus has fallen back to the page (for
    // example after the focused control was removed); never inside another panel.
    const target = event.target instanceof Node ? event.target : null;
    if (pendingSource !== null || event.defaultPrevented || !(target === document.body || target === document.documentElement || (target !== null && region.current?.contains(target) === true))) return;
    const modifier = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (modifier && key === "z" && !event.shiftKey) { event.preventDefault(); undo(); }
    else if (modifier && ((key === "z" && event.shiftKey) || key === "y")) { event.preventDefault(); redo(); }
    else if (modifier && key === "s") { event.preventDefault(); void save(); }
    else if ((event.key === "Delete" || (event.key === "Backspace" && modifier)) && !isTextEntry(event.target) && selection !== null) { event.preventDefault(); removeSelected(); }
  };
  const latestKeyDown = useRef(onKeyDown);
  latestKeyDown.current = onKeyDown;
  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent): void => latestKeyDown.current(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);
  const requestSource = (key: string): void => { if (key === loadedSource) return; if (dirty) setPendingSource(key); else if (listing !== null) void load(key, listing); };

  if (listing === null || state === null || graph === null) {
    return <section className="graph-region" aria-labelledby="graph-editor-title"><h2 className="panel-title" id="graph-editor-title">workflow graph · editing</h2>
      {listingError === null ? <p className="state" data-state="unexamined">loading saved graphs</p> : <p className="state" data-state="degraded" role="alert">workflow API unavailable · {listingError}</p>}</section>;
  }
  const selectedNode = selection?.kind === "node" ? graph.nodes.find(({ id }) => id === selection.id) : undefined;
  const selectedEdge = selection?.kind === "edge" ? graph.edges.find(({ id }) => id === selection.id) : undefined;
  const diagnostics = validation.result?.diagnostics ?? [];
  const canConnect = graph.nodes.some(({ id }) => id === connectFrom) && graph.nodes.some(({ id }) => id === connectTo);
  const connect = (): void => { if (canConnect) edit({ type: "connect", from: connectFrom, to: connectTo }); };
  const reference = saveStatus?.record === undefined ? null : JSON.stringify({ graph: { id: saveStatus.record.graphId, version: saveStatus.record.version } });

  return <section ref={region} className="graph-region graph-editor" aria-labelledby="graph-editor-title">
    <h2 className="panel-title" id="graph-editor-title">workflow graph · editing {graph.id}</h2>
    <p aria-live="polite" className="state editor-dirty" data-dirty={dirty} data-state={dirty ? "degraded" : "verified"}>{dirty ? "unsaved changes" : state.baselineVersion === null ? "no unsaved changes · not saved as a version" : `no unsaved changes · version ${state.baselineVersion}`}</p>
    <div aria-label="graph editing" className="editor-toolbar" role="toolbar">
      <label>start from<select aria-label="start from" value={source} onChange={(event) => { setSource(event.target.value); }}>{listing.templates.map(({ id }) => <option key={`template:${id}`} value={`template:${id}`}>preset template · {id}</option>)}{listing.graphs.flatMap(({ graphId, versions }) => versions.map(({ version }) => <option key={`saved:${graphId}:${version}`} value={`saved:${graphId}:${version}`}>saved · {graphId} @ {version.slice(0, 12)}</option>))}</select></label>
      <button disabled={source === loadedSource} type="button" onClick={() => requestSource(source)}>open</button>
      <button aria-keyshortcuts="Control+Z Meta+Z" disabled={state.past.length === 0} type="button" onClick={undo}>undo</button>
      <button aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y" disabled={state.future.length === 0} type="button" onClick={redo}>redo</button>
      <button aria-keyshortcuts="Control+S Meta+S" disabled={!dirty || saving} type="button" onClick={() => { void save(); }}>save as new version</button>
    </div>
    {saveStatus === null ? null : <p className="state" data-state={saveStatus.kind === "saved" ? "verified" : "refuted"} role={saveStatus.kind === "saved" ? "status" : "alert"}>{saveStatus.text}</p>}
    {reference === null ? null : <p className="editor-reference">run configuration reference · <code aria-label="run configuration reference">{reference}</code></p>}
    <label>graph id<input aria-label="graph id" value={graph.id} onChange={(event) => edit({ type: "setGraphId", id: event.target.value }, "graph-id")} /></label>
    <EditorCanvas graph={graph} selection={selection} onSelect={setSelection} onConnect={(from, to) => edit({ type: "connect", from, to })} />
    <div className="editor-forms">
      <fieldset><legend>add node</legend>
        {NODE_KINDS.map((kind) => <button aria-label={`add ${kind} node`} key={kind} type="button" onClick={() => { const before = new Set(graph.nodes.map(({ id }) => id)); edit({ type: "addNode", kind }); setSelection({ kind: "node", id: nextNodeId(kind, before) }); }}><span aria-hidden="true" style={{ color: `var(${NODE_GLYPHS[kind].token})` }}>{NODE_GLYPHS[kind].glyph}</span> {kind}</button>)}
      </fieldset>
      <fieldset><legend>connect nodes</legend>
        {/* Typed node IDs (with suggestions) behave the same in every browser, unlike select type-ahead. */}
        <datalist id="editor-node-ids">{graph.nodes.map(({ id }) => <option key={id} value={id} />)}</datalist>
        <label>from<input aria-label="connect from" autoComplete="off" list="editor-node-ids" value={connectFrom} onChange={(event) => setConnectFrom(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && canConnect) { event.preventDefault(); connect(); } }} /></label>
        <label>to<input aria-label="connect to" autoComplete="off" list="editor-node-ids" value={connectTo} onChange={(event) => setConnectTo(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && canConnect) { event.preventDefault(); connect(); } }} /></label>
        <button disabled={!canConnect} type="button" onClick={connect}>connect</button>
      </fieldset>
    </div>
    <div className="editor-lists">
      <section aria-labelledby="editor-nodes-title"><h3 className="panel-title" id="editor-nodes-title">nodes · {graph.nodes.length}</h3>
        <ol aria-label="graph nodes" className="editor-list">{graph.nodes.map((node) => <li key={node.id} data-selected={selection?.kind === "node" && selection.id === node.id}>
          <button aria-label={`${node.kind} node ${node.id}${node.id === graph.entryNodeId ? " · entry" : ""}`} aria-pressed={selection?.kind === "node" && selection.id === node.id} className="editor-list__select" type="button" onClick={() => setSelection({ kind: "node", id: node.id })}><span aria-hidden="true" style={{ color: `var(${NODE_GLYPHS[node.kind].token})` }}>{NODE_GLYPHS[node.kind].glyph}</span> {node.id}{node.id === graph.entryNodeId ? " · entry" : ""}</button>
          <button aria-label={`remove node ${node.id}`} type="button" onClick={() => { edit({ type: "removeNode", id: node.id }); setSelection(null); }}>remove</button>
        </li>)}</ol>
      </section>
      <section aria-labelledby="editor-edges-title"><h3 className="panel-title" id="editor-edges-title">edges · {graph.edges.length}</h3>
        <ol aria-label="graph edges" className="editor-list">{graph.edges.map((edge) => <li key={edge.id} data-selected={selection?.kind === "edge" && selection.id === edge.id}>
          <button aria-pressed={selection?.kind === "edge" && selection.id === edge.id} className="editor-list__select" type="button" onClick={() => setSelection({ kind: "edge", id: edge.id })}>{edge.from} → {edge.to}</button>
          <button aria-label={`remove edge ${edge.from} to ${edge.to}`} type="button" onClick={() => { edit({ type: "removeEdge", id: edge.id }); setSelection(null); }}>remove</button>
        </li>)}</ol>
      </section>
    </div>
    <section aria-labelledby="editor-inspector-title" className="editor-inspector"><h3 className="panel-title" id="editor-inspector-title">{selectedNode !== undefined ? `node inspector · ${selectedNode.id}` : selectedEdge !== undefined ? `edge inspector · ${selectedEdge.from} → ${selectedEdge.to}` : "inspector"}</h3>
      {selectedNode !== undefined ? <NodeInspector key={selectedNode.id} node={selectedNode} entry={graph.entryNodeId === selectedNode.id} taken={graph.nodes.map(({ id }) => id)} onChange={(patch, field) => edit({ type: "updateNode", id: selectedNode.id, patch }, `${selectedNode.id}:${field}`)} onRename={(id) => { edit({ type: "updateNode", id: selectedNode.id, patch: { id } }); setSelection({ kind: "node", id }); }} onEntry={() => edit({ type: "setEntry", id: selectedNode.id })} />
        : selectedEdge !== undefined ? <div className="editor-fields">
          <label>context mode<select aria-label="context mode" value={selectedEdge.context.policy.mode} onChange={(event) => edit({ type: "updateEdgeContext", id: selectedEdge.id, mode: event.target.value as ContextMode })}>{CONTEXT_MODES.map((mode) => <option key={mode}>{mode}</option>)}</select></label>
          <label>context trust<select aria-label="context trust" value={selectedEdge.context.policy.trust} onChange={(event) => edit({ type: "updateEdgeContext", id: selectedEdge.id, trust: event.target.value as ContextTrust })}>{CONTEXT_TRUST.map((trust) => <option key={trust}>{trust}</option>)}</select></label>
        </div>
        : <p className="state" data-state="unexamined">select a node or edge to inspect it</p>}
    </section>
    <section aria-labelledby="editor-validation-title" className="editor-validation"><h3 className="panel-title" id="editor-validation-title">server validation</h3>
      <p className="state" data-state={validation.error !== null ? "degraded" : validation.pending || validation.result === null ? "unexamined" : validation.result.valid ? "verified" : "refuted"} role="status">{validationSummary(validation, configurationId)}</p>
      {diagnostics.length === 0 ? null : <ul aria-label="validation diagnostics" className="editor-diagnostics">{diagnostics.map((item, index) => <li className="state" data-state="refuted" key={`${item.code}-${item.path}-${index}`}><span className="editor-diagnostics__code">{item.code}</span> · {item.path} · {item.message}</li>)}</ul>}
    </section>
    <UnsavedChangesDialog open={pendingSource !== null} action="Opening another graph" onKeep={() => { setPendingSource(null); setSource(loadedSource); }} onDiscard={() => { const key = pendingSource; setPendingSource(null); if (key !== null) void load(key, listing); }} />
  </section>;
}

function NodeInspector({ node, entry, taken, onChange, onRename, onEntry }: { readonly node: AuthoredNode; readonly entry: boolean; readonly taken: readonly string[]; readonly onChange: (patch: NodePatch, field: string) => void; readonly onRename: (id: string) => void; readonly onEntry: () => void }): ReactElement {
  const [draftId, setDraftId] = useState(node.id);
  const conflict = draftId !== node.id && taken.includes(draftId);
  const commit = (): void => { if (draftId !== node.id && draftId !== "" && !conflict) onRename(draftId); };
  const config = node.config ?? {};
  const text = (key: string): string => typeof config[key] === "string" ? config[key] as string : "";
  return <div className="editor-fields">
    <p>kind · <span aria-hidden="true" style={{ color: `var(${NODE_GLYPHS[node.kind].token})` }}>{NODE_GLYPHS[node.kind].glyph}</span> {node.kind}{entry ? " · entry node" : ""}</p>
    <label>node id<input aria-describedby={conflict ? "node-id-conflict" : undefined} aria-label="node id" value={draftId} onBlur={commit} onChange={(event) => setDraftId(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); } }} /></label>
    {conflict ? <p className="state" data-state="refuted" id="node-id-conflict">node id {draftId} is already used</p> : null}
    <label>label<input aria-label="label" value={node.label} onChange={(event) => onChange({ label: event.target.value }, "label")} /></label>
    <label>objective<input aria-label="objective" value={node.goal.objective} onChange={(event) => onChange({ objective: event.target.value }, "objective")} /></label>
    {node.kind === "loop" ? <label>loop maximum<input aria-label="loop maximum" min="1" type="number" value={node.maximum ?? 1} onChange={(event) => onChange({ maximum: Number(event.target.value) }, "maximum")} /></label> : null}
    {node.kind === "subgraph" ? <label>purpose<input aria-label="purpose" value={node.purpose ?? ""} onChange={(event) => onChange({ purpose: event.target.value }, "purpose")} /></label> : null}
    {node.kind === "gate" ? <label>gate policy<input aria-label="gate policy" value={text("policy")} onChange={(event) => onChange({ config: { ...config, policy: event.target.value } }, "policy")} /></label> : null}
    {node.kind === "human" ? <label>checkpoint prompt<textarea aria-label="checkpoint prompt" value={text("prompt")} onChange={(event) => onChange({ config: { ...config, prompt: event.target.value } }, "prompt")} /></label> : null}
    <button disabled={entry} type="button" onClick={onEntry}>make entry node</button>
  </div>;
}

interface CanvasNodeData extends Record<string, unknown> { readonly label: string }
function EditorCanvas({ graph, selection, onSelect, onConnect }: { readonly graph: AuthoredGraph; readonly selection: Selection; readonly onSelect: (selection: Selection) => void; readonly onConnect: (from: string, to: string) => void }): ReactElement {
  const [positions, setPositions] = useState<ReadonlyMap<string, { x: number; y: number }>>(new Map());
  const [flow, setFlow] = useState<ReactFlowInstance<Node<CanvasNodeData>, Edge> | null>(null);
  const shape = useMemo(() => ({ id: graph.id, nodes: graph.nodes.map(({ id, kind, label }) => ({ id, kind, label })), edges: graph.edges.map(({ id, from, to }) => ({ id, from, to })) }), [graph]);
  useEffect(() => { let active = true; void layoutWorkflow(shape).then((layout) => { if (active) setPositions(new Map(layout.map(({ id, x, y }) => [id, { x, y }]))); }); return () => { active = false; }; }, [shape]);
  useEffect(() => { if (flow === null || positions.size === 0) return; const frame = requestAnimationFrame(() => { void flow.fitView({ padding: 0.12 }); }); return () => cancelAnimationFrame(frame); }, [flow, positions]);
  const nodes: Node<CanvasNodeData>[] = graph.nodes.map((node) => ({ id: node.id, position: positions.get(node.id) ?? { x: 0, y: 0 }, data: { label: `${NODE_GLYPHS[node.kind].glyph} ${node.label}` }, selected: selection?.kind === "node" && selection.id === node.id, draggable: false, ariaLabel: `${node.kind} node ${node.id}` }));
  const edges: Edge[] = graph.edges.map(({ id, from, to }) => ({ id, source: from, target: to, selected: selection?.kind === "edge" && selection.id === id }));
  return <div className="graph-canvas" data-testid="editor-canvas"><ReactFlow nodes={nodes} edges={edges} deleteKeyCode={null} minZoom={0.1} nodesConnectable nodesDraggable={false} onConnect={(connection: Connection) => onConnect(connection.source, connection.target)} onEdgeClick={(_, edge) => onSelect({ kind: "edge", id: edge.id })} onInit={setFlow} onNodeClick={(_, node) => onSelect({ kind: "node", id: node.id })}><Background /><Controls showInteractive={false} /></ReactFlow></div>;
}

function sourceKeys(listing: GraphListing): string[] {
  return [...listing.templates.map(({ id }) => `template:${id}`), ...listing.graphs.flatMap(({ graphId, versions }) => versions.map(({ version }) => `saved:${graphId}:${version}`))];
}
function nextNodeId(kind: NodeKind, before: ReadonlySet<string>): string {
  const base = kind === "model" ? "auditor-new" : kind;
  if (!before.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) if (!before.has(`${base}-${suffix}`)) return `${base}-${suffix}`;
}
function isTextEntry(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
}
function validationSummary(validation: ValidationState, configurationId: string | null): string {
  if (validation.error !== null) return `validation unavailable · ${validation.error}`;
  if (validation.result === null) return "validating";
  const scope = validation.result.configurationChecked ? `checked against configuration ${configurationId ?? ""}` : "configuration not checked · select a saved configuration to check model roles and checkpoint policy";
  const status = validation.result.valid ? `valid · version ${validation.result.version ?? "unknown"}` : `invalid · ${validation.result.diagnostics.length} diagnostic${validation.result.diagnostics.length === 1 ? "" : "s"}`;
  return `${validation.pending ? "revalidating · " : ""}${status} · ${scope}`;
}
function message(cause: unknown): string { return cause instanceof WorkflowApiError ? cause.code : cause instanceof Error ? cause.message : String(cause); }
