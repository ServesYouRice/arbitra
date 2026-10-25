import { describe, expect, it } from "vitest";
import { modelVariantSearchResultSchema, modelVerificationGroupResultSchema, modelVerificationResultSchema } from "../src/model-results.js";

describe("model verification answers", () => {
  it("carry a reason, required in the schema sent to providers, alone and in a group", () => {
    // Observed on the real-project runs (October 2026): "cannot tell" and "rejected" outcomes carried no reason, so
    // checking one meant reading its tool trace. Strict structured output requires every property to be listed as required.
    const answer = { outcome: "STILL_NEEDS_VERIFICATION", evidenceIds: [], confidence: 0.5, reason: "Whether the route is public is set in deployment configuration." };
    expect(modelVerificationResultSchema.parse(answer)).toEqual(answer);
    expect(modelVerificationResultSchema.safeParse({ ...answer, reason: " " }).success).toBe(false);
    expect(modelVerificationResultSchema.safeParse({ outcome: "REJECTED", evidenceIds: ["e-1"], confidence: 0.5 }).success).toBe(false);
    expect(modelVerificationResultSchema.toJSONSchema()).toMatchObject({ required: expect.arrayContaining(["reason"]) as unknown });
    expect(modelVerificationGroupResultSchema.safeParse({ answers: [{ candidateId: "C-1", outcome: "REJECTED", evidenceIds: ["e-1"], confidence: 0.5 }] }).success).toBe(false);
    expect(modelVerificationGroupResultSchema.parse({ answers: [{ candidateId: "C-1", ...answer }] }).answers[0]?.reason).toBe(answer.reason);
  });
});

describe("variant search answers", () => {
  it("are audit findings that each name the issue they repeat, and nothing more", () => {
    const finding = { schemaVersion: 1, sourceFindingId: "variant-search/batch-1/1", category: "CORRECTNESS", title: "The same unchecked read", severity: "high", status: "likely", confidence: 0.6, productionBlocker: false,
      locations: [{ id: "L1", path: "src/b.ts", startLine: 3, endLine: 3 }], evidence: [{ id: "E1", text: "read(key)", locationIds: ["L1"] }], problem: "As in the issue", productionImpact: "", trigger: "", recommendedFix: "", verification: "", dependencies: [], relatedRisks: [] };
    expect(modelVariantSearchResultSchema.parse({ findings: [{ ...finding, variantOf: "C-1" }], limitations: [] }).findings[0]?.variantOf).toBe("C-1");
    expect(modelVariantSearchResultSchema.safeParse({ findings: [finding], limitations: [] }).success).toBe(false);
    expect(modelVariantSearchResultSchema.safeParse({ findings: [{ ...finding, variantOf: "C-1", note: "extra" }], limitations: [] }).success).toBe(false);
    expect(modelVariantSearchResultSchema.toJSONSchema()).toMatchObject({ properties: { findings: { items: { required: expect.arrayContaining(["variantOf", "evidence"]) as unknown } } } });
  });
});
