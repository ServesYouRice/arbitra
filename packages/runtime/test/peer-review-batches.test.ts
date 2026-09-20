import { describe, expect, it } from "vitest";
import { peerReviewBatches } from "../src/peer-review-batches.js";

describe("peer review context batching", () => {
  it("reviews every candidate once and preserves every pair's merge opportunity", async () => {
    const ids = ["a", "b", "c", "d", "e"];
    const batches = await peerReviewBatches(ids, async ({ candidateIds }) => candidateIds.length <= 2);
    expect(batches.filter(({ kind }) => kind === "review").flatMap(({ candidateIds }) => candidateIds)).toEqual(ids);
    for (const left of ids) for (const right of ids) if (left !== right) expect(batches.some(({ candidateIds }) => candidateIds.includes(left) && candidateIds.includes(right))).toBe(true);
    expect(batches.filter(({ kind }) => kind === "merge_check")).toHaveLength(8);
    expect(await peerReviewBatches(ids, async ({ candidateIds }) => candidateIds.length <= 2)).toEqual(batches);
  });

  it("does not spend on follow-ups when the full review fits", async () => {
    expect(await peerReviewBatches(["a", "b"], async () => true)).toEqual([{ kind: "review", candidateIds: ["a", "b"] }]);
  });

  it("fails explicitly when a complete candidate or pair cannot fit", async () => {
    await expect(peerReviewBatches(["a"], async () => false)).rejects.toThrow("PEER_CANDIDATE_CONTEXT_LIMIT_EXCEEDED:a");
    await expect(peerReviewBatches(["a", "b"], async ({ candidateIds }) => candidateIds.length === 1)).rejects.toThrow("PEER_PAIR_CONTEXT_LIMIT_EXCEEDED:a:b");
  });
});
