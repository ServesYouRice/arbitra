import { z } from "zod";
import { testingVerificationPolicySchema } from "./testing-verification.js";

const text = z.string().refine((value) => value.trim().length > 0, "Expected nonempty text");
/** Operator-supplied authority, never inferred from a model's proposed plan. The
 * security boundary additionally validates portable paths and all plan scopes. */
export const testingWriteAuthorizationSchema = z.strictObject({
  maximumParallelTasks: z.number().int().min(1).max(16),
  partitions: z.array(z.strictObject({ id: text, paths: z.array(text).min(1) })).min(1),
  tasks: z.array(z.strictObject({ taskId: text, partitionId: text, exclusive: z.boolean() })).min(1),
}).superRefine((value, context) => {
  const ids = new Set(value.partitions.map(({ id }) => id));
  if (ids.size !== value.partitions.length) context.addIssue({ code: "custom", path: ["partitions"], message: "Duplicate write partition ID" });
  if (new Set(value.tasks.map(({ taskId }) => taskId)).size !== value.tasks.length) context.addIssue({ code: "custom", path: ["tasks"], message: "Duplicate write task ID" });
  for (const [index, task] of value.tasks.entries()) if (!ids.has(task.partitionId)) context.addIssue({ code: "custom", path: ["tasks", index, "partitionId"], message: "Unknown write partition" });
});

export const testingPlanExecutionOptionsSchema = z.strictObject({
  authorization: testingWriteAuthorizationSchema,
  verification: testingVerificationPolicySchema,
  models: z.strictObject({ fast: text, balanced: text, frontier: text }),
  maximumAttempts: z.number().int().min(1).max(10),
});
export type TestingPlanExecutionOptions = z.infer<typeof testingPlanExecutionOptionsSchema>;
