import { z } from "zod";

const text = z.string().refine((value) => value.trim().length > 0, "Expected nonempty text");

/**
 * Operator-supplied advisor policy. A planner-authored Task IR may request an advisor
 * tier and a maximum number of uses; this policy decides whether that request can be
 * served at all and caps every limit. Advisors never receive tools: they return
 * advisory data only, and nothing in advice can change authority, scope or budgets.
 */
export const advisorPolicySchema = z.strictObject({
  /** Model profile per requested advisor tier. An unlisted tier is not served. */
  models: z.strictObject({ fast: text.optional(), balanced: text.optional(), frontier: text.optional() }),
  /** Hard operator cap. The effective limit is min(task.routing.advisorMaxUses, this). */
  maximumUsesPerTask: z.number().int().min(0).max(8),
  /** Admission estimate limit for one advisor request, including its output reserve. */
  maximumContextTokens: z.number().int().positive(),
  maximumOutputTokens: z.number().int().positive(),
  /** Per-task cap. Unknown usage is charged at its admission estimate, never zero. */
  maximumTokensPerTask: z.number().int().positive(),
}).superRefine((value, context) => {
  if (value.maximumContextTokens <= value.maximumOutputTokens) context.addIssue({ code: "custom", path: ["maximumContextTokens"], message: "Advisor context must leave room beyond the output reserve" });
  if (value.maximumTokensPerTask < value.maximumContextTokens && value.maximumUsesPerTask > 0) context.addIssue({ code: "custom", path: ["maximumTokensPerTask"], message: "Per-task advisor budget cannot admit one advisor request" });
});
export type AdvisorPolicy = z.infer<typeof advisorPolicySchema>;

/** Structured advice. `action` lets the runtime detect contradictory advice deterministically. */
export const advisorAdviceSchema = z.strictObject({
  summary: text,
  recommendations: z.array(z.strictObject({
    id: text,
    action: z.enum(["add_test", "modify_test", "avoid", "investigate"]),
    paths: z.array(text).max(20),
    text,
  })).max(20),
  risks: z.array(text).max(20),
  confidence: z.enum(["low", "medium", "high"]),
});
export type AdvisorAdvice = z.infer<typeof advisorAdviceSchema>;
