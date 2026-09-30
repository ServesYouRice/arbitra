import { z } from "zod";
import { requirementBehaviourConflictSchema } from "./documented-behaviour.js";

const text = z.string().refine((value) => value.trim().length > 0, "Expected nonempty text");
const line = z.number().int().positive();
/** Evidence quotes repository lines, or the request with a null path and null lines (observed live:
 * reviewers quoted the request that way, and a line-only schema refused every repair). */
const evidence = z.strictObject({ path: text.nullable(), startLine: line.nullable(), endLine: line.nullable(), text }).superRefine((value, context) => {
  if ((value.path === null) !== (value.startLine === null) || (value.path === null) !== (value.endLine === null)) context.addIssue({ code: "custom", path: ["path"], message: "A repository quotation needs path, startLine and endLine; a quotation of the request has all three null" });
});
export const featureReviewSchema = z.strictObject({
  summary: text,
  decisions: z.array(z.strictObject({
    requirementId: text,
    disposition: z.enum(["accept", "revise", "uncertain"]),
    reason: text,
    proposedChange: text.nullable(),
    evidence: z.array(evidence),
  }).superRefine((value, context) => {
    if ((value.disposition === "revise") !== (value.proposedChange !== null)) context.addIssue({ code: "custom", path: ["proposedChange"], message: "Only revision decisions must include a proposed change" });
  })),
  limitations: z.array(text),
  documentedBehaviourConflicts: z.array(requirementBehaviourConflictSchema).default([]),
}).superRefine((value, context) => {
  // Naming the repeated IDs lets a repair fix them (observed live: a reviewer repeated one decision through every repair).
  const ids = value.decisions.map(({ requirementId }) => requirementId);
  const repeated = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (repeated.length > 0) context.addIssue({ code: "custom", path: ["decisions"], message: `Requirement decisions must be unique; decided more than once: ${repeated.join(", ")}` });
});
export type FeatureReview = z.infer<typeof featureReviewSchema>;
