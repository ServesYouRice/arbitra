import { isContextMode, isContextTrust } from "./context-policy.js";
import type { WorkflowEdge } from "./edge-contracts.js";
import { isNodeKind } from "./node-kinds.js";
import type { GoalContract, JsonValue, WorkflowNode } from "./node-kinds.js";

export const WORKFLOW_SCHEMA_VERSION = 1 as const;

export interface WorkflowGraph {
  readonly schemaVersion: typeof WORKFLOW_SCHEMA_VERSION;
  readonly id: string;
  readonly goal: GoalContract;
  readonly entryNodeId: string;
  readonly nodes: readonly WorkflowNode[];
  readonly edges: readonly WorkflowEdge[];
}

export interface Diagnostic {
  readonly path: string;
  readonly message: string;
}

export class WorkflowValidationError extends Error {
  public readonly diagnostics: readonly Diagnostic[];

  public constructor(diagnostics: readonly Diagnostic[]) {
    super(diagnostics.map(({ path, message }) => `${path}: ${message}`).join("\n"));
    this.name = "WorkflowValidationError";
    this.diagnostics = diagnostics;
  }
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addUnknownKeyDiagnostics(
  value: UnknownRecord,
  allowed: ReadonlySet<string>,
  path: string,
  diagnostics: Diagnostic[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      diagnostics.push({ path: `${path}.${key}`, message: "Unknown field." });
    }
  }
}

function requireString(value: unknown, path: string, diagnostics: Diagnostic[]): value is string {
  if (typeof value !== "string" || value.length === 0) {
    diagnostics.push({ path, message: "Expected a non-empty string." });
    return false;
  }
  return true;
}

function requireStringArray(value: unknown, path: string, diagnostics: Diagnostic[]): value is string[] {
  if (!Array.isArray(value)) {
    diagnostics.push({ path, message: "Expected an array of strings." });
    return false;
  }
  let valid = true;
  value.forEach((entry, index) => {
    if (typeof entry !== "string") {
      diagnostics.push({ path: `${path}[${index}]`, message: "Expected a string." });
      valid = false;
    }
  });
  return valid;
}

function validateGoal(value: unknown, path: string, diagnostics: Diagnostic[]): void {
  if (!isRecord(value)) {
    diagnostics.push({ path, message: "Expected a goal object." });
    return;
  }
  addUnknownKeyDiagnostics(
    value,
    new Set(["objective", "doneWhen", "stopWhen", "blockedWhen"]),
    path,
    diagnostics,
  );
  requireString(value.objective, `${path}.objective`, diagnostics);
  requireStringArray(value.doneWhen, `${path}.doneWhen`, diagnostics);
  requireStringArray(value.stopWhen, `${path}.stopWhen`, diagnostics);
  requireStringArray(value.blockedWhen, `${path}.blockedWhen`, diagnostics);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function validateNode(value: unknown, index: number, diagnostics: Diagnostic[]): string | undefined {
  const basePath = `nodes[${index}]`;
  if (!isRecord(value)) {
    diagnostics.push({ path: basePath, message: "Expected a node object." });
    return undefined;
  }
  const nodeId = typeof value.id === "string" ? value.id : undefined;
  const path = nodeId === undefined ? basePath : `${basePath}(${nodeId})`;
  const kind = value.kind;
  const allowed = new Set(["id", "kind", "label", "goal", "config"]);
  if (kind === "loop") allowed.add("maximum");
  if (kind === "subgraph") allowed.add("purpose");
  addUnknownKeyDiagnostics(value, allowed, path, diagnostics);
  requireString(value.id, `${path}.id`, diagnostics);
  requireString(value.label, `${path}.label`, diagnostics);
  validateGoal(value.goal, `${path}.goal`, diagnostics);
  if (!isNodeKind(kind)) {
    diagnostics.push({ path: `${path}.kind`, message: `Unknown node kind ${JSON.stringify(kind)}.` });
  }
  if ("config" in value && !isRecord(value.config)) {
    diagnostics.push({ path: `${path}.config`, message: "Expected a JSON object." });
  } else if ("config" in value && !isJsonValue(value.config)) {
    diagnostics.push({ path: `${path}.config`, message: "Configuration must contain only JSON values." });
  }
  if (kind === "loop" && (!Number.isInteger(value.maximum) || (value.maximum as number) < 1)) {
    diagnostics.push({ path: `${path}.maximum`, message: "Loop maximum must be a positive integer." });
  }
  if (kind === "subgraph") {
    requireString(value.purpose, `${path}.purpose`, diagnostics);
  }
  return nodeId;
}

function validateContextPolicy(value: unknown, path: string, diagnostics: Diagnostic[]): void {
  if (!isRecord(value)) {
    diagnostics.push({ path, message: "Expected a context policy object." });
    return;
  }
  addUnknownKeyDiagnostics(value, new Set(["mode", "trust", "include", "exclude"]), path, diagnostics);
  if (!isContextMode(value.mode)) diagnostics.push({ path: `${path}.mode`, message: "Unknown context mode." });
  if (!isContextTrust(value.trust)) diagnostics.push({ path: `${path}.trust`, message: "Unknown trust level." });
  requireStringArray(value.include, `${path}.include`, diagnostics);
  requireStringArray(value.exclude, `${path}.exclude`, diagnostics);
}

function validateEdge(value: unknown, index: number, nodeIds: ReadonlySet<string>, diagnostics: Diagnostic[]): void {
  const path = `edges[${index}]`;
  if (!isRecord(value)) {
    diagnostics.push({ path, message: "Expected an edge object." });
    return;
  }
  addUnknownKeyDiagnostics(
    value,
    new Set(["id", "from", "to", "input", "prompt", "context", "output"]),
    path,
    diagnostics,
  );
  requireString(value.id, `${path}.id`, diagnostics);
  if (requireString(value.from, `${path}.from`, diagnostics) && !nodeIds.has(value.from)) {
    diagnostics.push({ path: `${path}.from`, message: `Unknown source node ${value.from}.` });
  }
  if (requireString(value.to, `${path}.to`, diagnostics) && !nodeIds.has(value.to)) {
    diagnostics.push({ path: `${path}.to`, message: `Unknown destination node ${value.to}.` });
  }
  if (!isRecord(value.input)) {
    diagnostics.push({ path: `${path}.input`, message: "Expected an input contract." });
  } else {
    addUnknownKeyDiagnostics(value.input, new Set(["artifacts"]), `${path}.input`, diagnostics);
    requireStringArray(value.input.artifacts, `${path}.input.artifacts`, diagnostics);
  }
  if (!isRecord(value.prompt)) {
    diagnostics.push({ path: `${path}.prompt`, message: "Expected a prompt contract." });
  } else {
    addUnknownKeyDiagnostics(value.prompt, new Set(["protocolLayers"]), `${path}.prompt`, diagnostics);
    requireStringArray(value.prompt.protocolLayers, `${path}.prompt.protocolLayers`, diagnostics);
  }
  if (!isRecord(value.context)) {
    diagnostics.push({ path: `${path}.context`, message: "Expected a context contract." });
  } else {
    addUnknownKeyDiagnostics(value.context, new Set(["policy", "tokenEstimate"]), `${path}.context`, diagnostics);
    validateContextPolicy(value.context.policy, `${path}.context.policy`, diagnostics);
    if (value.context.tokenEstimate !== null &&
      (!Number.isInteger(value.context.tokenEstimate) || (value.context.tokenEstimate as number) < 0)) {
      diagnostics.push({ path: `${path}.context.tokenEstimate`, message: "Expected null or a non-negative integer." });
    }
  }
  if (!isRecord(value.output)) {
    diagnostics.push({ path: `${path}.output`, message: "Expected an output contract." });
  } else {
    addUnknownKeyDiagnostics(
      value.output,
      new Set(["schema", "requiredFields", "validationBehaviour"]),
      `${path}.output`,
      diagnostics,
    );
    requireString(value.output.schema, `${path}.output.schema`, diagnostics);
    requireStringArray(value.output.requiredFields, `${path}.output.requiredFields`, diagnostics);
    if (value.output.validationBehaviour !== "strict" && value.output.validationBehaviour !== "repair_once") {
      diagnostics.push({ path: `${path}.output.validationBehaviour`, message: "Unknown validation behaviour." });
    }
  }
}

export function validateWorkflow(graph: unknown): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (!isRecord(graph)) return [{ path: "$", message: "Expected a workflow object." }];
  addUnknownKeyDiagnostics(
    graph,
    new Set(["schemaVersion", "id", "goal", "entryNodeId", "nodes", "edges"]),
    "$",
    diagnostics,
  );
  if (graph.schemaVersion !== WORKFLOW_SCHEMA_VERSION) {
    diagnostics.push({ path: "$.schemaVersion", message: `Expected schema version ${WORKFLOW_SCHEMA_VERSION}.` });
  }
  requireString(graph.id, "$.id", diagnostics);
  validateGoal(graph.goal, "$.goal", diagnostics);
  const entryNodeId = graph.entryNodeId;
  const entryValid = requireString(entryNodeId, "$.entryNodeId", diagnostics);
  const nodeIds = new Set<string>();
  if (!Array.isArray(graph.nodes)) {
    diagnostics.push({ path: "$.nodes", message: "Expected an array of nodes." });
  } else {
    graph.nodes.forEach((node, index) => {
      const id = validateNode(node, index, diagnostics);
      if (id !== undefined) {
        if (nodeIds.has(id)) diagnostics.push({ path: `nodes[${index}](${id}).id`, message: "Duplicate node id." });
        nodeIds.add(id);
      }
    });
  }
  if (entryValid && !nodeIds.has(entryNodeId)) {
    diagnostics.push({ path: "$.entryNodeId", message: `Unknown entry node ${entryNodeId}.` });
  }
  const edgeIds = new Set<string>();
  if (!Array.isArray(graph.edges)) {
    diagnostics.push({ path: "$.edges", message: "Expected an array of edges." });
  } else {
    graph.edges.forEach((edge, index) => {
      validateEdge(edge, index, nodeIds, diagnostics);
      if (isRecord(edge) && typeof edge.id === "string") {
        if (edgeIds.has(edge.id)) diagnostics.push({ path: `edges[${index}].id`, message: "Duplicate edge id." });
        edgeIds.add(edge.id);
      }
    });
  }
  return diagnostics;
}

export function parseWorkflow(json: string): WorkflowGraph {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON.";
    throw new WorkflowValidationError([{ path: "$", message }]);
  }
  const diagnostics = validateWorkflow(parsed);
  if (diagnostics.length > 0) throw new WorkflowValidationError(diagnostics);
  return parsed as WorkflowGraph;
}

export function serialiseWorkflow(graph: WorkflowGraph): string {
  const diagnostics = validateWorkflow(graph);
  if (diagnostics.length > 0) throw new WorkflowValidationError(diagnostics);
  return JSON.stringify(graph);
}
