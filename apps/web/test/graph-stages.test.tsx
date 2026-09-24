// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { NODE_GLYPHS } from "@arbitra/schemas/glyphs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphView } from "../src/columns/graph/GraphView.js";
import type { WorkflowJson } from "../src/columns/graph/layout.js";
import { expandWorkflow, recordedStages } from "../src/columns/graph/recorded-stages.js";

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
    render(<GraphView workflowJson={testing} artifacts={artifacts} runEvents={[]} modelAliases={[]} assignments={{}} onAssign={() => undefined} onSelect={selected} />);
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
