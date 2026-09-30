import type { NodeKind } from "@arbitra/schemas/glyphs";
import type { WorkflowJson } from "./layout.js";

/**
 * Feature and Testing run their dynamic stages inside one subgraph node each. This module
 * expands such a node into the stages its run actually recorded, using only the shared six
 * node kinds. A stage appears when one of its artifacts exists; nothing is inferred from
 * configuration, so an unrecorded stage is shown as unrecorded rather than guessed.
 *
 * The expansion is a pure transform over workflow JSON, so any graph surface (including a
 * future editor) can render the same expanded structure.
 */
export interface StageDefinition { readonly id: string; readonly kind: NodeKind; readonly label: string; readonly matches: (kind: string) => boolean }
export interface RecordedStage { readonly id: string; readonly parentId: string; readonly kind: NodeKind; readonly label: string; readonly artifactKinds: readonly string[] }
export const STAGE_SEPARATOR = "::";

const exact = (...kinds: readonly string[]) => (kind: string): boolean => kinds.includes(kind);
const prefix = (...prefixes: readonly string[]) => (kind: string): boolean => prefixes.some((value) => kind.startsWith(value));
const either = (...predicates: readonly ((kind: string) => boolean)[]) => (kind: string): boolean => predicates.some((predicate) => predicate(kind));

const FEATURE_STAGES: readonly StageDefinition[] = [
  { id: "requirements", kind: "model", label: "Requirements draft", matches: either(exact("feature-requirements-context"), prefix("requirements-contract-version-")) },
  { id: "requirements-checkpoint", kind: "human", label: "Requirements checkpoint", matches: exact("requirements-checkpoint-head") },
  { id: "routing", kind: "gate", label: "Risk routing", matches: exact("feature-routing") },
  { id: "exploration", kind: "model", label: "Grounded exploration", matches: exact("feature-exploration", "feature-exploration-context") },
  { id: "review", kind: "loop", label: "Independent requirements review", matches: either(exact("feature-review-consensus", "feature-review-skipped"), prefix("feature-review-round-")) },
  { id: "requirements-revision", kind: "model", label: "Requirements revision proposal", matches: either(exact("feature-requirements-revisions"), prefix("requirements-revision-proposal-")) },
  { id: "planner", kind: "model", label: "Planner", matches: exact("feature-planner-result", "feature-planner-context") },
  { id: "critic", kind: "model", label: "Independent critic", matches: exact("feature-plan-initial-review", "feature-critic-context") },
  { id: "plan-revision", kind: "model", label: "Plan revision and re-review", matches: exact("feature-plan-revision", "feature-plan-review") },
  { id: "outcome", kind: "gate", label: "Plan gate", matches: exact("feature-outcome") },
];
const TESTING_PLAN_STAGES: readonly StageDefinition[] = [
  { id: "inventory", kind: "deterministic", label: "Test inventory", matches: exact("testing-inventory") },
  { id: "risk", kind: "model", label: "Risk analysis", matches: exact("testing-risk", "testing-risk-context") },
  { id: "selection", kind: "model", label: "Gap selection", matches: exact("testing-selection", "testing-analysis") },
  { id: "planner", kind: "model", label: "Test planner", matches: exact("testing-planner-context", "plan-ir") },
  { id: "outcome", kind: "gate", label: "Planning gate", matches: exact("testing-outcome") },
];
const TESTING_EXECUTION_STAGES: readonly StageDefinition[] = [
  { id: "binding", kind: "deterministic", label: "Authority binding", matches: exact("testing-execution-binding") },
  { id: "writers", kind: "model", label: "Leased test writers", matches: prefix("testing-writer-result-") },
  { id: "checks", kind: "deterministic", label: "Sandbox checks", matches: prefix("testing-task-verification-") },
  { id: "repair", kind: "loop", label: "Bounded repair", matches: exact("testing-repair-lineage") },
  { id: "outcome", kind: "gate", label: "Execution gate", matches: exact("testing-execution-outcome") },
  { id: "change-set", kind: "deterministic", label: "Verified change set", matches: exact("testing-execution-completion") },
];

/** Which subgraph node of which workflow expands into which stage vocabulary. */
export function stageDefinitions(workflowId: string, nodeId: string): readonly StageDefinition[] {
  if (workflowId === "feature-simple" && nodeId === "feature") return FEATURE_STAGES;
  if ((workflowId === "testing-plan" || workflowId === "testing-execute") && nodeId === "testing") return TESTING_PLAN_STAGES;
  if (workflowId === "testing-execute" && nodeId === "execute") return TESTING_EXECUTION_STAGES;
  return [];
}

/** Recorded stages per subgraph node, in execution order. Unrecorded stages are omitted. */
export function recordedStages(workflow: WorkflowJson, artifacts: readonly { readonly kind: string }[]): ReadonlyMap<string, readonly RecordedStage[]> {
  const result = new Map<string, readonly RecordedStage[]>();
  for (const node of workflow.nodes) {
    if (node.kind !== "subgraph") continue;
    const stages = stageDefinitions(workflow.id, node.id).flatMap((definition) => {
      const kinds = artifacts.map(({ kind }) => kind).filter(definition.matches);
      return kinds.length === 0 ? [] : [{ id: `${node.id}${STAGE_SEPARATOR}${definition.id}`, parentId: node.id, kind: definition.kind, label: definition.label, artifactKinds: [...new Set(kinds)].sort() }];
    });
    if (stages.length > 0) result.set(node.id, Object.freeze(stages));
  }
  return result;
}

/**
 * Replace each expanded subgraph node with its recorded stages chained in order. Edges into
 * the subgraph enter its first stage and edges out of it leave its last stage.
 */
export function expandWorkflow(workflow: WorkflowJson, stages: ReadonlyMap<string, readonly RecordedStage[]>, expanded: ReadonlySet<string>): WorkflowJson {
  const replaced = new Map([...stages].filter(([id, list]) => expanded.has(id) && list.length > 0));
  if (replaced.size === 0) return workflow;
  const nodes = workflow.nodes.flatMap((node) => {
    const list = replaced.get(node.id);
    return list === undefined ? [node] : list.map((stage) => ({ id: stage.id, kind: stage.kind, label: stage.label, config: { recordedStage: true, parentId: stage.parentId, artifactKinds: [...stage.artifactKinds] } }));
  });
  const first = (id: string): string => replaced.get(id)?.[0]?.id ?? id;
  const last = (id: string): string => replaced.get(id)?.at(-1)?.id ?? id;
  const edges = [
    ...workflow.edges.map((edge) => ({ id: edge.id, from: last(edge.from), to: first(edge.to) })),
    ...[...replaced.values()].flatMap((list) => list.slice(1).map((stage, index) => ({ id: `${list[index]?.id ?? stage.parentId}->${stage.id}`, from: list[index]?.id ?? stage.parentId, to: stage.id }))),
  ];
  return { id: workflow.id, nodes, edges };
}

export function isRecordedStage(node: WorkflowJson["nodes"][number]): boolean { return node.config?.["recordedStage"] === true; }
