import { z } from "zod";
import { requirementsDraftSchema } from "./requirements.js";

const text = z.string().refine((value) => value.trim().length > 0, "Expected nonempty text");
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const requirementsRevisionSchema = z.strictObject({
  draft: requirementsDraftSchema,
  lineage: z.array(z.strictObject({ previousRequirementId: text, nextRequirementIds: z.array(text), rationale: text })),
  addedRequirementIds: z.array(text),
  resolutions: z.array(z.strictObject({ requirementId: text, resolution: text })),
});
export type RequirementsRevision = z.infer<typeof requirementsRevisionSchema>;

export const requirementsRevisionProposalSchema = z.strictObject({
  baseArtifactId: text, inputFingerprint: hash, reviewArtifactId: text, modelProfileId: text,
  revision: requirementsRevisionSchema,
});
export type RequirementsRevisionProposal = z.infer<typeof requirementsRevisionProposalSchema>;

export const requirementsRevisionLedgerSchema = z.strictObject({
  attempts: z.array(z.strictObject({ baseArtifactId: text, inputFingerprint: hash, reviewArtifactId: text, modelProfileId: text })),
});
