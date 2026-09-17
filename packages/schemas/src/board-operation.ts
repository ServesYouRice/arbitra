import { z } from "zod";

const id = z.string().trim().min(1);
export const boardSeveritySchema = z.enum(["critical", "high", "medium", "low", "informational"]);
export const boardEvidenceSchema = z.object({ id, text: z.string().min(1), locationIds: z.array(id).min(1) }).strict();
export const boardCandidateSeedSchema = z.object({
  candidateId: id, title: z.string().trim().min(1), description: z.string().trim().min(1),
  sourceFindingIds: z.array(id).min(1), severity: boardSeveritySchema, blocker: z.boolean(),
}).strict();

const base = { operationId: id, candidateId: id, authorId: id, round: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), citedEvidenceIds: z.array(id) };
const reason = z.string().trim().min(1);
export const boardVerificationSchema = z.object({
  result: z.enum(["CONFIRMED", "REJECTED", "STILL_NEEDS_VERIFICATION"]),
  method: z.enum(["cited_lines", "symbol_or_call_path", "route_config_middleware", "dependency_or_import_path", "allowlisted_safe_test", "bounded_deterministic_check", "single_model_question"]),
  evidenceIds: z.array(id), artifactRefs: z.array(id), toolCallIds: z.array(id), activityId: id,
  confidence: z.number().min(0).max(1).nullable(),
}).strict();
export type BoardVerification = z.infer<typeof boardVerificationSchema>;

/** Canonical append-only board operations, distinct from legacy UI event envelopes. */
export const boardOperationSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("add_candidate"), candidate: boardCandidateSeedSchema }).strict(),
  z.object({ ...base, type: z.literal("add_missing_finding"), candidate: boardCandidateSeedSchema, evidence: z.array(boardEvidenceSchema).min(1) }).strict(),
  z.object({ ...base, type: z.literal("accept"), reason, verification: boardVerificationSchema.optional() }).strict(),
  z.object({ ...base, type: z.literal("reject"), reason, verification: boardVerificationSchema.optional() }).strict(),
  z.object({ ...base, type: z.literal("needs_verification"), reason, verification: boardVerificationSchema.optional() }).strict(),
  z.object({ ...base, type: z.literal("merge"), sourceCandidateIds: z.array(id).min(2), candidate: boardCandidateSeedSchema }).strict(),
  z.object({ ...base, type: z.literal("split"), candidates: z.array(boardCandidateSeedSchema).min(2), reason }).strict(),
  z.object({ ...base, type: z.literal("add_evidence"), evidence: boardEvidenceSchema }).strict(),
  z.object({ ...base, type: z.literal("add_counter_evidence"), evidence: boardEvidenceSchema }).strict(),
  z.object({ ...base, type: z.literal("change_severity"), severity: boardSeveritySchema, reason }).strict(),
  z.object({ ...base, type: z.literal("change_blocker"), blocker: z.boolean(), reason }).strict(),
  z.object({ ...base, type: z.literal("supplement_remediation"), text: reason }).strict(),
  z.object({ ...base, type: z.literal("supplement_verification"), text: reason }).strict(),
]);
