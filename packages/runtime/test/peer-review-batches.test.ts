import { describe, expect, it } from "vitest";
import { assertMergeCheckOperations, peerReviewBatches, segmentText } from "../src/peer-review-batches.js";

describe("peer review context batching", () => {
  it("reviews every candidate once and preserves every pair's merge opportunity", async () => {
    const ids = ["a", "b", "c", "d", "e"];
    const batches = await peerReviewBatches(ids, async ({ candidateIds }) => candidateIds.length <= 2);
    expect(batches.filter(({ kind }) => kind === "review").flatMap(({ candidateIds }) => candidateIds)).toEqual(ids);
    for (const left of ids) for (const right of ids) if (left !== right) expect(batches.some(({ candidateIds }) => candidateIds.includes(left) && candidateIds.includes(right))).toBe(true);
    expect(batches.filter(({ kind }) => kind === "merge_check")).toHaveLength(8);
    expect(await peerReviewBatches(ids, async ({ candidateIds }) => candidateIds.length <= 2)).toEqual(batches);
  });

  it("packs the pairs between two large batches into a few calls instead of one call per pair", async () => {
    // Observed live (P20 pilot): 68 candidates in batches of 38 and 30 became 1,140 one-pair calls for one reviewer.
    const ids = Array.from({ length: 68 }, (_, index) => `c${index}`);
    const admitted: number[] = [];
    const fits = async ({ candidateIds }: { candidateIds: readonly string[] }) => { admitted.push(candidateIds.length); return candidateIds.length <= 38; };
    const batches = await peerReviewBatches(ids, fits, 400);
    expect(batches.filter(({ kind }) => kind === "review").map(({ candidateIds }) => candidateIds.length)).toEqual([38, 30]);
    const checks = batches.filter(({ kind }) => kind === "merge_check");
    expect(checks.length).toBeLessThanOrEqual(8);
    expect(checks.every(({ candidateIds }) => candidateIds.length <= 38)).toBe(true);
    // Every pair across the two batches is listed in exactly one check, and each check lists only pairs it holds.
    const listed = checks.flatMap(({ candidateIds, pairs }) => (pairs ?? [[candidateIds[0] ?? "", candidateIds[1] ?? ""] as const]).map(([left, right]) => { expect(candidateIds).toContain(left); expect(candidateIds).toContain(right); return `${left}|${right}`; }));
    expect(listed).toHaveLength(38 * 30);
    expect(new Set(listed).size).toBe(38 * 30);
    for (const left of ids.slice(0, 38)) for (const right of ids.slice(38)) expect(listed).toContain(`${left}|${right}`);
    // The plan is deterministic, so a resumed review addresses the same durable calls.
    expect(await peerReviewBatches(ids, fits, 400)).toEqual(batches);
  });

  it("accepts merges over the candidates a packed check presents, one per candidate, and one merge for a single pair", () => {
    const merge = (...sourceCandidateIds: string[]) => ({ type: "merge", sourceCandidateIds });
    const packed = { kind: "merge_check" as const, candidateIds: ["a", "b", "x", "y"], pairs: [["a", "x"], ["a", "y"], ["b", "x"], ["b", "y"]] as const };
    expect(() => assertMergeCheckOperations([], packed)).not.toThrow();
    expect(() => assertMergeCheckOperations([merge("a", "x"), merge("b", "y")], packed)).not.toThrow();
    expect(() => assertMergeCheckOperations([merge("a", "b", "x")], packed)).not.toThrow();
    // Two candidates of one review batch are not a listed pair, but the check has both whole in front of it (observed live: four such merges were refused, a repair call each).
    expect(() => assertMergeCheckOperations([merge("a", "b")], packed)).not.toThrow();
    expect(() => assertMergeCheckOperations([merge("a", "x"), merge("a", "y")], packed)).toThrow("INVALID_PEER_PAIR_OPERATIONS: a candidate may appear in one merge only");
    expect(() => assertMergeCheckOperations([{ type: "accept" }], packed)).toThrow("INVALID_PEER_PAIR_OPERATIONS");
    const single = { kind: "merge_check" as const, candidateIds: ["a", "x"] };
    expect(() => assertMergeCheckOperations([merge("a", "x")], single)).not.toThrow();
    expect(() => assertMergeCheckOperations([merge("a", "x"), merge("a", "x")], single)).toThrow("INVALID_PEER_PAIR_OPERATIONS");
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

  it("reviews a candidate that fits no batch alone when it is admitted as required input", async () => {
    const asked: string[][] = [];
    const batches = await peerReviewBatches(["a", "b", "c"], async ({ kind, candidateIds }) => kind !== "review" || !candidateIds.includes("b"), 20, 20, async ({ candidateIds }) => { asked.push([...candidateIds]); return true; });
    expect(batches.filter(({ kind }) => kind === "review").map(({ candidateIds }) => candidateIds)).toEqual([["a"], ["b"], ["c"]]);
    // Asked for that candidate only: the others are grouped as before.
    expect(asked).toEqual([["b"]]);
  });
});
