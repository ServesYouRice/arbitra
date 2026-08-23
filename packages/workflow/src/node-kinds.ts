export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface GoalContract {
  readonly objective: string;
  readonly doneWhen: readonly string[];
  readonly stopWhen: readonly string[];
  readonly blockedWhen: readonly string[];
}

interface BaseWorkflowNode {
  readonly id: string;
  readonly label: string;
  readonly goal: GoalContract;
  readonly config?: Readonly<Record<string, JsonValue>>;
}

export interface DeterministicNode extends BaseWorkflowNode {
  readonly kind: "deterministic";
}

export interface ModelNode extends BaseWorkflowNode {
  readonly kind: "model";
}

export interface GateNode extends BaseWorkflowNode {
  readonly kind: "gate";
}

export interface LoopNode extends BaseWorkflowNode {
  readonly kind: "loop";
  readonly maximum: number;
}

export interface HumanNode extends BaseWorkflowNode {
  readonly kind: "human";
}

export interface SubgraphNode extends BaseWorkflowNode {
  readonly kind: "subgraph";
  readonly purpose: string;
}

export type WorkflowNode =
  | DeterministicNode
  | ModelNode
  | GateNode
  | LoopNode
  | HumanNode
  | SubgraphNode;

export function isNodeKind(value: unknown): value is WorkflowNode["kind"] {
  switch (value) {
    case "deterministic":
    case "model":
    case "gate":
    case "loop":
    case "human":
    case "subgraph":
      return true;
    default:
      return false;
  }
}
