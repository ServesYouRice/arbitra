import { z } from "zod";

/**
 * An explicit, opt-in request to audit a changed snapshot incrementally against a
 * completed earlier Audit run. Nothing is reused without it.
 */
export const incrementalAuditSchema = z.strictObject({
  baseRunId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
});

export type IncrementalAuditRequest = z.infer<typeof incrementalAuditSchema>;
