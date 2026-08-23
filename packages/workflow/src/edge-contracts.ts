import type { ContextPolicy } from "./context-policy.js";

export interface InputContract {
  readonly artifacts: readonly string[];
}

export interface PromptContract {
  readonly protocolLayers: readonly string[];
}

export interface ContextContract {
  readonly policy: ContextPolicy;
  readonly tokenEstimate: number | null;
}

export type ValidationBehaviour = "strict" | "repair_once";

export interface OutputContract {
  readonly schema: string;
  readonly requiredFields: readonly string[];
  readonly validationBehaviour: ValidationBehaviour;
}

/**
 * This is deliberately a closed shape. Provider continuation state belongs to
 * the provider runtime and cannot be represented on a workflow edge.
 */
export interface WorkflowEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly input: InputContract;
  readonly prompt: PromptContract;
  readonly context: ContextContract;
  readonly output: OutputContract;
}
