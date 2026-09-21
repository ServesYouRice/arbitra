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
export const plannerTaskExpansionSchema = z.strictObject({ unresolvedQuestions: z.array(unresolvedQuestionSchema), task: planTaskIRSchema });
export type PlannerBrief = z.infer<typeof plannerBriefSchema>;
export type PlannerOutline = z.infer<typeof plannerOutlineSchema>;
export type PlannerTaskOutline = z.infer<typeof plannerTaskOutlineSchema>;
