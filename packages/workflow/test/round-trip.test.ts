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
    const graph = generatedGraph(1) as unknown as { nodes: Array<Record<string, unknown>> };
    graph.nodes[1]!.kind = "verification";
    const diagnostics = validateWorkflow(graph);
    expect(diagnostics).toContainEqual({
      path: "nodes[1](discover).kind",
      message: 'Unknown node kind "verification".',
    });
    expect(() => parseWorkflow(JSON.stringify(graph))).toThrow(WorkflowValidationError);
  });

  it("rejects a loop without a positive maximum", () => {
    const graph = generatedGraph(2) as unknown as { nodes: Array<Record<string, unknown>> };
    delete graph.nodes[3]!.maximum;
    expect(validateWorkflow(graph)).toContainEqual({
      path: "nodes[3](review).maximum",
      message: "Loop maximum must be a positive integer.",
    });
  });

  it("rejects continuation state and incomplete edge contracts", () => {
    const graph = generatedGraph(3) as unknown as { edges: Array<Record<string, unknown>> };
    graph.edges[0]!.continuationState = "provider-secret";
    delete (graph.edges[0]!.prompt as Record<string, unknown>).protocolLayers;
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
