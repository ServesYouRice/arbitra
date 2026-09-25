import { createHash } from "node:crypto";
import type { RunConfig } from "@arbitra/schemas/config.js";
import { providerExecutionSchema } from "@arbitra/schemas/provider-execution.js";

/** Input and output capacity for one model stage. Input admission reserves the full
 * output allowance (see ModelHarness.estimateInitialTokens); output capacity bounds how
 * many per-record decisions a single structured response may be asked to carry. */
export interface StageBudget { readonly maximumInputTokens: number; readonly outputCapacity: number }

export function stageBudget(config: RunConfig, modelProfileId: string): StageBudget {
  const execution = providerExecutionSchema.parse(config.workflow["modelExecution"]);
  const profile = Object.hasOwn(config.models, modelProfileId) ? config.models[modelProfileId] : undefined;
  const context = Math.min(execution.maximumContextTokens ?? 128_000, profile?.limits.contextTokens ?? Number.POSITIVE_INFINITY);
  return { maximumInputTokens: Math.floor(context * 0.8), outputCapacity: Math.min(execution.maximumOutputTokens, profile?.limits.maxOutputTokens ?? Number.POSITIVE_INFINITY) };
}

/** Conservative output reserves for stages that must emit one decision per supplied
 * record. They size batches before spend; truncation is still detected afterwards. */
export const OUTPUT_TOKENS_PER_RECORD = Object.freeze({
  peerReviewCandidate: 160,
  criticRecord: 60,
  plannerBriefIssue: 400,
  testingSelectionCandidate: 120,
  featureReviewRequirement: 150,
  testingRiskPath: 250,
  requirementsRecord: 200,
  featureExplorationRequirement: 300,
});

export function outputRecordLimit(outputCapacity: number, tokensPerRecord: number, stage: string): number {
  const limit = Math.floor(outputCapacity / tokensPerRecord);
  if (!Number.isFinite(limit) || limit < 1) throw new Error(`MODEL_OUTPUT_CAPACITY_INSUFFICIENT:${stage}:${outputCapacity}<${tokensPerRecord}`);
  return limit;
}

/** A provider stopped this activity at its output ceiling. The activity is recorded as
 * output-limited so resumed composition splits it instead of repeating the spend. */
export class ModelOutputLimitError extends Error {
  constructor(readonly activityId: string) { super(`MODEL_OUTPUT_LIMIT_REACHED:${activityId}`); this.name = "ModelOutputLimitError"; }
}

export function outputLimitKind(activityId: string): string {
  return `model-output-limit-${createHash("sha256").update(activityId).digest("hex").slice(0, 32)}`;
}

/** Errors that mean "this stage shape cannot be admitted"; composition may split it. */
export function isCapacityError(error: unknown): boolean {
  return error instanceof ModelOutputLimitError || error instanceof Error && error.message === "MODEL_REQUIRED_CONTEXT_LIMIT_EXCEEDED";
}

/** Re-run a deterministic composition after an output-limited activity. Completed model
 * activities are durable, so replanning reuses them; each retry retires one more activity. */
export async function replanOnOutputLimit<T>(run: () => Promise<T>, maximumReplans = 64): Promise<T> {
  const retired = new Set<string>();
  for (;;) {
    try { return await run(); }
    catch (error) {
      if (!(error instanceof ModelOutputLimitError) || retired.has(error.activityId) || retired.size >= maximumReplans) throw error;
      retired.add(error.activityId);
    }
  }
}
