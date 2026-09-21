import { z } from "zod";

const text = z.string().refine((value) => value.trim().length > 0, "Expected nonempty text");
export const featureReviewSchema = z.strictObject({
  summary: text,
  decisions: z.array(z.strictObject({
    requirementId: text,
    disposition: z.enum(["accept", "revise", "uncertain"]),
    reason: text,
    proposedChange: text.nullable(),
    evidence: z.array(z.strictObject({ path: text, startLine: z.number().int().positive(), endLine: z.number().int().positive(), text })),
  }).superRefine((value, context) => {
    if ((value.disposition === "revise") !== (value.proposedChange !== null)) context.addIssue({ code: "custom", path: ["proposedChange"], message: "Only revision decisions must include a proposed change" });
  })),
  limitations: z.array(text),
}).superRefine((value, context) => {
  if (new Set(value.decisions.map(({ requirementId }) => requirementId)).size !== value.decisions.length) context.addIssue({ code: "custom", path: ["decisions"], message: "Requirement decisions must be unique" });
});
export type FeatureReview = z.infer<typeof featureReviewSchema>;
