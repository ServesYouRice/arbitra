import { z } from "zod";
import { planIRSchema, planTaskIRSchema } from "./plan.js";

/** An atomic revision to selected tasks plus the complete global plan metadata. */
export const planRevisionPatchSchema = z.strictObject({
  critiqueItemId: z.string().min(1),
  resolution: z.string().trim().min(1),
  globalPlan: planIRSchema.omit({ tasks: true }),
  tasks: z.array(planTaskIRSchema),
  retiredTaskIds: z.array(z.string().min(1)),
  lineage: z.array(z.strictObject({
    previousTaskId: z.string().min(1),
    nextTaskIds: z.array(z.string().min(1)),
    rationale: z.string().trim().min(1),
  })),
});
export type PlanRevisionPatch = z.infer<typeof planRevisionPatchSchema>;
