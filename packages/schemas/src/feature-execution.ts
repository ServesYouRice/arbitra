import { z } from "zod";

const id = z.string().trim().min(1);
export const featureExecutionSchema = z.strictObject({
  request: z.string().trim().min(1),
  mode: z.enum(["automatic", "interactive"]),
  maximumRequirementsRevisions: z.number().int().min(0).max(3).default(1),
  roles: z.strictObject({ requirements: id, exploration: id, planner: id, critic: id.optional(), reviewers: z.array(id).default([]) }),
}).superRefine(({ roles }, context) => {
  if (new Set(roles.reviewers).size !== roles.reviewers.length) context.addIssue({ code: "custom", path: ["roles", "reviewers"], message: "Reviewer IDs must be unique" });
});
export type FeatureExecution = z.infer<typeof featureExecutionSchema>;

export const requirementsApprovalSchema = z.strictObject({ artifactId: id, ambiguityIds: z.array(id).min(1) });
