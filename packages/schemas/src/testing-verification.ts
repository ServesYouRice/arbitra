import { z } from "zod";
import { verificationExecutionSchema } from "./verification-execution.js";

/** Trusted execution settings. A model's command label never selects host argv. */
export const testingVerificationPolicySchema = z.strictObject({
  execution: verificationExecutionSchema,
  bindings: z.array(z.strictObject({
    command: z.string().min(1),
    checkId: z.string().min(1),
    expectedExitCode: z.number().int().min(0).max(255).default(0),
    authorization: z.enum(["repository_script", "allowlisted", "operator_approved"]),
  })).min(1),
}).superRefine((value, context) => {
  if (new Set(value.bindings.map(({ command }) => command)).size !== value.bindings.length) context.addIssue({ code: "custom", path: ["bindings"], message: "Duplicate Testing command binding" });
  if (new Set(value.bindings.map(({ checkId }) => checkId)).size !== value.bindings.length) context.addIssue({ code: "custom", path: ["bindings"], message: "Testing commands must have distinct check IDs" });
  for (const [index, binding] of value.bindings.entries()) if (!value.execution.checks.some(({ id }) => id === binding.checkId)) context.addIssue({ code: "custom", path: ["bindings", index, "checkId"], message: "Unknown configured sandbox check" });
});
export type TestingVerificationPolicy = z.infer<typeof testingVerificationPolicySchema>;

export const testingTaskVerificationSchema = z.strictObject({
  taskId: z.string().min(1), attemptId: z.string().min(1),
  taskFingerprint: z.string().regex(/^[a-f0-9]{64}$/u), policyFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  snapshotFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  status: z.enum(["passed", "failed", "incomplete"]), deterministicFailure: z.boolean(), reasons: z.array(z.string()),
  checks: z.array(z.strictObject({ command: z.string(), checkId: z.string(), executionId: z.string().nullable(), status: z.enum(["passed", "failed", "incomplete"]), expectedExitCode: z.number().int(), actualExitCode: z.number().int().nullable() })),
});
export type TestingTaskVerification = z.infer<typeof testingTaskVerificationSchema>;
