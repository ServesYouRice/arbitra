import { describe, expect, it } from "vitest";
import { SeededRng } from "@arbitra/core/services/rng.js";
import type { AuditFinding } from "../src/auditors.js";
import { peerReviewView } from "../src/peer-review-view.js";

function finding(author: string): AuditFinding {
  return { sourceFindingId: `${author}/finding`, category: "CORRECTNESS", title: "Bug", problem: "Incorrect return", recommendedFix: "Check value", severity: "high", productionBlocker: false,
    locations: [{ id: `${author}-location`, path: "a.ts", startLine: 1, endLine: 1 }],
    evidence: [{ id: `${author}-evidence`, text: "return null", locationIds: [`${author}-location`] }] };
}

describe("anonymous peer context", () => {
  it("removes own sources and aliases provenance while preserving an internal citation map", () => {
    const findings = { C1: [finding("author-a"), finding("author-b"), finding("author-c")], C2: [finding("author-a")] };
    const view = peerReviewView(["C1", "C2"], findings, "author-a", new SeededRng("run"));
    expect(Object.keys(view.candidates)).toEqual(["C1"]);
    expect(JSON.stringify(view.candidates)).not.toContain("author-");
    expect([...view.evidenceIds.values()].sort()).toEqual(["author-b-evidence", "author-c-evidence"]);
    const candidate = view.candidates["C1"];
    expect(candidate?.sources).toHaveLength(2);
    for (const source of candidate?.sources ?? []) expect(source.evidence[0]?.locationIds).toEqual([source.locations[0]?.id]);
    expect(peerReviewView(["C1", "C2"], findings, "author-a", new SeededRng("run"))).toEqual(view);
  });

  it("limits context to selected candidates and does not forward model extensions", () => {
    const source = { ...finding("author-b"), authorId: "author-b", hiddenField: "untrusted extension" };
    const view = peerReviewView(["C1"], { C1: [source], omitted: [finding("author-c")] }, "author-a", new SeededRng("run"));
    expect(JSON.stringify(view.candidates)).not.toMatch(/omitted|hiddenField|authorId/u);
  });

  it("uses the same anonymous label for a peer across multiple findings", () => {
    const source = finding("author-b");
    const view = peerReviewView(["C1", "C2"], { C1: [source], C2: [{ ...source, sourceFindingId: "author-b/second" }] }, "author-a", new SeededRng("run"));
    expect(view.candidates["C1"]?.sources[0]?.label).toBe(view.candidates["C2"]?.sources[0]?.label);
  });
});
