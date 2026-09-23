import { z } from "zod";
import { testingPlanExecutionOptionsSchema } from "./testing-executor.js";

const text = z.string().refine((value) => value.trim().length > 0, "Expected nonempty text");
export const testCategorySchema = z.enum(["unit", "integration", "end-to-end", "contract", "authorization", "security-sensitive", "regression", "failure-path", "concurrency", "race-condition", "migration", "recovery", "retry", "idempotency", "frontend-interaction", "accessibility", "api"]);
export const testingEvidenceSchema = z.strictObject({ path: text, startLine: z.number().int().positive(), endLine: z.number().int().positive(), text });
const testingBase = {
  goal: text,
  roles: z.strictObject({ analyst: text, planner: text }),
  commands: z.array(z.strictObject({ command: text, evidence: testingEvidenceSchema })).default([]),
};
export const testingExecutionSchema = z.discriminatedUnion("mode", [
  z.strictObject({ ...testingBase, mode: z.literal("plan") }),
  z.strictObject({ ...testingBase, mode: z.literal("execute"), execution: testingPlanExecutionOptionsSchema }),
]);
export type TestingExecution = z.infer<typeof testingExecutionSchema>;
export const testingRiskSchema = z.strictObject({
  summary: text,
  surfaces: z.array(z.strictObject({ id: text, paths: z.array(text).min(1), categories: z.array(testCategorySchema).min(1), severity: z.enum(["low", "medium", "high", "critical"]), failureModes: z.array(text).min(1), evidence: z.array(testingEvidenceSchema).min(1) })),
  reviewedTestPaths: z.array(text),
  reviewedSourcePaths: z.array(text),
  limitations: z.array(text),
});
export type TestingRisk = z.infer<typeof testingRiskSchema>;
export const testingSelectionSchema = z.strictObject({
  selectedGapIds: z.array(text),
  rejected: z.array(z.strictObject({ gapId: text, reason: text })),
  limitations: z.array(text),
});
