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

/** arbitra sizes what it sends at one token a byte unless the run sets `estimatedBytesPerToken`. Real prompts
 * measured 1.9 to 2.4 bytes a token, so one byte a token overstates them about twice, which keeps calls small.
 * What a call must carry whole is another matter: refused at that rate it fails the run, although the provider
 * would have read it (observed live: a verification question, a planner task and a plan revision item, the last
 * two over by a few percent). Such input is admitted at this many bytes a token, about what it really is, when
 * it fits at no smaller size. */
export const REQUIRED_INPUT_BYTES_PER_TOKEN = 2;

/** Bytes counted as one token when this run sizes a call, and when it admits input a call must carry whole. */
export function inputBytesPerToken(config: RunConfig): { readonly usual: number; readonly required: number } {
  const usual = providerExecutionSchema.parse(config.workflow["modelExecution"]).estimatedBytesPerToken ?? 1;
  return { usual, required: Math.max(usual, REQUIRED_INPUT_BYTES_PER_TOKEN) };
}

/** The checking stages whose effort a run may set apart from the audit's (`stageEffort`). */
export type EffortStage = "clustering" | "peerReview" | "verification" | "planner" | "critic" | "revision";

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
  clusteringPair: 300,
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

/**
 * The provider or the model declined to answer this activity (a content filter, a policy refusal). The activity
 * is recorded as refused, so a resumed run does not ask again; a stage that can go on without this one answer
 * records the gap instead of failing the run.
 */
export class ModelRefusalError extends Error {
  constructor(readonly activityId: string, readonly refusal: string) { super(`MODEL_ACTIVITY_REFUSED:${activityId}`); this.name = "ModelRefusalError"; }
}

export function refusalKind(activityId: string): string {
  return `model-refusal-${createHash("sha256").update(activityId).digest("hex").slice(0, 32)}`;
}

/** A reply that stayed invalid after its repairs (see ModelHarness.invoke); never a provider or policy failure. */
export function isModelOutputRejection(error: unknown): boolean { return error instanceof Error && (error as { modelOutputRejected?: unknown }).modelOutputRejected === true; }

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
