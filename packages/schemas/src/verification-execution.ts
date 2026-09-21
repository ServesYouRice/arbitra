import { z } from "zod";

const sourcePath = z.string().min(1).refine((value) => !value.includes("\\") && !value.includes(":") && !value.startsWith("/") && value.split("/").every((part) => part !== "" && part !== "." && part !== "..") && !/[\0\r\n]/u.test(value), "Expected a snapshot-relative path");
export const verificationExecutionSchema = z.strictObject({
  driver: z.literal("docker"),
  image: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:_-]*@sha256:[a-f0-9]{64}$/u),
  maximumRuns: z.number().int().min(0).max(50).default(5),
  timeoutMs: z.number().int().min(100).max(300_000).default(30_000),
  maximumOutputBytes: z.number().int().min(256).max(1_048_576).default(65_536),
  checks: z.array(z.strictObject({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u),
    sourcePaths: z.array(sourcePath).min(1),
    executable: z.string().regex(/^\/[a-zA-Z0-9_./-]+$/u),
    arguments: z.array(z.string().refine((value) => !value.includes("\0"), "NUL is forbidden")).max(100),
  })).max(50),
}).superRefine((value, context) => {
  if (new Set(value.checks.map(({ id }) => id)).size !== value.checks.length) context.addIssue({ code: "custom", path: ["checks"], message: "Duplicate verification check ID" });
});
export type VerificationExecution = z.infer<typeof verificationExecutionSchema>;
export type VerificationCheck = VerificationExecution["checks"][number];
