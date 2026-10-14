import { z } from "zod";
import { planTaskIRSchema, requirementLinkSchema, unresolvedQuestionSchema } from "./plan.js";
import { validationAssertionSchema } from "./validation-contract.js";

const additions = z.array(z.string().trim().min(1));

/**
 * One revision call's change to a plan: the critique items it answers, the tasks it rewrites or adds in full, and
 * what it adds to the rest of the plan. Everything it does not name stays as it is, so a call writes only what it
 * changes. Observed live (P20 pilot): a patch that returned the whole plan header with its 302 open questions
 * wrote 138,000 characters again for every critique item.
 */
export const planRevisionPatchSchema = z.strictObject({
  resolutions: z.array(z.strictObject({ critiqueItemId: z.string().min(1), resolution: z.string().trim().min(1) })),
  tasks: z.array(planTaskIRSchema),
  retiredTaskIds: z.array(z.string().min(1)),
  lineage: z.array(z.strictObject({
    previousTaskId: z.string().min(1),
    nextTaskIds: z.array(z.string().min(1)),
    rationale: z.string().trim().min(1),
  })),
  addedQuestions: z.array(unresolvedQuestionSchema),
  addedValidation: z.array(validationAssertionSchema),
  /** Replaces the validation links of the issues named; issues left out keep theirs. */
  issueToValidation: z.array(z.strictObject({ issueId: z.string().min(1), validationIds: z.array(z.string().min(1)).min(1) })),
  /** Replaces the links of the requirements named (Feature plans); requirements left out keep theirs. */
  requirementLinks: z.array(requirementLinkSchema),
  planAdditions: z.strictObject({ implementationStrategy: additions, dependencies: additions, rolloutConcerns: additions, migrationConcerns: additions }),
});
export type PlanRevisionPatch = z.infer<typeof planRevisionPatchSchema>;
