import { z } from "zod";
import { planIRSchema, planTaskIRSchema, unresolvedQuestionSchema } from "./plan.js";

/** Intermediate records for one selected planner, never independently executable plans. */
export const plannerBriefSchema = z.strictObject({ issues: z.array(z.strictObject({
  issueId: z.string().min(1),
  summary: z.string().min(1).max(2000),
  affectedPaths: z.array(z.string().min(1)),
  behavioralAssertions: z.array(z.string().min(1).max(1000)).min(1),
  integrationConstraints: z.array(z.string().min(1).max(1000)),
  unresolvedQuestions: z.array(unresolvedQuestionSchema),
})) });

export const plannerTaskOutlineSchema = planTaskIRSchema.pick({
  id: true, title: true, goal: true, addresses: true, routing: true, dependencies: true, scope: true,
});
export const plannerOutlineSchema = planIRSchema.extend({ tasks: z.array(plannerTaskOutlineSchema) }).strict();
/** Hierarchical outline: sections are plannerOutlineSchema-shaped over a subset of records;
 * one header pass and cross-section link passes merge them into the single global outline. */
export const plannerOutlineHeaderSchema = planIRSchema.pick({ id: true, title: true, reasoningOutcome: true, implementationStrategy: true, dependencies: true, rolloutConcerns: true, migrationConcerns: true }).strict();
export const plannerOutlineLinksSchema = z.strictObject({ dependencies: z.array(z.strictObject({ from: z.string().min(1), to: z.string().min(1), reason: z.string().min(1).max(1000) })) });
export const plannerTaskExpansionSchema = z.strictObject({ unresolvedQuestions: z.array(unresolvedQuestionSchema), task: planTaskIRSchema });
export type PlannerBrief = z.infer<typeof plannerBriefSchema>;
export type PlannerOutline = z.infer<typeof plannerOutlineSchema>;
export type PlannerOutlineHeader = z.infer<typeof plannerOutlineHeaderSchema>;
export type PlannerOutlineLinks = z.infer<typeof plannerOutlineLinksSchema>;
export type PlannerTaskOutline = z.infer<typeof plannerTaskOutlineSchema>;
