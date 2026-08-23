import { z } from "zod";

export const CANONICAL_ISSUE_SCHEMA_VERSION = 1 as const;

const evidenceSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  locationIds: z.array(z.string().min(1)),
}).strict();

const voteSchema = z.object({
  authorId: z.string().min(1),
  disposition: z.enum(["accept", "reject", "needs_verification"]),
  citedEvidenceIds: z.array(z.string().min(1)),
  reason: z.string(),
}).strict();

export const canonicalIssueSchema = z.object({
  candidateId: z.string().min(1),
  claim: z.object({
    trust: z.literal("untrusted_data"),
    title: z.string().min(1),
    description: z.string().min(1),
  }).strict(),
  severity: z.enum(["critical", "high", "medium", "low", "informational"]),
  blocker: z.boolean(),
  disposition: z.enum(["accepted", "rejected", "needs_verification", "non_consensus", "single_source"]),
  consensusClaim: z.string().nullable(),
  supportCount: z.number().int().nonnegative(),
  reviewDenominator: z.number().int().positive(),
  dissent: z.array(voteSchema),
  counterEvidence: z.array(evidenceSchema),
  sourceFindingIds: z.array(z.string().min(1)).min(1),
  verificationOutcome: z.enum(["CONFIRMED", "REJECTED", "STILL_NEEDS_VERIFICATION"]).nullable(),
  coverage: z.object({
    reviewedBy: z.array(z.string().min(1)),
    missingReviewers: z.array(z.string().min(1)),
  }).strict(),
  singleSource: z.boolean(),
}).strict();

export const canonicalIssueSetSchema = z.object({
  schemaVersion: z.literal(CANONICAL_ISSUE_SCHEMA_VERSION),
  issues: z.array(canonicalIssueSchema),
  minorityFindingIds: z.array(z.string().min(1)),
  coverage: z.object({
    complete: z.boolean(),
    securityCoverage: z.object({
      degraded: z.boolean(),
      reason: z.string().nullable(),
      requiredAction: z.string().optional(),
    }).strict(),
    suppressionCandidates: z.array(z.unknown()),
    unexaminedSurfaces: z.array(z.unknown()),
  }).strict(),
  limitations: z.array(z.string().min(1)),
  summary: z.object({
    auditorCount: z.number().int().positive(),
    sourceFindingCount: z.number().int().nonnegative(),
    acceptedCount: z.number().int().nonnegative(),
    rejectedCount: z.number().int().nonnegative(),
    unresolvedCount: z.number().int().nonnegative(),
    singleSourceCount: z.number().int().nonnegative(),
  }).strict(),
}).strict();

export type CanonicalIssue = z.infer<typeof canonicalIssueSchema>;
export type CanonicalIssueSet = z.infer<typeof canonicalIssueSetSchema>;
