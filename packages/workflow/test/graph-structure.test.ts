import { describe, expect, it } from "vitest";
import type { WorkflowGraph } from "../src/graph-schema.js";
import { validateGraphStructure } from "../src/graph-structure.js";
import type { WorkflowEdge } from "../src/edge-contracts.js";

const goal = { objective: "Structure", doneWhen: [], stopWhen: [], blockedWhen: [] } as const;
const edge = (id: string, from: string, to: string, trust: "system" | "derived" | "untrusted" = "derived"): WorkflowEdge => ({
  id, from, to, input: { artifacts: [] }, prompt: { protocolLayers: [] },
  context: { policy: { mode: "selected_artifacts", trust, include: [], exclude: [] }, tokenEstimate: null },
  output: { schema: "json", requiredFields: [], validationBehaviour: "strict" },
});
const graph = (edges: readonly WorkflowEdge[], extra: WorkflowGraph["nodes"] = []): WorkflowGraph => ({
  schemaVersion: 1, id: "structure", goal, entryNodeId: "start",
  nodes: [{ id: "start", kind: "deterministic", label: "Start", goal }, { id: "think", kind: "model", label: "Think", goal }, { id: "repeat", kind: "loop", label: "Repeat", goal, maximum: 2 }, ...extra],
  edges,
});
const codes = (value: WorkflowGraph, maximumLoopIterations = 3): string[] => validateGraphStructure(value, { maximumLoopIterations }).map(({ code }) => code);

describe("workflow graph structure", () => {
  it("accepts an acyclic graph whose nodes are all reachable", () => {
    expect(codes(graph([edge("a", "start", "think"), edge("b", "think", "repeat")]))).toEqual([]);
  });

  it("rejects edge cycles, self loops, duplicate edges and edges into the entry node", () => {
    expect(codes(graph([edge("a", "start", "think"), edge("b", "think", "repeat"), edge("c", "repeat", "think")]))).toEqual(["UNBOUNDED_CYCLE"]);
    expect(codes(graph([edge("a", "start", "think"), edge("b", "think", "think"), edge("c", "think", "repeat")]))).toEqual(["SELF_LOOP"]);
    expect(codes(graph([edge("a", "start", "think"), edge("b", "start", "think"), edge("c", "think", "repeat")]))).toEqual(["DUPLICATE_EDGE"]);
    expect(codes(graph([edge("a", "start", "think"), edge("b", "think", "repeat"), edge("c", "repeat", "start")]))).toEqual(["EDGE_INTO_ENTRY", "UNBOUNDED_CYCLE"]);
  });

  it("rejects unreachable nodes, loop bounds above the executable maximum and trust escalation", () => {
    expect(codes(graph([edge("a", "start", "think")]))).toEqual(["UNREACHABLE_NODE"]);
    expect(codes(graph([edge("a", "start", "think"), edge("b", "think", "repeat")]), 1)).toEqual(["LOOP_BOUND_EXCEEDED"]);
    const escalated = validateGraphStructure(graph([edge("a", "start", "think"), edge("b", "think", "repeat", "system")]), { maximumLoopIterations: 3 });
    expect(escalated).toEqual([{ code: "CONTEXT_TRUST_ESCALATION", path: "edges[1](b).context.policy.trust", message: expect.stringContaining("model output") }]);
  });
});
