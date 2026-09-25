import { validateGraphCheckpoints, type GatePolicyRegistry } from "@arbitra/core/runner/graph-checkpoints.js";
import type { RunnerGraph } from "@arbitra/core/runner/workflow-runner.js";
import { CHECKPOINT_ID_PATTERN } from "@arbitra/schemas/checkpoint-policy.js";
import { checkpointPolicySchema } from "@arbitra/schemas/checkpoint-policy.js";
import type { RunConfig } from "@arbitra/schemas/config.js";
import { providerExecutionSchema } from "@arbitra/schemas/provider-execution.js";
import { WORKFLOW_GRAPH_AUTHORIZATIONS, WORKFLOW_GRAPH_ID_PATTERN, type WorkflowGraphAuthorization, type WorkflowGraphDiagnostic } from "@arbitra/schemas/workflow-graphs.js";
import { validateWorkflow, type WorkflowGraph } from "@arbitra/workflow/graph-schema.js";
import { validateGraphStructure } from "@arbitra/workflow/graph-structure.js";
import type { WorkflowEdge } from "@arbitra/workflow/edge-contracts.js";
import type { WorkflowNode } from "@arbitra/workflow/node-kinds.js";
import { WorkflowGraphStore } from "@arbitra/persistence/workflow-graph-store.js";
import { DEFAULT_AUDITORS } from "./auditors.js";
import { PRESET_GRAPHS } from "./graphs.js";

/**
 * The authoritative validator for operator-authored graphs.
 *
 * An authored graph uses the shared workflow schema, the six node kinds and the edge and
 * context contracts, and it executes through the one shared runner with the Audit
 * executors. So beyond shape it must be executable by them: acyclic and reachable, with
 * iteration only as a bounded `loop` node, stages ordered the way their artifacts flow,
 * every model role bound in the run configuration, and gate/human nodes backed by a
 * registered gate policy and the run's checkpoint policy (P09).
 *
 * Changes to control-plane protocol sources, write authority, Testing execution and the
 * shipped preset IDs are privileged. They are rejected unless the operator authorizes
 * that category explicitly; an authorization lets the graph be saved and dispatched but
 * never grants a run authority it does not already have from its own configuration.
 */

/** Consensus rounds are capped at three by the run configuration schema. */
export const MAXIMUM_LOOP_ITERATIONS = 3;

export interface PrivilegedChange { readonly category: WorkflowGraphAuthorization; readonly path: string; readonly message: string }

export interface AuthoredGraphValidation {
  readonly valid: boolean;
  /** The content address the graph is (or would be) saved under; null when it is not a graph. */
  readonly version: string | null;
  readonly diagnostics: readonly WorkflowGraphDiagnostic[];
  readonly privileged: readonly PrivilegedChange[];
  /** Whether model-role and checkpoint-policy checks ran against a run configuration. */
  readonly configurationChecked: boolean;
}

export interface AuthoredGraphOptions {
  readonly gatePolicies: GatePolicyRegistry;
  readonly authorize: readonly WorkflowGraphAuthorization[];
  /** IDs an authored graph may not reuse without `shipped_preset_id`. */
  readonly reservedIds: readonly string[];
  readonly configuration?: RunConfig;
}

const AUDITOR_ID = /^auditor-[a-z0-9][a-z0-9-]{0,63}$/u;
const CONTROL_PLANE_KEYS = /^(protocol|protocols|protocolSource|protocolSources|protocolOverride|protocolOverrides|controlPlane)$/iu;
const WRITE_KEYS = /^(write|writes|writeAuthority|allowWrites|authorization|authorizations|apply|applyChanges)$/iu;
const TESTING_KEYS = /^(testing|testingExecution|execution|sandbox)$/iu;

export function validateAuthoredGraph(value: unknown, options: AuthoredGraphOptions): AuthoredGraphValidation {
  const schema = validateWorkflow(value).map(({ path, message }) => ({ code: "SCHEMA", path, message }));
  if (schema.length > 0) return freeze({ valid: false, version: null, diagnostics: schema, privileged: [], configurationChecked: false });
  const graph = value as WorkflowGraph;
  const diagnostics: WorkflowGraphDiagnostic[] = [];
  if (!WORKFLOW_GRAPH_ID_PATTERN.test(graph.id)) diagnostics.push({ code: "INVALID_GRAPH_ID", path: "$.id", message: "Graph IDs are 1-128 letters, digits, '.', '_' or '-', starting with a letter or digit." });
  graph.nodes.forEach((node, index) => {
    if (!CHECKPOINT_ID_PATTERN.test(node.id)) diagnostics.push({ code: "INVALID_NODE_ID", path: `${nodePath(node, index)}.id`, message: "Node IDs name artifacts and checkpoints: letters, digits, '.', '_' or '-'." });
  });
  diagnostics.push(...validateGraphStructure(graph, { maximumLoopIterations: MAXIMUM_LOOP_ITERATIONS }));
  diagnostics.push(...auditDispatchContract(graph));
  diagnostics.push(...checkpointContract(graph, options));
  if (options.configuration !== undefined) diagnostics.push(...modelRoles(graph, options.configuration));
  const privileged = privilegedChanges(graph, options.reservedIds);
  for (const change of privileged) {
    if (!options.authorize.includes(change.category)) diagnostics.push({ code: "UNAUTHORIZED_CHANGE", path: change.path, message: `${change.message} Requires the explicit ${change.category} authorization.` });
  }
  return freeze({ valid: diagnostics.length === 0, version: WorkflowGraphStore.versionOf(graph), diagnostics, privileged, configurationChecked: options.configuration !== undefined });
}

/** The graph the runner executes is the saved graph itself, contracts included. */
export function runnerGraphOf(graph: WorkflowGraph): RunnerGraph { return graph as unknown as RunnerGraph; }

/**
 * An editable starting point for each shipped preset. The template keeps the preset's
 * nodes and edges and adds the goal and contract fields the authored schema requires.
 * It keeps the preset ID, so saving it unchanged is refused as a shipped-preset change.
 */
export function authoredTemplates(): readonly WorkflowGraph[] {
  return Object.freeze(["audit-deep", "audit-balanced", "diff-review", "diff-fast"].map((id) => templateOf(PRESET_GRAPHS[id] as RunnerGraph)));
}

export function templateOf(preset: RunnerGraph): WorkflowGraph {
  const goal = (objective: string) => ({ objective, doneWhen: [], stopWhen: [], blockedWhen: [] });
  return {
    schemaVersion: 1, id: preset.id, goal: goal(`Audit the repository with the ${preset.id} graph`), entryNodeId: preset.entryNodeId,
    nodes: preset.nodes.map((node): WorkflowNode => {
      const base = { id: node.id, label: node.label, goal: goal(node.label), ...(node.config === undefined ? {} : { config: node.config }) };
      if (node.kind === "loop") return { ...base, kind: "loop", maximum: node.maximum ?? MAXIMUM_LOOP_ITERATIONS };
      if (node.kind === "subgraph") return { ...base, kind: "subgraph", purpose: node.purpose ?? node.label };
      return { ...base, kind: node.kind };
    }),
    edges: preset.edges.map((edge) => defaultEdge(edge.id, edge.from, edge.to)),
  };
}

export function defaultEdge(id: string, from: string, to: string): WorkflowEdge {
  return { id, from, to, input: { artifacts: [] }, prompt: { protocolLayers: [] },
    context: { policy: { mode: "selected_artifacts", trust: "derived", include: [], exclude: [] }, tokenEstimate: null },
    output: { schema: "json", requiredFields: [], validationBehaviour: "strict" } };
}

/** The effective consensus rounds: the configuration's limit, capped by the loop's explicit maximum. */
export function boundedRounds(graph: RunnerGraph, configured: number): number {
  const loop = graph.nodes.find(({ kind }) => kind === "loop");
  return loop?.maximum === undefined ? configured : Math.min(configured, loop.maximum);
}

/**
 * The Audit executors hand stages off through named artifacts, so the graph must order
 * the stages the way those artifacts flow: preflight at the entry, every auditor before
 * the one consensus loop, verification after it, the planner after verification and the
 * critic after the planner.
 */
function auditDispatchContract(graph: WorkflowGraph): WorkflowGraphDiagnostic[] {
  const diagnostics: WorkflowGraphDiagnostic[] = [];
  const indexed = graph.nodes.map((node, index) => ({ node, index }));
  const ancestors = ancestorsOf(graph);
  const upstream = (target: string, source: string): boolean => ancestors.get(target)?.has(source) === true;
  const entry = graph.nodes.find(({ id }) => id === graph.entryNodeId);
  if (entry !== undefined && entry.kind !== "deterministic") diagnostics.push({ code: "ENTRY_NOT_DETERMINISTIC", path: "$.entryNodeId", message: "The entry node must be the deterministic preflight node." });
  for (const { node, index } of indexed) {
    if (node.kind === "deterministic" && node.id !== graph.entryNodeId) diagnostics.push({ code: "UNSUPPORTED_NODE", path: nodePath(node, index), message: `Audit dispatch runs a deterministic node only as the entry preflight; ${node.id} has no executor.` });
    if (node.kind === "model" && !AUDITOR_ID.test(node.id) && node.id !== "planner" && node.id !== "critic") diagnostics.push({ code: "UNKNOWN_MODEL_ROLE", path: `${nodePath(node, index)}.id`, message: `Model node ${node.id} names no model role; use auditor-<name>, planner or critic.` });
  }
  const auditors = indexed.filter(({ node }) => node.kind === "model" && AUDITOR_ID.test(node.id));
  const loops = indexed.filter(({ node }) => node.kind === "loop");
  const subgraphs = indexed.filter(({ node }) => node.kind === "subgraph");
  const planner = indexed.find(({ node }) => node.kind === "model" && node.id === "planner");
  const critic = indexed.find(({ node }) => node.kind === "model" && node.id === "critic");
  if (auditors.length === 0) diagnostics.push({ code: "AUDITOR_REQUIRED", path: "$.nodes", message: "At least one auditor model node (auditor-<name>) is required." });
  if (loops.length !== 1) diagnostics.push({ code: "CONSENSUS_LOOP_REQUIRED", path: "$.nodes", message: `Exactly one loop node runs consensus; found ${loops.length}.` });
  if (subgraphs.length !== 1) diagnostics.push({ code: "VERIFICATION_SUBGRAPH_REQUIRED", path: "$.nodes", message: `Exactly one subgraph node runs verification; found ${subgraphs.length}.` });
  const [loop] = loops; const [verification] = subgraphs;
  if (loops.length === 1 && loop !== undefined) for (const { node } of auditors) {
    if (!upstream(loop.node.id, node.id)) diagnostics.push({ code: "EDGE_CONTRACT_UNSATISFIED", path: nodePath(loop.node, loop.index), message: `Consensus ${loop.node.id} reads findings from ${node.id}, which is not upstream of it.` });
  }
  if (loop !== undefined && verification !== undefined && subgraphs.length === 1 && !upstream(verification.node.id, loop.node.id)) diagnostics.push({ code: "EDGE_CONTRACT_UNSATISFIED", path: nodePath(verification.node, verification.index), message: `Verification ${verification.node.id} reads consensus state from ${loop.node.id}, which is not upstream of it.` });
  if (planner !== undefined && verification !== undefined && !upstream(planner.node.id, verification.node.id)) diagnostics.push({ code: "EDGE_CONTRACT_UNSATISFIED", path: nodePath(planner.node, planner.index), message: `The planner reads canonical issues from ${verification.node.id}, which is not upstream of it.` });
  if (critic !== undefined && (planner === undefined || !upstream(critic.node.id, planner.node.id))) diagnostics.push({ code: "EDGE_CONTRACT_UNSATISFIED", path: nodePath(critic.node, critic.index), message: "The critic reads the plan, so the planner must be upstream of it." });
  return diagnostics;
}

/** Gate and human nodes use the generic P09 checks; human policy needs a configuration. */
function checkpointContract(graph: WorkflowGraph, options: AuthoredGraphOptions): WorkflowGraphDiagnostic[] {
  const diagnostics: WorkflowGraphDiagnostic[] = [];
  const runner = runnerGraphOf(graph);
  const policy = options.configuration?.workflow["checkpoints"] === undefined ? undefined : checkpointPolicySchema.safeParse(options.configuration.workflow["checkpoints"]).data;
  graph.nodes.forEach((node, index) => {
    if (node.kind !== "gate" && (node.kind !== "human" || options.configuration === undefined)) return;
    // Each node is checked alone so every failure is reported at its own node.
    const own = policy === undefined || node.kind === "gate" ? undefined : { ...policy, decisions: Object.fromEntries(Object.entries(policy.decisions).filter(([id]) => id === node.id)) };
    const failure = checkpointFailure({ ...runner, nodes: [runner.nodes[index] as RunnerGraph["nodes"][number]] }, own, options.gatePolicies);
    if (failure !== null) diagnostics.push({ code: failure.code, path: nodePath(node, index), message: failure.message });
  });
  if (diagnostics.length === 0 && options.configuration !== undefined) {
    const failure = checkpointFailure(runner, policy, options.gatePolicies);
    if (failure !== null) diagnostics.push({ code: failure.code, path: "$.nodes", message: failure.message });
  }
  return diagnostics;
}

function checkpointFailure(graph: RunnerGraph, policy: ReturnType<typeof checkpointPolicySchema.parse> | undefined, gatePolicies: GatePolicyRegistry): { code: string; message: string } | null {
  try { validateGraphCheckpoints(graph, policy, gatePolicies); return null; }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.split(":")[0] ?? "CHECKPOINT_POLICY_INVALID";
    const explained: Readonly<Record<string, string>> = {
      GATE_POLICY_REQUIRED: "A gate node must name a registered deterministic policy in config.policy.",
      UNKNOWN_GATE_POLICY: "The gate names a policy that is not registered.",
      CHECKPOINT_POLICY_REQUIRED: "A human node needs the run configuration's workflow.checkpoints policy.",
      AUTOMATIC_CHECKPOINT_DECISION_REQUIRED: "An automatic checkpoint policy needs an explicit operator decision for every human node.",
      UNKNOWN_CHECKPOINT_NODE: "The checkpoint policy decides a human node this graph does not contain.",
    };
    return { code, message: `${explained[code] ?? "Invalid checkpoint configuration."} (${message})` };
  }
}

/** Every model node's role must be bound to a profile (or a scripted auditor) in the configuration. */
function modelRoles(graph: WorkflowGraph, config: RunConfig): WorkflowGraphDiagnostic[] {
  const diagnostics: WorkflowGraphDiagnostic[] = [];
  if (config.mode !== "audit") return [{ code: "CONFIGURATION_MODE_UNSUPPORTED", path: "$", message: `Saved workflow graphs run in audit mode; the configuration is ${config.mode}.` }];
  const scripted = Object.keys(config.models).length === 0;
  const roles = scripted ? undefined : providerExecutionSchema.safeParse(config.workflow["modelExecution"]).data?.roles;
  graph.nodes.forEach((node, index) => {
    if (node.kind !== "model") return;
    const missing = (message: string) => diagnostics.push({ code: "MODEL_ROLE_UNAVAILABLE", path: nodePath(node, index), message });
    if (AUDITOR_ID.test(node.id)) {
      if (scripted && !DEFAULT_AUDITORS.some(({ auditorId }) => auditorId === node.id)) missing(`${node.id} has no scripted auditor, and the configuration binds no models.`);
      if (!scripted && !Object.hasOwn(config.models, node.id)) missing(`${node.id} has no model profile in the configuration.`);
      return;
    }
    if (scripted || (node.id !== "planner" && node.id !== "critic")) return;
    const profile = roles?.[node.id];
    if (profile === undefined || !Object.hasOwn(config.models, profile)) missing(`The ${node.id} role is not bound to a model profile in workflow.modelExecution.roles.`);
  });
  return diagnostics;
}

function privilegedChanges(graph: WorkflowGraph, reservedIds: readonly string[]): PrivilegedChange[] {
  const changes: PrivilegedChange[] = [];
  if (reservedIds.includes(graph.id)) changes.push({ category: "shipped_preset_id", path: "$.id", message: `The graph reuses the shipped preset ID ${graph.id}.` });
  graph.edges.forEach((edge, index) => {
    if (edge.prompt.protocolLayers.length > 0) changes.push({ category: "control_plane", path: `edges[${index}](${edge.id}).prompt.protocolLayers`, message: `Edge ${edge.id} composes control-plane protocol layers.` });
  });
  graph.nodes.forEach((node, index) => {
    if (node.id === "execute") changes.push({ category: "testing_execution", path: `${nodePath(node, index)}.id`, message: "The node ID execute names Testing execution." });
    for (const key of configKeys(node.config ?? {})) {
      const path = `${nodePath(node, index)}.config.${key.path}`;
      if (CONTROL_PLANE_KEYS.test(key.name)) changes.push({ category: "control_plane", path, message: `Node ${node.id} sets a control-plane protocol source.` });
      if (WRITE_KEYS.test(key.name)) changes.push({ category: "write_authority", path, message: `Node ${node.id} sets write authority.` });
      if (TESTING_KEYS.test(key.name)) changes.push({ category: "testing_execution", path, message: `Node ${node.id} configures Testing execution.` });
    }
  });
  return changes.filter((change) => (WORKFLOW_GRAPH_AUTHORIZATIONS as readonly string[]).includes(change.category));
}

function configKeys(value: unknown, prefix = ""): { name: string; path: string }[] {
  if (typeof value !== "object" || value === null) return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => configKeys(item, `${prefix}[${index}]`));
  return Object.entries(value).flatMap(([name, child]) => {
    const path = prefix === "" ? name : `${prefix}.${name}`;
    return [{ name, path }, ...configKeys(child, path)];
  });
}

function ancestorsOf(graph: WorkflowGraph): ReadonlyMap<string, ReadonlySet<string>> {
  const incoming = new Map<string, string[]>(graph.nodes.map(({ id }) => [id, []]));
  for (const edge of graph.edges) incoming.get(edge.to)?.push(edge.from);
  const result = new Map<string, Set<string>>();
  for (const { id } of graph.nodes) {
    const seen = new Set<string>();
    const queue = [...(incoming.get(id) ?? [])];
    while (queue.length > 0) {
      const next = queue.shift() as string;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...(incoming.get(next) ?? []));
    }
    result.set(id, seen);
  }
  return result;
}

function nodePath(node: WorkflowNode, index: number): string { return `nodes[${index}](${node.id})`; }

function freeze(value: AuthoredGraphValidation): AuthoredGraphValidation {
  return Object.freeze({ ...value, diagnostics: Object.freeze(value.diagnostics.map((item) => Object.freeze({ ...item }))), privileged: Object.freeze(value.privileged.map((item) => Object.freeze({ ...item }))) });
}
