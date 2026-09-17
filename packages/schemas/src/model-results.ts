import { z } from "zod";
import { sourceFindingSchema } from "./finding.js";

export const modelDiscoveryResultSchema = z.object({
  findings: sourceFindingSchema.array().max(40),
  truncated: z.boolean(),
  unexaminedDueToBudget: z.array(z.string().min(1)),
  limitations: z.array(z.string().min(1)),
}).strict();

export const modelTurnResultSchema = z.object({
  text: z.string().nullable(),
  toolCalls: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), arguments: z.unknown() }).strict()),
  refusal: z.string().nullable(),
  usage: z.object({ inputTokens: z.number().int().nonnegative().nullable(), outputTokens: z.number().int().nonnegative().nullable(), cacheReadTokens: z.number().int().nonnegative().nullable(), cacheWriteTokens: z.number().int().nonnegative().nullable() }).strict(),
}).strict();

export const peerReviewResultSchema = z.array(z.object({
  candidateId: z.string().min(1),
  disposition: z.enum(["accept", "reject", "needs_verification"]),
  citedEvidenceIds: z.array(z.string().min(1)),
  reason: z.string().min(1),
}).strict());

export const modelVerificationResultSchema = z.object({
  outcome: z.enum(["CONFIRMED", "REJECTED", "STILL_NEEDS_VERIFICATION"]),
  evidenceIds: z.array(z.string().min(1)),
  confidence: z.number().min(0).max(1),
}).strict();

export const modelCritiqueSchema = z.object({
  summary: z.string().min(1),
  items: z.array(z.object({
    id: z.string().min(1), category: z.enum(["missing_issues", "incomplete_requirements", "wrong_dependencies", "unsafe_parallelisation", "migration_hazards", "weak_acceptance_criteria", "weak_verification", "task_sizing", "hidden_architecture_decisions", "incorrect_capability_routing", "regressions", "conflicting_scopes", "missing_rollout_considerations", "invariant_violations"]),
    blocking: z.boolean(), summary: z.string().min(1), taskIds: z.array(z.string().min(1)), issueIds: z.array(z.string().min(1)),
  }).strict()),
}).strict();
