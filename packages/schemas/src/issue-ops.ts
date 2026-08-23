import { z } from "zod";

import { findingEvidenceSchema } from "./finding.js";

export const ISSUE_OP_SCHEMA_VERSION = 1 as const;

export const issueOperationKindSchema = z.enum([
  "add_candidate",
  "add_evidence",
  "add_counter_evidence",
  "cast_vote",
  "add_objection",
  "add_supplement",
  "propose_severity",
  "propose_blocker",
  "set_status",
  "merge",
  "split",
]);

export const issueOperationPayloadSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  sourceFindingIds: z.array(z.string().min(1)).optional(),
  evidence: findingEvidenceSchema.optional(),
  vote: z.enum(["accept", "reject", "needs_verification"]).optional(),
  reason: z.string().min(1).optional(),
  citesLocation: z.boolean().optional(),
  evidenceType: z.enum(["repository", "test", "specification", "inference", "speculation"]).optional(),
  resolvedBy: z.string().min(1).nullable().optional(),
  severity: z.enum(["critical", "high", "medium", "low", "informational"]).optional(),
  blocker: z.boolean().optional(),
  status: z.enum(["open", "accepted", "rejected", "needs_verification", "merged", "split"]).optional(),
  targetCandidateIds: z.array(z.string().min(1)).optional(),
}).strict();

export const issueOpSchema = z.object({
  schemaVersion: z.literal(ISSUE_OP_SCHEMA_VERSION),
  operationId: z.string().min(1),
  candidateId: z.string().min(1),
  actorId: z.string().min(1),
  round: z.number().int().nonnegative(),
  kind: issueOperationKindSchema,
  payload: issueOperationPayloadSchema,
}).strict();

export type IssueOperationKind = z.infer<typeof issueOperationKindSchema>;
export type IssueOperationPayload = z.infer<typeof issueOperationPayloadSchema>;
export type IssueOp = z.infer<typeof issueOpSchema>;
