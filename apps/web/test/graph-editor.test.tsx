// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthoredGraph, GraphValidation, WorkflowApi } from "../src/api/workflows.js";
import { WorkflowApiError } from "../src/api/workflows.js";
import { GraphEditor } from "../src/columns/graph/GraphEditor.js";
import { editorReducer, HISTORY_LIMIT, initialEditorState, isDirty, newEdge, parentVersionOf, type EditorState } from "../src/columns/graph/editor-model.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const goal = (objective: string) => ({ objective, doneWhen: [], stopWhen: [], blockedWhen: [] });
const template: AuthoredGraph = {
  schemaVersion: 1, id: "audit-deep", goal: goal("Audit"), entryNodeId: "preflight",
  nodes: [{ id: "preflight", kind: "deterministic", label: "Preflight", goal: goal("Preflight") }, { id: "auditor-a", kind: "model", label: "Auditor A", goal: goal("Auditor A") }],
  edges: [newEdge("p-a", "preflight", "auditor-a")],
};
const edit = (state: EditorState, action: Parameters<typeof editorReducer>[1]): EditorState => editorReducer(state, action);

describe("editor model", () => {
  it("adds, connects, renames and removes with undo/redo and dirty state", () => {
    let state = initialEditorState(template, null);
    expect(isDirty(state)).toBe(false);
    state = edit(state, { type: "edit", edit: { type: "addNode", kind: "human" } });
    expect(state.graph.nodes.at(-1)).toMatchObject({ id: "human", kind: "human", config: { prompt: "New human" } });
    state = edit(state, { type: "edit", edit: { type: "connect", from: "auditor-a", to: "human" } });
    expect(state.graph.edges.at(-1)).toMatchObject({ id: "auditor-a-human", from: "auditor-a", to: "human", context: { policy: { mode: "selected_artifacts", trust: "derived" } } });
    state = edit(state, { type: "edit", edit: { type: "updateNode", id: "human", patch: { id: "signoff" } } });
    expect(state.graph.edges.at(-1)).toMatchObject({ from: "auditor-a", to: "signoff" });
    expect(isDirty(state)).toBe(true);
    state = edit(state, { type: "edit", edit: { type: "removeNode", id: "auditor-a" } });
    expect(state.graph.edges).toEqual([]);
    state = edit(state, { type: "undo" });
    expect(state.graph.nodes.map(({ id }) => id)).toEqual(["preflight", "auditor-a", "signoff"]);
    state = edit(state, { type: "redo" });
    expect(state.graph.nodes.map(({ id }) => id)).toEqual(["preflight", "signoff"]);
    for (let step = 0; step < 4; step += 1) state = edit(state, { type: "undo" });
    expect(isDirty(state)).toBe(false);
    expect(state.past).toEqual([]);
    expect(edit(state, { type: "undo" })).toBe(state);
  });

  it("coalesces typing into one undo step, bounds history and tracks the saved baseline", () => {
    let state = initialEditorState(template, null);
    for (const label of ["P", "Pr", "Pre"]) state = edit(state, { type: "edit", edit: { type: "updateNode", id: "preflight", patch: { label } }, coalesce: "preflight:label" });
    expect(state.past).toHaveLength(1);
    state = edit(state, { type: "edit", edit: { type: "setGraphId", id: "reviewed" } });
    state = edit(state, { type: "saved", graph: state.graph, version: "a".repeat(64) });
    expect(isDirty(state)).toBe(false);
    expect(parentVersionOf(state)).toBe("a".repeat(64));
    state = edit(state, { type: "edit", edit: { type: "setGraphId", id: "renamed" } });
    expect(parentVersionOf(state)).toBeNull();
    for (let step = 0; step < HISTORY_LIMIT + 10; step += 1) state = edit(state, { type: "edit", edit: { type: "addNode", kind: "gate" } });
    expect(state.past).toHaveLength(HISTORY_LIMIT);
    // Edits that change nothing do not enter history.
    expect(edit(state, { type: "edit", edit: { type: "connect", from: "ghost", to: "preflight" } })).toBe(state);
  });
});

describe("graph editor", () => {
  // Each edit re-lays out the canvas with elkjs under jsdom: about 2 s alone, measured past
  // the 5 s default when the whole web suite runs in parallel, so this test gets the 30 s the
  // setup file's findBy timeout assumes.
  it("edits from the keyboard, shows server diagnostics as text and saves a new version", { timeout: 30_000 }, async () => {
    class Observer { observe() {} unobserve() {} disconnect() {} }
    vi.stubGlobal("ResizeObserver", Observer);
    const validations: AuthoredGraph[] = [];
    const saved: { graph: AuthoredGraph; parent: string | null }[] = [];
    const invalid: GraphValidation = { valid: false, version: null, configurationChecked: false, privileged: [], diagnostics: [{ code: "UNAUTHORIZED_CHANGE", path: "$.id", message: "<b>shipped</b> preset" }] };
    const api = {
      list: async () => ({ graphs: [], templates: [template] }),
      version: async () => { throw new Error("unused"); },
      validate: async (graph: AuthoredGraph) => { validations.push(graph); return graph.id === "audit-deep" ? invalid : { ...invalid, valid: true, version: "b".repeat(64), diagnostics: [] }; },
      save: async (graph: AuthoredGraph, parent: string | null) => {
        if (graph.id === "audit-deep") throw new WorkflowApiError(422, "WORKFLOW_GRAPH_INVALID:UNAUTHORIZED_CHANGE");
        saved.push({ graph, parent });
        return { created: true, validation: invalid, record: { graphId: graph.id, version: "b".repeat(64), parentVersion: parent, savedAt: "2026-01-01T00:00:00.000Z", authorizations: [], graph } };
      },
    } as unknown as WorkflowApi;
    const dirty = vi.fn();
    render(<GraphEditor api={api} configurationId={null} onDirtyChange={dirty} />);
    const editor = await screen.findByRole("region", { name: /workflow graph · editing audit-deep/u });
    const diagnostics = await within(editor).findByRole("list", { name: "validation diagnostics" });
    expect(diagnostics.textContent).toContain("<b>shipped</b> preset");
    expect(diagnostics.querySelector("b")).toBeNull();

    fireEvent.click(within(editor).getByRole("button", { name: "add human node" }));
    expect(within(editor).getByText("unsaved changes")).toBeTruthy();
    expect(dirty).toHaveBeenLastCalledWith(true);
    fireEvent.keyDown(editor, { key: "z", ctrlKey: true });
    expect(within(editor).queryByRole("button", { name: "human node human" })).toBeNull();
    fireEvent.keyDown(editor, { key: "Z", metaKey: true, shiftKey: true });
    const human = within(editor).getByRole("button", { name: "human node human" });
    human.focus();
    fireEvent.click(human);
    fireEvent.keyDown(human, { key: "Delete" });
    expect(within(editor).queryByRole("button", { name: "human node human" })).toBeNull();
    fireEvent.keyDown(editor, { key: "y", ctrlKey: true });
    fireEvent.keyDown(editor, { key: "z", ctrlKey: true });
    expect(within(editor).getByRole("button", { name: "human node human" })).toBeTruthy();

    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
    expect(await within(editor).findByRole("alert")).toHaveProperty("textContent", "save refused · WORKFLOW_GRAPH_INVALID:UNAUTHORIZED_CHANGE");
    fireEvent.change(within(editor).getByLabelText("graph id"), { target: { value: "reviewed" } });
    await waitFor(() => expect(validations.at(-1)?.id).toBe("reviewed"));
    fireEvent.click(within(editor).getByRole("button", { name: "save as new version" }));
    expect(await within(editor).findByText(`saved reviewed @ ${"b".repeat(64)}`)).toBeTruthy();
    expect(saved).toEqual([{ graph: expect.objectContaining({ id: "reviewed" }), parent: null }]);
    expect(within(editor).getByLabelText("run configuration reference").textContent).toBe(JSON.stringify({ graph: { id: "reviewed", version: "b".repeat(64) } }));
    expect(within(editor).getByText(`no unsaved changes · version ${"b".repeat(64)}`)).toBeTruthy();
    expect(dirty).toHaveBeenLastCalledWith(false);
  });
});
