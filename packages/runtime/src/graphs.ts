import type { RunState } from "@arbitra/core/runner/events.js";
import type { RunnerGraph, RunnerNode } from "@arbitra/core/runner/workflow-runner.js";

const node = (id: string, kind: RunnerNode["kind"], label: string): RunnerNode => Object.freeze({ id, kind, label, goal: label });

/**
 * The executable graphs behind the shipped presets. A run stores the graph it walks, and the
 * web app draws that stored graph, not a picture of a different pipeline.
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

/** Dynamic Feature stages replay inside one subgraph when its requirements change. */
export const FEATURE_GRAPH: RunnerGraph = Object.freeze({
  schemaVersion: 1, id: "feature-simple", entryNodeId: "preflight",
  nodes: Object.freeze([node("preflight", "deterministic", "Preflight"), node("feature", "subgraph", "Requirements, exploration and planning"), node("render", "deterministic", "Implementation handoff")]),
  edges: Object.freeze([{ id: "preflight-feature", from: "preflight", to: "feature" }, { id: "feature-render", from: "feature", to: "render" }]),
});

export const PRESET_GRAPHS: Readonly<Record<string, RunnerGraph>> = Object.freeze({
  "audit-deep": AUDIT_DEEP_GRAPH,
  "audit-balanced": AUDIT_BALANCED_GRAPH,
  "diff-review": DIFF_REVIEW_GRAPH,
  "diff-fast": DIFF_FAST_GRAPH,
  "feature-simple": FEATURE_GRAPH,
  "testing-plan": Object.freeze({ schemaVersion: 1, id: "testing-plan", entryNodeId: "preflight",
    nodes: Object.freeze([node("preflight", "deterministic", "Test inventory preflight"), node("testing", "subgraph", "Risk analysis and test planning"), node("render", "deterministic", "Test implementation handoff")]),
    edges: Object.freeze([{ id: "preflight-testing", from: "preflight", to: "testing" }, { id: "testing-render", from: "testing", to: "render" }]),
  }),
  "testing-execute": Object.freeze({ schemaVersion: 1, id: "testing-execute", entryNodeId: "preflight",
    nodes: Object.freeze([node("preflight", "deterministic", "Test execution preflight"), node("testing", "subgraph", "Risk analysis and test planning"), node("execute", "subgraph", "Guarded test execution"), node("render", "deterministic", "Verified test handoff")]),
    edges: Object.freeze([{ id: "preflight-testing", from: "preflight", to: "testing" }, { id: "testing-execute", from: "testing", to: "execute" }, { id: "execute-render", from: "execute", to: "render" }]),
  }),
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

/**
 * The run state an Audit node's work puts the run in (spec §7.7), recorded when the node starts. The Audit executors
 * pick a node's work by its kind, and a model node's by its ID, so the same rule covers the presets and saved graphs.
 * The preflight, gates and human checkpoints leave the state as it is.
 */
export function auditStageState(node: RunnerNode): RunState | undefined {
  if (node.kind === "model") return node.id === "planner" ? "PLANNING" : node.id === "critic" ? "PLAN_REVIEW" : "DISCOVERY_RUNNING";
  if (node.kind === "loop") return "PEER_REVIEW_RUNNING";
  if (node.kind === "subgraph") return "VERIFYING";
  return undefined;
}

/** Replay overrides and a balanced audit's critic role change the executable graph, including presets without a critic. */
export function withCritic(graph: RunnerGraph, enabled: boolean): RunnerGraph {
  const present = graph.nodes.some(({ id }) => id === "critic");
  if (present === enabled) return graph;
  if (!enabled) return { ...graph, nodes: graph.nodes.filter(({ id }) => id !== "critic"), edges: graph.edges.filter(({ from, to }) => from !== "critic" && to !== "critic") };
  if (!graph.nodes.some(({ id }) => id === "planner")) throw new Error("CRITIC_REQUIRES_PLANNER");
  return { ...graph, nodes: [...graph.nodes, node("critic", "model", "Critic")], edges: [...graph.edges, { id: "planner-critic", from: "planner", to: "critic" }] };
}
