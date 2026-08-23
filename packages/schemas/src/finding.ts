import { z } from "zod";

export const SOURCE_FINDING_SCHEMA_VERSION = 1 as const;

export const findingCategorySchema = z.enum([
  "SECURITY",
  "PROMPT_INJECTION",
  "CORRECTNESS",
  "RELIABILITY",
  "PERFORMANCE",
  "MAINTAINABILITY",
  "TESTING",
  "DOCUMENTATION",
]);

export const findingLocationSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
}).strict();

export const findingEvidenceSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  locationIds: z.array(z.string().min(1)),
}).strict();

export const sourceFindingSchema = z.object({
  schemaVersion: z.literal(SOURCE_FINDING_SCHEMA_VERSION),
  sourceFindingId: z.string().regex(/^[^/]+\/.+$/),
  category: findingCategorySchema,
  title: z.string().min(1),
  severity: z.enum(["critical", "high", "medium", "low", "informational"]),
  status: z.enum(["confirmed", "likely", "needs_verification"]),
  confidence: z.number().min(0).max(1),
  productionBlocker: z.boolean(),
  locations: z.array(findingLocationSchema),
  problem: z.string().min(1),
  evidence: z.array(findingEvidenceSchema),
  productionImpact: z.string(),
  trigger: z.string(),
  recommendedFix: z.string(),
  verification: z.string(),
  dependencies: z.array(z.string()),
  relatedRisks: z.array(z.string()),
}).strict();

export type FindingCategory = z.infer<typeof findingCategorySchema>;
export type FindingLocation = z.infer<typeof findingLocationSchema>;
export type FindingEvidence = z.infer<typeof findingEvidenceSchema>;
export type SourceFinding = z.infer<typeof sourceFindingSchema>;
