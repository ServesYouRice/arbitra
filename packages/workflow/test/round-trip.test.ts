import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  parseWorkflow,
  serialiseWorkflow,
  validateWorkflow,
  WorkflowValidationError,
  type WorkflowGraph,
} from "../src/graph-schema.js";

const goal = {
  objective: "Exercise the graph schema",
  doneWhen: ["The output exists"],
  stopWhen: ["The output is validated"],
  blockedWhen: ["The input is unavailable"],
} as const;

function generatedGraph(seed: number): WorkflowGraph {
  const loopMaximum = (seed % 5) + 1;
  return {
    schemaVersion: 1,
    id: `generated-${seed}`,
    goal,
    entryNodeId: "prepare",
    nodes: [
      { id: "prepare", kind: "deterministic", label: "Prepare", goal, config: { seed } },
      { id: "discover", kind: "model", label: "Discover", goal },
      { id: "route", kind: "gate", label: "Route", goal },
      { id: "review", kind: "loop", label: "Review", goal, maximum: loopMaximum },
      { id: "approve", kind: "human", label: "Approve", goal },
      { id: "verify", kind: "subgraph", label: "Verify", goal, purpose: "verification" },
    ],
    edges: [
      {
        id: "prepare-discover",
        from: "prepare",
        to: "discover",
        input: { artifacts: ["project-context.json"] },
        prompt: { protocolLayers: ["audit/base@1"] },
        context: {
          policy: { mode: seed % 2 === 0 ? "selected_artifacts" : "delta", trust: "derived", include: [], exclude: [] },
          tokenEstimate: seed * 10,
        },
        output: { schema: "finding@1", requiredFields: ["id"], validationBehaviour: "strict" },
      },
    ],
  };
}

describe("workflow graph schema", () => {
  it("round-trips generated graphs losslessly", () => {
    for (let seed = 0; seed < 100; seed += 1) {
      const graph = generatedGraph(seed);
      expect(parseWorkflow(serialiseWorkflow(graph))).toEqual(graph);
    }
  });

  it("locates an unknown node kind at the offending node id", () => {
    const source = generatedGraph(1);
    const graph = { ...source, nodes: source.nodes.map((node, index) => index === 1 ? { ...node, kind: "verification" } : node) };
    const diagnostics = validateWorkflow(graph);
    expect(diagnostics).toContainEqual({
      path: "nodes[1](discover).kind",
      message: 'Unknown node kind "verification".',
    });
    expect(() => parseWorkflow(JSON.stringify(graph))).toThrow(WorkflowValidationError);
  });

  it("rejects a loop without a positive maximum", () => {
    const source = generatedGraph(2);
    const graph = { ...source, nodes: source.nodes.map((node, index) => index === 3 ? { id: node.id, kind: node.kind, label: node.label, goal: node.goal } : node) };
    expect(validateWorkflow(graph)).toContainEqual({
      path: "nodes[3](review).maximum",
      message: "Loop maximum must be a positive integer.",
    });
  });

  it("rejects continuation state and incomplete edge contracts", () => {
    const source = generatedGraph(3);
    const edge = requiredAt(source.edges, 0);
    const graph = { ...source, edges: [{ ...edge, continuationState: "provider-secret", prompt: {} }] };
    const diagnostics = validateWorkflow(graph);
    expect(diagnostics.map(({ path }) => path)).toEqual(expect.arrayContaining([
      "edges[0].continuationState",
      "edges[0].prompt.protocolLayers",
    ]));
  });

  it("ships one verbatim six-kind glyph table", () => {
    const repositoryRoot = resolve(process.cwd(), "../..");
    const supplied = readFileSync(resolve(repositoryRoot, "docs/brand/glyphs.ts"));
    const installed = readFileSync(resolve(repositoryRoot, "packages/schemas/src/glyphs.ts"));
    expect(installed.equals(supplied)).toBe(true);
    const source = installed.toString("utf8");
    expect(source.match(/export const NODE_GLYPHS/g)).toHaveLength(1);
    for (const kind of ["deterministic", "model", "gate", "loop", "human", "subgraph"]) {
      expect(source).toContain(`${kind}: {`);
    }
  });
});

function requiredAt<T>(values: readonly T[], index: number): T { const value = values[index]; if (value === undefined) throw new RangeError(`Missing test value at index ${index}`); return value; }
