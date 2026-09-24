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
