import { describe, expect, it } from "vitest";
import { featureReviewConsensus, validateFeatureReview, reviewFeatureRounds } from "../src/feature-review.js";
import type { FeatureReview } from "@arbitra/schemas/feature-review.js";
import type { RequirementsContract } from "@arbitra/workflow/nodes/requirements/index.js";

const requirements: RequirementsContract = { schemaVersion: 1, featureRequest: "Feature", assumptions: [{ id: "ASM", statement: "Keep compatibility", confidence: "high" }], ambiguities: [], acceptance: [{ id: "ACC", assertion: "Feature works" }], outOfScope: [], decision: { mode: "automatic", acceptedDefaults: [] } };
const snapshot = { root: "unused", files: [{ path: "a.ts", lines: ["const version = 1;"], byteLength: 18, lineStartBytes: [0] }] };
const review = (): FeatureReview => ({ summary: "Reviewed", decisions: ["ASM", "ACC"].map((requirementId) => ({ requirementId, disposition: "accept", reason: "Consistent with request", proposedChange: null, evidence: [{ path: "a.ts", startLine: 1, endLine: 1, text: "const version = 1;" }] })), limitations: [] });
const reviewer = (id: string, result = review()) => ({ reviewerId: id, independenceGroup: id, review: result });

describe("Feature requirements review consensus", () => {
  it("reconsiders disagreement using peer reviews without own votes or author metadata", async () => {
    const persisted: number[] = []; let calls = 0;
    const result = await reviewFeatureRounds(requirements, snapshot, [reviewer("a"), reviewer("b")], 3, {
      async review({ reviewerId, round, peerReviews }) {
        calls += 1;
        if (round === 1) expect(peerReviews).toEqual([]);
        else {
          expect(peerReviews).toHaveLength(1);
          expect(peerReviews[0]?.summary).toBe(reviewerId === "a" ? "from b" : "from a");
          expect(peerReviews[0]).not.toHaveProperty("reviewerId");
        }
        const value = review(); value.summary = `from ${reviewerId}`;
        if (round === 1 && reviewerId === "b") value.decisions = value.decisions.map((decision) => ({ ...decision, disposition: "uncertain" }));
        return value;
      },
      async persist(round) { persisted.push(round); },
    });
    expect(calls).toBe(4); expect(persisted).toEqual([1, 2]); expect(result.blockingRequirementIds).toEqual([]);
  });

  it("stops at the round bound without promoting unresolved requirements", async () => {
    let calls = 0;
    const result = await reviewFeatureRounds(requirements, snapshot, [reviewer("a"), reviewer("b")], 2, {
      async review() { calls += 1; const value = review(); value.decisions = value.decisions.map((decision) => ({ ...decision, disposition: "uncertain" })); return value; },
      async persist() {},
    });
    expect(calls).toBe(4); expect(result.blockingRequirementIds).toEqual(["ASM", "ACC"]);
    await expect(reviewFeatureRounds(requirements, snapshot, [reviewer("a"), reviewer("b")], 4, { async review() { throw new Error("UNEXPECTED_CALL"); }, async persist() {} })).rejects.toThrow("INVALID_FEATURE_REVIEW_ROUND_LIMIT");
  });
  it("accepts complete independent agreement and preserves vote provenance", () => {
    const result = featureReviewConsensus(requirements, snapshot, [reviewer("a"), reviewer("b")]);
    expect(result.blockingRequirementIds).toEqual([]);
    expect(result.decisions[0]?.votes.map(({ reviewerId }) => reviewerId)).toEqual(["a", "b"]);
  });
  it("keeps mixed opinions and differing revision proposals unresolved", () => {
    const revised = review(); revised.decisions = revised.decisions.map((decision) => ({ ...decision, disposition: "revise", proposedChange: "Add migration validation" }));
    expect(featureReviewConsensus(requirements, snapshot, [reviewer("a"), reviewer("b", revised)]).blockingRequirementIds).toEqual(["ASM", "ACC"]);
    expect(featureReviewConsensus(requirements, snapshot, [reviewer("a", revised), reviewer("b", revised)]).decisions.every(({ disposition }) => disposition === "revision_required")).toBe(true);
    const different = { ...revised, decisions: revised.decisions.map((decision) => ({ ...decision, proposedChange: "Remove migration" })) };
    expect(featureReviewConsensus(requirements, snapshot, [reviewer("a", revised), reviewer("b", different)]).decisions.every(({ disposition }) => disposition === "unresolved")).toBe(true);
    expect(requirements.decision.acceptedDefaults).toEqual([]);
  });
  it("rejects missing, duplicate or invented decisions and forged evidence", () => {
    for (const decisions of [review().decisions.slice(0, 1), [...review().decisions, ...review().decisions], review().decisions.map((decision) => ({ ...decision, requirementId: "invented" }))]) {
      expect(() => validateFeatureReview({ ...review(), decisions }, requirements, snapshot)).toThrow();
    }
    expect(() => validateFeatureReview({ ...review(), decisions: review().decisions.map((decision) => ({ ...decision, evidence: [{ path: "a.ts", startLine: 1, endLine: 1, text: "forged" }] })) }, requirements, snapshot)).toThrow("FEATURE_REVIEW_UNGROUNDED_EVIDENCE");
  });
  it("rejects a single reviewer or duplicated independence groups", () => {
    expect(() => featureReviewConsensus(requirements, snapshot, [reviewer("a")])).toThrow("FEATURE_REVIEW_INDEPENDENCE_REQUIRED");
    expect(() => featureReviewConsensus(requirements, snapshot, [reviewer("a"), { ...reviewer("b"), independenceGroup: "a" }])).toThrow("FEATURE_REVIEW_INDEPENDENCE_REQUIRED");
  });
});
