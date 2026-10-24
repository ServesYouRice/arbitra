import { describe, expect, it } from "vitest";
import { modelVerificationGroupResultSchema, modelVerificationResultSchema } from "../src/model-results.js";

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
