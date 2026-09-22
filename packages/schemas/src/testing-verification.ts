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
