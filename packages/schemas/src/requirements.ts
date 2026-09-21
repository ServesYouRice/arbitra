import { z } from "zod";

const text = z.string().refine((value) => value.trim().length > 0, "Expected nonempty text");
const assumption = z.strictObject({ id: text, statement: text, confidence: z.enum(["low", "medium", "high"]) });
const ambiguity = z.strictObject({ id: text, question: text, proposedDefault: text, blastRadius: z.enum(["low", "medium", "high"]) });
const acceptance = z.strictObject({ id: text, assertion: text });
const draftShape = {
  assumptions: z.array(assumption).min(1),
  ambiguities: z.array(ambiguity),
  outOfScope: z.array(text),
  acceptance: z.array(acceptance).min(1),
};

function uniqueIdentifiers(value: { assumptions: { id: string }[]; ambiguities: { id: string }[]; acceptance: { id: string }[] }, context: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const key of ["assumptions", "ambiguities", "acceptance"] as const) {
    value[key].forEach(({ id }, index) => {
      if (seen.has(id)) context.addIssue({ code: "custom", path: [key, index, "id"], message: "Duplicate requirements identifier" });
      seen.add(id);
    });
  }
}

export const requirementsDraftSchema = z.strictObject(draftShape).superRefine(uniqueIdentifiers);

export const requirementsContractSchema = z.strictObject({
  schemaVersion: z.literal(1), featureRequest: text, ...draftShape,
  decision: z.strictObject({
    mode: z.enum(["automatic", "interactive"]),
    acceptedDefaults: z.array(z.strictObject({ ambiguityId: text, value: text, acceptedBy: z.enum(["automatic_mode", "operator"]) })),
  }),
}).superRefine((value, context) => {
  uniqueIdentifiers(value, context);
  const accepted = new Set<string>();
  value.decision.acceptedDefaults.forEach((decision, index) => {
    const ambiguity = value.ambiguities.find(({ id }) => id === decision.ambiguityId);
    if (accepted.has(decision.ambiguityId) || ambiguity === undefined || ambiguity.proposedDefault !== decision.value
      || decision.acceptedBy !== (value.decision.mode === "automatic" ? "automatic_mode" : "operator")) {
      context.addIssue({ code: "custom", path: ["decision", "acceptedDefaults", index], message: "Default decision must uniquely match a recorded ambiguity and decision mode" });
    }
    accepted.add(decision.ambiguityId);
  });
  if (value.decision.mode === "automatic" && value.ambiguities.some(({ id }) => !accepted.has(id))) {
    context.addIssue({ code: "custom", path: ["decision", "acceptedDefaults"], message: "Automatic mode must record every proposed default" });
  }
});

export type RequirementsDraft = z.infer<typeof requirementsDraftSchema>;
export type RequirementsContract = z.infer<typeof requirementsContractSchema>;

export const featurePreflightSchema = z.strictObject({
  affectedSurfaces: z.array(z.strictObject({ id: text, paths: z.array(text).min(1), riskCategories: z.array(text), relevantTo: z.array(text).min(1) })),
  securitySensitiveSurfaceCount: z.number().int().nonnegative(),
  migrationInvolvement: z.boolean(), architectureBreadth: z.number().int().nonnegative(), testingComplexity: z.number().int().nonnegative(),
}).superRefine((value, context) => {
  if (new Set(value.affectedSurfaces.map(({ id }) => id)).size !== value.affectedSurfaces.length) context.addIssue({ code: "custom", path: ["affectedSurfaces"], message: "Surface identifiers must be unique" });
  if (value.securitySensitiveSurfaceCount > value.affectedSurfaces.length) context.addIssue({ code: "custom", path: ["securitySensitiveSurfaceCount"], message: "Sensitive surface count exceeds the recorded surfaces" });
});

export const featureExplorationSchema = z.strictObject({
  summary: text,
  preflight: featurePreflightSchema,
  evidence: z.array(z.strictObject({ surfaceId: text, path: text, startLine: z.number().int().positive(), endLine: z.number().int().positive(), text })),
  limitations: z.array(text),
});
export type FeatureExploration = z.infer<typeof featureExplorationSchema>;
