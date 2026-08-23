import { z } from "zod";

export const VALIDATION_CONTRACT_SCHEMA_VERSION = 1 as const;

export const validationAssertionSchema = z.object({
  id: z.string().regex(/^VAL-[0-9]+$/),
  assertion: z.string().min(1),
  evidence: z.array(z.string().min(1)).min(1),
}).strict();

export const validationContractSchema = z.object({
  schemaVersion: z.literal(VALIDATION_CONTRACT_SCHEMA_VERSION),
  validation: z.array(validationAssertionSchema),
}).strict();

export type ValidationAssertion = z.infer<typeof validationAssertionSchema>;
export type ValidationContract = z.infer<typeof validationContractSchema>;
