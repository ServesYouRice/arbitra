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

export const PRESET_GRAPHS: Readonly<Record<string, RunnerGraph>> = Object.freeze({
  "audit-deep": AUDIT_DEEP_GRAPH,
  "audit-balanced": AUDIT_DEEP_GRAPH,
  "diff-review": DIFF_REVIEW_GRAPH,
  "diff-fast": DIFF_REVIEW_GRAPH,
});

export function graphForPreset(preset: string | undefined): RunnerGraph {
  return PRESET_GRAPHS[preset ?? "audit-deep"] ?? AUDIT_DEEP_GRAPH;
}

/** The auditors a preset's graph actually dispatches, so discovery never runs blind. */
export function auditorIdsFor(graph: RunnerGraph): readonly string[] {
  return Object.freeze(graph.nodes.filter(({ id, kind }) => kind === "model" && id.startsWith("auditor-")).map(({ id }) => id));
}
