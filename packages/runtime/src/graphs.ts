import type { RunnerGraph, RunnerNode } from "@arbitra/core/runner/workflow-runner.js";

const node = (id: string, kind: RunnerNode["kind"], label: string): RunnerNode => Object.freeze({ id, kind, label, goal: label });

/**
 * The executable graphs behind the shipped presets.
 *
 * These mirror `PRESET_WORKFLOWS` in the web app node for node: the graph the user watches
 * in column two is the graph the runner walks, not a picture of a different pipeline.
 */
export const AUDIT_DEEP_GRAPH: RunnerGraph = Object.freeze({
  schemaVersion: 1,
  id: "audit-deep",
  entryNodeId: "preflight",
  nodes: Object.freeze([
    node("preflight", "deterministic", "Preflight"),
    node("auditor-a", "model", "Auditor A"),
    node("auditor-b", "model", "Auditor B"),
    node("auditor-c", "model", "Auditor C"),
    node("consensus", "loop", "Consensus"),
    node("verification", "subgraph", "Verification"),
    node("planner", "model", "Planner"),
    node("critic", "model", "Critic"),
  ]),
  edges: Object.freeze([
    Object.freeze({ id: "p-a", from: "preflight", to: "auditor-a" }),
    Object.freeze({ id: "p-b", from: "preflight", to: "auditor-b" }),
    Object.freeze({ id: "p-c", from: "preflight", to: "auditor-c" }),
    Object.freeze({ id: "a-c", from: "auditor-a", to: "consensus" }),
    Object.freeze({ id: "b-c", from: "auditor-b", to: "consensus" }),
    Object.freeze({ id: "c-c", from: "auditor-c", to: "consensus" }),
    Object.freeze({ id: "consensus-verification", from: "consensus", to: "verification" }),
    Object.freeze({ id: "verification-planner", from: "verification", to: "planner" }),
    Object.freeze({ id: "planner-critic", from: "planner", to: "critic" }),
  ]),
});

/**
 * The two-auditor diff presets share this shape. The disagreement gate is where a
 * two-auditor split has no majority semantics, so it escalates rather than guessing.
 */
export const DIFF_REVIEW_GRAPH: RunnerGraph = Object.freeze({
  schemaVersion: 1,
  id: "diff-review",
  entryNodeId: "preflight",
  nodes: Object.freeze([
    node("preflight", "deterministic", "Diff scope"),
    node("auditor-a", "model", "Auditor A"),
    node("auditor-b", "model", "Auditor B"),
    node("consensus", "loop", "Disagreement"),
    node("verification", "subgraph", "Verification"),
    node("planner", "model", "Planner"),
  ]),
  edges: Object.freeze([
    Object.freeze({ id: "p-a", from: "preflight", to: "auditor-a" }),
    Object.freeze({ id: "p-b", from: "preflight", to: "auditor-b" }),
    Object.freeze({ id: "a-c", from: "auditor-a", to: "consensus" }),
    Object.freeze({ id: "b-c", from: "auditor-b", to: "consensus" }),
    Object.freeze({ id: "consensus-verification", from: "consensus", to: "verification" }),
    Object.freeze({ id: "verification-planner", from: "verification", to: "planner" }),
  ]),
});

export const AUDIT_BALANCED_GRAPH: RunnerGraph = Object.freeze({ ...DIFF_REVIEW_GRAPH, id: "audit-balanced" });
export const DIFF_FAST_GRAPH: RunnerGraph = Object.freeze({
  ...DIFF_REVIEW_GRAPH, id: "diff-fast",
  nodes: Object.freeze(DIFF_REVIEW_GRAPH.nodes.filter(({ id }) => id !== "auditor-b")),
  edges: Object.freeze(DIFF_REVIEW_GRAPH.edges.filter(({ from, to }) => from !== "auditor-b" && to !== "auditor-b")),
});

export const PRESET_GRAPHS: Readonly<Record<string, RunnerGraph>> = Object.freeze({
  "audit-deep": AUDIT_DEEP_GRAPH,
  "audit-balanced": AUDIT_BALANCED_GRAPH,
  "diff-review": DIFF_REVIEW_GRAPH,
  "diff-fast": DIFF_FAST_GRAPH,
});

export function graphForPreset(preset: string | undefined): RunnerGraph {
  const name = preset ?? "audit-deep";
  const graph = Object.hasOwn(PRESET_GRAPHS, name) ? PRESET_GRAPHS[name] : undefined;
  if (graph === undefined) throw new Error(`UNKNOWN_WORKFLOW_PRESET:${name}`);
  return graph;
}

/** The auditors a preset's graph actually dispatches, so discovery never runs blind. */
export function auditorIdsFor(graph: RunnerGraph): readonly string[] {
  return Object.freeze(graph.nodes.filter(({ id, kind }) => kind === "model" && id.startsWith("auditor-")).map(({ id }) => id));
}
