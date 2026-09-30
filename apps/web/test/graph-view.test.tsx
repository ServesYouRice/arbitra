// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { NODE_GLYPHS } from "@arbitra/schemas/glyphs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphView, projectLiveState, statusText } from "../src/graph/GraphView.js";
import { layoutWorkflow, type WorkflowJson } from "../src/graph/layout.js";
import { expandWorkflow, recordedStages } from "../src/graph/recorded-stages.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const testing: WorkflowJson = { id: "testing-execute", nodes: [
  { id: "preflight", kind: "deterministic", label: "Preflight" }, { id: "testing", kind: "subgraph", label: "Planning" },
  { id: "execute", kind: "subgraph", label: "Execution" }, { id: "render", kind: "deterministic", label: "Handoff" },
], edges: [{ id: "a", from: "preflight", to: "testing" }, { id: "b", from: "testing", to: "execute" }, { id: "c", from: "execute", to: "render" }] };
const artifacts = ["preflight", "testing-inventory", "testing-risk", "testing-selection", "plan-ir", "testing-outcome", "testing-execution-binding", "testing-writer-result-1", "testing-task-verification-1", "testing-task-verification-2", "testing-repair-lineage", "testing-execution-outcome"].map((kind) => ({ kind }));

describe("recorded Feature/Testing subgraph stages", () => {
  it("expands only recorded stages, in order, with the shared six kinds", () => {
    const stages = recordedStages(testing, artifacts);
    expect(stages.get("testing")?.map(({ id, kind }) => [id, kind])).toEqual([["testing::inventory", "deterministic"], ["testing::risk", "model"], ["testing::selection", "model"], ["testing::planner", "model"], ["testing::outcome", "gate"]]);
    // No completion artifact was recorded, so the verified change set stage is absent, not guessed.
    expect(stages.get("execute")?.map(({ id }) => id)).toEqual(["execute::binding", "execute::writers", "execute::checks", "execute::repair", "execute::outcome"]);
    for (const list of stages.values()) for (const stage of list) expect(Object.keys(NODE_GLYPHS)).toContain(stage.kind);
    const expanded = expandWorkflow(testing, stages, new Set(["execute"]));
    expect(expanded.nodes.map(({ id }) => id)).toEqual(["preflight", "testing", "execute::binding", "execute::writers", "execute::checks", "execute::repair", "execute::outcome", "render"]);
    expect(expanded.edges.map(({ from, to }) => `${from}>${to}`)).toEqual(["preflight>testing", "testing>execute::binding", "execute::outcome>render", "execute::binding>execute::writers", "execute::writers>execute::checks", "execute::checks>execute::repair", "execute::repair>execute::outcome"]);
    expect(expandWorkflow(testing, stages, new Set())).toBe(testing);
    expect(recordedStages({ ...testing, id: "audit-deep" }, artifacts).size).toBe(0);
  });

  it("toggles expansion from the keyboard-reachable stage list", async () => {
    class Observer { observe() {} unobserve() {} disconnect() {} }
    vi.stubGlobal("ResizeObserver", Observer);
    const selected = vi.fn();
    render(<GraphView workflowJson={testing} artifacts={artifacts} runEvents={[]} onSelect={selected} />);
    const list = screen.getByLabelText("live run stages");
    fireEvent.click(within(list).getByRole("button", { name: "expand Execution · 5 recorded stages" }));
    expect(within(list).getByRole("button", { name: /Bounded repair/u })).toBeTruthy();
    expect(within(list).getByText(/Bounded repair/u).closest("li")?.getAttribute("data-stage-of")).toBe("execute");
    expect(within(list).getByText(/Bounded repair/u).closest("li")?.getAttribute("data-runtime")).toBe("recorded");
    fireEvent.click(within(list).getByRole("button", { name: /Bounded repair/u }));
    expect(selected).toHaveBeenCalledWith(expect.objectContaining({ id: "execute::repair", kind: "loop" }));
    fireEvent.click(within(list).getByRole("button", { name: "collapse execute stages" }));
    expect(within(list).queryByText(/Bounded repair/u)).toBeNull();
  });
});

describe("the executed graph", () => {
  const audit: WorkflowJson = { id: "audit-deep", nodes: [
    { id: "preflight", kind: "deterministic", label: "Preflight" }, { id: "auditor-a", kind: "model", label: "Auditor A" }, { id: "auditor-b", kind: "model", label: "Auditor B" }, { id: "verification", kind: "subgraph", label: "Verification" },
  ], edges: [{ id: "a", from: "preflight", to: "auditor-a" }, { id: "b", from: "preflight", to: "auditor-b" }, { id: "c", from: "auditor-a", to: "verification" }, { id: "d", from: "auditor-b", to: "verification" }] };

  it("lays out structurally different workflows at finite positions", async () => {
    const layouts = await Promise.all([audit, testing].map(layoutWorkflow));
    expect(layouts.map((layout) => layout.length)).toEqual([4, 4]);
    for (const layout of layouts) expect(layout.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
  });

  it("states each node's status in words from its events, and never invents a state for a node that has not run", () => {
    const live = projectLiveState(audit, [
      { t: "node_dispatched", runId: "r", nodeId: "auditor-a", activityId: "a", attempt: 2 }, { t: "node_completed", runId: "r", nodeId: "auditor-a", activityId: "a" },
      { t: "node_failed", runId: "r", nodeId: "verification", reason: "fixture failure", attempt: 1 }, { t: "node_completed", runId: "r", nodeId: "preflight", activityId: "p", replayed: true },
    ]);
    const text = (id: string): string => { const state = live.get(id); if (state === undefined) throw new Error(id); return statusText(state); };
    expect(text("auditor-a")).toBe("done · attempt 2");
    expect(text("verification")).toBe("failed · fixture failure");
    expect(text("preflight")).toBe("reused from the source run");
    expect(text("auditor-b")).toBe("not started");
    expect(live.get("auditor-b")).toMatchObject({ semanticState: null, runtimeStatus: "not_started" });
  });

  it("explains the six glyphs and selects a node from the keyboard-reachable list", async () => {
    class Observer { observe() {} unobserve() {} disconnect() {} }
    vi.stubGlobal("ResizeObserver", Observer);
    const selected = vi.fn();
    render(<GraphView workflowJson={audit} runEvents={[]} selectedNodeId="auditor-b" onSelect={selected} />);
    expect(screen.getByLabelText("node kinds").textContent).toBe("■ deterministic step◆ model call◇ gate↻ bounded loop◫ human checkpoint▣ subgraph");
    const list = screen.getByLabelText("live run stages");
    expect(within(list).getByRole("button", { name: /Auditor B/u }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(list).getByRole("button", { name: /Auditor A/u }));
    expect(selected).toHaveBeenCalledWith(expect.objectContaining({ id: "auditor-a", kind: "model" }));
  });
});
