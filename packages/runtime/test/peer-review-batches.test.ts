import { describe, expect, it } from "vitest";
import { peerReviewBatches, segmentText } from "../src/peer-review-batches.js";

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

  it("checks an oversized pair with one complete record and exact segments of the other", async () => {
    const size: Record<string, number> = { a: 6, b: 6, c: 1 };
    const load = ({ candidateIds, segment }: { candidateIds: readonly string[]; segment?: { candidateId: string; count: number } }) =>
      candidateIds.reduce((sum, id) => sum + (segment?.candidateId === id ? Math.ceil((size[id] ?? 0) / segment.count) : size[id] ?? 0), 0);
    const batches = await peerReviewBatches(["a", "b", "c"], async (batch) => load(batch) <= 9);
    const segmented = batches.filter(({ segment }) => segment !== undefined);
    expect(segmented).toEqual([0, 1].map((index) => ({ kind: "merge_check", candidateIds: ["a", "b"], segment: { candidateId: "b", index, count: 2 } })));
    for (const left of ["a", "b", "c"]) for (const right of ["a", "b", "c"]) expect(batches.some(({ candidateIds }) => candidateIds.includes(left) && candidateIds.includes(right))).toBe(true);
    const text = JSON.stringify({ evidence: "exact source quotation ".repeat(7) });
    for (const count of [2, 3, 7]) expect(Array.from({ length: count }, (_, index) => segmentText(text, { index, count })).join("")).toBe(text);
    expect(() => segmentText(text, { index: 2, count: 2 })).toThrow("INVALID_PAIR_SEGMENT");
  });

  it("fails explicitly when a complete candidate or pair cannot fit", async () => {
    await expect(peerReviewBatches(["a"], async () => false)).rejects.toThrow("PEER_CANDIDATE_CONTEXT_LIMIT_EXCEEDED:a");
    await expect(peerReviewBatches(["a", "b"], async ({ candidateIds }) => candidateIds.length === 1)).rejects.toThrow("PEER_PAIR_CONTEXT_LIMIT_EXCEEDED:a:b");
  });
});
