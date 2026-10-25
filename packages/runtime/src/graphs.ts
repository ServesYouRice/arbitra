import type { RunnerGraph, RunnerNode } from "@arbitra/core/runner/workflow-runner.js";

const node = (id: string, kind: RunnerNode["kind"], label: string): RunnerNode => Object.freeze({ id, kind, label, goal: label });

/**
 * The executable graphs behind the shipped presets. A run stores the graph it walks, and the
 * web app draws that stored graph, not a picture of a different pipeline.
 *
 * The audit presets are named by how many finders they run. The plan critic is not part of any of them: it is a
 * switch of its own (`workflow.critic`), off by default, that adds the critic after the planner. So is the variant
 * search (`workflow.variantSearch`), which goes between verification and the planner.
 */
export const AUDIT_THREE_FINDERS_GRAPH: RunnerGraph = Object.freeze({
  schemaVersion: 1,
  id: "audit-three-finders",
  entryNodeId: "preflight",
  nodes: Object.freeze([
    node("preflight", "deterministic", "Preflight"),
    node("auditor-a", "model", "Auditor A"),
    node("auditor-b", "model", "Auditor B"),
    node("auditor-c", "model", "Auditor C"),
    node("consensus", "loop", "Consensus"),
    node("verification", "subgraph", "Verification"),
    node("planner", "model", "Planner"),
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

export const AUDIT_TWO_FINDERS_GRAPH: RunnerGraph = Object.freeze({ ...DIFF_REVIEW_GRAPH, id: "audit-two-finders" });
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
  "audit-three-finders": AUDIT_THREE_FINDERS_GRAPH,
  "audit-two-finders": AUDIT_TWO_FINDERS_GRAPH,
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

/**
 * Earlier names of the audit presets, which named a finder count as a depth. Saved configurations that name them run
 * the preset of that count; a stored run keeps the graph it started with (its id and its critic, if it had one), so it
 * still shows and resumes as it was. Neither alias brings a critic: `audit-deep` had one built in, and now the critic
 * is the `workflow.critic` switch.
 */
export const PRESET_ALIASES: Readonly<Record<string, string>> = Object.freeze({ "audit-balanced": "audit-two-finders", "audit-deep": "audit-three-finders" });

/** Every preset name a configuration may use, aliases included; none of them can be taken by a registered graph. */
export const PRESET_NAMES: readonly string[] = Object.freeze([...Object.keys(PRESET_GRAPHS), ...Object.keys(PRESET_ALIASES)]);

/** The preset an audit runs when its configuration names none. */
export const DEFAULT_AUDIT_PRESET = "audit-three-finders";

export function graphForPreset(preset: string | undefined): RunnerGraph {
  const named = preset ?? DEFAULT_AUDIT_PRESET;
  const name = Object.hasOwn(PRESET_ALIASES, named) ? PRESET_ALIASES[named] as string : named;
  const graph = Object.hasOwn(PRESET_GRAPHS, name) ? PRESET_GRAPHS[name] : undefined;
  if (graph === undefined) throw new Error(`UNKNOWN_WORKFLOW_PRESET:${named}`);
  return graph;
}

/** The auditors a preset's graph actually dispatches, so discovery never runs blind. */
export function auditorIdsFor(graph: RunnerGraph): readonly string[] {
  return Object.freeze(graph.nodes.filter(({ id, kind }) => kind === "model" && id.startsWith("auditor-")).map(({ id }) => id));
}

/** The node of the optional variant search, and the label a running run shows for it. */
export const VARIANT_SEARCH_NODE_ID = "variant-search";

/**
 * The variant search switch (`workflow.variantSearch`) changes the executable graph as the critic's does: the search
 * goes between any graph's verification and its planner, so the planner plans the variants verification confirms.
 */
export function withVariantSearch(graph: RunnerGraph, enabled: boolean): RunnerGraph {
  const present = graph.nodes.some(({ id }) => id === VARIANT_SEARCH_NODE_ID);
  if (present === enabled) return graph;
  if (!enabled) {
    const kept = graph.edges.filter(({ from, to }) => from !== VARIANT_SEARCH_NODE_ID && to !== VARIANT_SEARCH_NODE_ID);
    return { ...graph, nodes: graph.nodes.filter(({ id }) => id !== VARIANT_SEARCH_NODE_ID), edges: [...kept, { id: "verification-planner", from: "verification", to: "planner" }] };
  }
  const at = graph.nodes.findIndex(({ id }) => id === "verification");
  if (at < 0 || !graph.edges.some(({ from, to }) => from === "verification" && to === "planner")) throw new Error("VARIANT_SEARCH_REQUIRES_VERIFICATION_AND_PLANNER");
  return { ...graph, nodes: [...graph.nodes.slice(0, at + 1), node(VARIANT_SEARCH_NODE_ID, "model", "Searching for variants"), ...graph.nodes.slice(at + 1)],
    edges: [...graph.edges.filter(({ from, to }) => !(from === "verification" && to === "planner")), { id: "verification-variant-search", from: "verification", to: VARIANT_SEARCH_NODE_ID }, { id: "variant-search-planner", from: VARIANT_SEARCH_NODE_ID, to: "planner" }] };
}

/** The critic switch and replay overrides change the executable graph: the critic follows any graph's planner. */
export function withCritic(graph: RunnerGraph, enabled: boolean): RunnerGraph {
  const present = graph.nodes.some(({ id }) => id === "critic");
  if (present === enabled) return graph;
  if (!enabled) return { ...graph, nodes: graph.nodes.filter(({ id }) => id !== "critic"), edges: graph.edges.filter(({ from, to }) => from !== "critic" && to !== "critic") };
  if (!graph.nodes.some(({ id }) => id === "planner")) throw new Error("CRITIC_REQUIRES_PLANNER");
  return { ...graph, nodes: [...graph.nodes, node("critic", "model", "Critic")], edges: [...graph.edges, { id: "planner-critic", from: "planner", to: "critic" }] };
}
