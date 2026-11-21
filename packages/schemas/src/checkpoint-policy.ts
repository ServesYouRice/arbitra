import { z } from "zod";

/** Checkpoint IDs are graph node IDs and appear in URLs, artifact kinds and file names. */
export const CHECKPOINT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
export const checkpointIdSchema = z.string().regex(CHECKPOINT_ID_PATTERN);

/** The closed decision vocabulary for generic `human` nodes. */
export const CHECKPOINT_DECISIONS = ["approve", "reject"] as const;
export const checkpointDecisionSchema = z.enum(CHECKPOINT_DECISIONS);
export type CheckpointDecisionValue = z.infer<typeof checkpointDecisionSchema>;

/**
 * The run-level policy for generic `human` nodes (`workflow.checkpoints`).
 *
 * `interactive` persists a pending checkpoint and blocks until an operator records a
 * decision for its current version. `automatic` never waits, but it also never invents
 * approval: every human node must have an explicit, operator-authored decision here.
 */
export const checkpointPolicySchema = z.strictObject({
  mode: z.enum(["interactive", "automatic"]),
  decisions: z.record(checkpointIdSchema, checkpointDecisionSchema).default({}),
}).superRefine((policy, context) => {
  if (policy.mode === "interactive" && Object.keys(policy.decisions).length > 0) {
    context.addIssue({ code: "custom", path: ["decisions"], message: "Preconfigured decisions apply only to automatic mode" });
  }
});
export type CheckpointPolicy = z.infer<typeof checkpointPolicySchema>;

/** Operator response to one generic checkpoint version. */
export const checkpointResponseSchema = z.strictObject({ version: z.string().regex(/^[a-f0-9]{64}$/u), decision: checkpointDecisionSchema });
export type CheckpointResponse = z.infer<typeof checkpointResponseSchema>;

/**
 * The reserved checkpoint where an interactive Audit waits for answers to its plan's blocking
 * questions. It is not a graph node, so no authored graph may use its ID.
 */
export const PLAN_QUESTIONS_CHECKPOINT_ID = "plan-questions";

/**
 * One answer: written out (`answer`), or one of the answers the checkpoint lists for the question (`choice`, its
 * index; the first is the planner's suggestion).
 */
export const planQuestionAnswerSchema = z.union([
  z.strictObject({ questionId: z.string().min(1), answer: z.string().refine((value) => value.trim().length > 0, "Expected a nonempty answer") }),
  z.strictObject({ questionId: z.string().min(1), choice: z.number().int().min(0) }),
]);

/**
 * Operator answers to every blocking question of one plan-questions version, given once. `acceptSuggested` takes the
 * suggestion of every question the checkpoint marks `acceptable` (both models proposed it, and neither rates its
 * blast radius high) that `answers` leaves out; every other question is answered in `answers`, one by one.
 */
export const planQuestionAnswersSchema = z.strictObject({
  version: z.string().regex(/^[a-f0-9]{64}$/u),
  answers: z.array(planQuestionAnswerSchema),
  acceptSuggested: z.literal(true).optional(),
}).refine((value) => value.answers.length > 0 || value.acceptSuggested === true, { path: ["answers"], message: "Expected at least one answer, or acceptSuggested" });
export type PlanQuestionAnswer = z.infer<typeof planQuestionAnswerSchema>;
export type PlanQuestionAnswers = z.infer<typeof planQuestionAnswersSchema>;
