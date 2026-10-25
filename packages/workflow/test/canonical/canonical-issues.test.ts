import { describe, expect, it } from "vitest";
import { canonicaliseIssues, isPlannable, withAddedIssues, type CanonicalisationBoard } from "../../src/nodes/canonical-issues.js";

const candidate = (candidateId = "C-1", severity: "high" | "medium" = "high") => ({ candidateId, claim: { title: "Unsafe premise", description: "The premise is contradicted by the repository." }, sourceFindingIds: [`F-${candidateId}`], severity, blocker: false, counterEvidence: [{ id: "E-counter", text: "A guard exists on one route.", locationIds: ["L-2"] }] });
const consensus = (overrides: Partial<CanonicalisationBoard["consensus"]["candidates"][number]> = {}): CanonicalisationBoard["consensus"]["candidates"][number] => ({ candidateId: "C-1", outcome: "accepted", supportCount: 2, reviewDenominator: 3, dissent: [{ authorId: "auditor-c", disposition: "reject", citedEvidenceIds: ["E-counter"], reason: "A route guard is counter-evidence." }], coverage: { reviewedBy: ["auditor-a", "auditor-b", "auditor-c"], missingReviewers: [] }, reason: "Evidence-backed acceptance met policy.", ...overrides });
const coverage = { securityCoverage: { degraded: false, reason: null }, suppressionCandidates: [], unexaminedSurfaces: [], limitations: [] } as const;

describe("canonical issue projection", () => {
  it("rejects mismatched identities and orphaned consensus", () => {
    expect(() => canonicaliseIssues({ candidates: { wrong: candidate() }, consensus: { auditorCount: 3, candidates: [consensus()] } }, [], coverage)).toThrow("CANONICAL_CANDIDATE_ID_MISMATCH:wrong");
    expect(() => canonicaliseIssues({ candidates: {}, consensus: { auditorCount: 3, candidates: [consensus()] } }, [], coverage)).toThrow("ORPHAN_CANONICAL_CONSENSUS:C-1");
  });
  it("retains 2-1 dissent, counter-evidence, traceability and coverage", () => {
    const artifact = canonicaliseIssues({ candidates: { "C-1": candidate() }, consensus: { auditorCount: 3, candidates: [consensus()] } }, [], coverage);
    expect(artifact.issues[0]).toMatchObject({ supportCount: 2, reviewDenominator: 3, sourceFindingIds: ["F-C-1"], dissent: [{ authorId: "auditor-c", citedEvidenceIds: ["E-counter"] }], counterEvidence: [{ id: "E-counter" }], verificationOutcome: null });
    expect(artifact.coverage.complete).toBe(true);
  });

  it("carries the verifier's reason onto its issue, and an issue verified without one reads as before", () => {
    const artifact = canonicaliseIssues({ candidates: { "C-1": candidate(), "C-2": candidate("C-2") }, consensus: { auditorCount: 3, candidates: [consensus(), consensus({ candidateId: "C-2" })] } },
      [{ candidateId: "C-1", outcome: "STILL_NEEDS_VERIFICATION", reason: "Whether the route is public is set in deployment configuration." }, { candidateId: "C-2", outcome: "REJECTED" }], coverage);
    expect(artifact.issues[0]).toMatchObject({ verificationOutcome: "STILL_NEEDS_VERIFICATION", verificationReason: "Whether the route is public is set in deployment configuration." });
    expect(artifact.issues[1]?.verificationOutcome).toBe("REJECTED");
    expect(Object.hasOwn(artifact.issues[1] ?? {}, "verificationReason")).toBe(false);
  });

  it("keeps a high-risk supported minority visible when it is not accepted", () => {
    const artifact = canonicaliseIssues({ candidates: { "C-1": candidate() }, consensus: { auditorCount: 3, candidates: [consensus({ outcome: "rejected", supportCount: 1 })] } }, [], coverage);
    expect(artifact.issues).toHaveLength(1);
    expect(artifact.minorityFindingIds).toEqual(["C-1"]);
  });

  it("labels every one-auditor issue single-source and makes no consensus claim", () => {
    const artifact = canonicaliseIssues({ candidates: { "C-1": candidate(), "C-2": candidate("C-2", "medium") }, consensus: { auditorCount: 1, candidates: [consensus({ reviewDenominator: 1, supportCount: 1, dissent: [], coverage: { reviewedBy: ["auditor-a"], missingReviewers: [] } }), consensus({ candidateId: "C-2", reviewDenominator: 1, supportCount: 1, dissent: [], coverage: { reviewedBy: ["auditor-a"], missingReviewers: [] } })] } }, [], coverage);
    expect(artifact.issues.every(({ disposition, singleSource, consensusClaim }) => disposition === "single_source" && singleSource && consensusClaim === null)).toBe(true);
    expect(artifact.summary.singleSourceCount).toBe(2);
  });

  it("plans a one-auditor issue that targeted verification confirmed, and says no second auditor checked it", () => {
    // Observed live: every single-auditor issue stayed single_source, so the plan addressed nothing.
    const one = (candidateId: string) => consensus({ candidateId, reviewDenominator: 1, supportCount: 1, dissent: [], coverage: { reviewedBy: ["auditor-a"], missingReviewers: [] } });
    const artifact = canonicaliseIssues({ candidates: { "C-1": candidate(), "C-2": candidate("C-2"), "C-3": candidate("C-3") }, consensus: { auditorCount: 1, candidates: [one("C-1"), one("C-2"), one("C-3")] } },
      [{ candidateId: "C-1", outcome: "CONFIRMED" }, { candidateId: "C-2", outcome: "REJECTED" }], coverage);
    expect(artifact.issues.map(({ candidateId, disposition, singleSource, consensusClaim }) => [candidateId, disposition, singleSource, consensusClaim])).toEqual([["C-1", "verified_single_source", true, null], ["C-2", "single_source", true, null], ["C-3", "single_source", true, null]]);
    expect(artifact.issues.filter(isPlannable).map(({ candidateId }) => candidateId)).toEqual(["C-1"]);
    expect(artifact.limitations).toContain("single_source_issues_planned_without_second_auditor:1");
    expect(artifact.summary.acceptedCount).toBe(0);
    const three = canonicaliseIssues({ candidates: { "C-1": candidate() }, consensus: { auditorCount: 3, candidates: [consensus({ outcome: "needs_verification" })] } }, [{ candidateId: "C-1", outcome: "CONFIRMED" }], coverage);
    expect(three.issues[0]?.disposition).toBe("accepted"); expect(three.limitations).toEqual([]);
  });

  it("carries verification, security gaps, honest nulls and derived limitations", () => {
    const artifact = canonicaliseIssues({ candidates: { "C-1": candidate() }, consensus: { auditorCount: 3, candidates: [consensus({ outcome: "needs_verification" })] } }, [{ candidateId: "C-1", outcome: "STILL_NEEDS_VERIFICATION" }], { securityCoverage: { degraded: true, reason: "overlap_budget_exceeded", requiredAction: "fail_closed" }, suppressionCandidates: [{ path: "src/auth.ts" }], unexaminedSurfaces: [{ surfaceId: "billing" }], limitations: [] });
    expect(artifact.issues[0]).toMatchObject({ disposition: "needs_verification", verificationOutcome: "STILL_NEEDS_VERIFICATION" });
    expect(artifact.coverage.complete).toBe(false);
    expect(artifact.limitations).toEqual(["security_coverage_degraded:overlap_budget_exceeded", "suppression_candidates:1", "unexamined_surfaces:1"]);
  });

  it("rejects candidates without a source finding and ignores transcript-shaped board extras", () => {
    const bad = { ...candidate(), sourceFindingIds: [] };
    expect(() => canonicaliseIssues({ candidates: { "C-1": bad }, consensus: { auditorCount: 3, candidates: [consensus()] } }, [], coverage)).toThrow("CANONICAL_ISSUE_REQUIRES_SOURCE_FINDING:C-1");
    const candidateWithTranscript = { ...candidate(), rawTranscript: "must not escape" };
    const artifact = canonicaliseIssues({ candidates: { "C-1": candidateWithTranscript }, consensus: { auditorCount: 3, candidates: [consensus()] } }, [], coverage);
    expect(JSON.stringify(artifact)).not.toContain("must not escape");
    expect(JSON.stringify(artifact)).not.toContain("rawTranscript");
  });

  it("carries a variant's provenance onto its issue, and an issue the finders reported reads as before", () => {
    const artifact = canonicaliseIssues({ candidates: { "C-1": candidate(), "V-1": { ...candidate("V-1"), variantOf: "C-1" } }, consensus: { auditorCount: 3, candidates: [consensus(), consensus({ candidateId: "V-1" })] } }, [], coverage);
    expect(artifact.issues.map((issue) => [issue.candidateId, issue.variantOf])).toEqual([["C-1", undefined], ["V-1", "C-1"]]);
    expect(Object.hasOwn(artifact.issues[0] ?? {}, "variantOf")).toBe(false);
  });

  it("adds issues to a set and counts the set again, with the limitations derived from its issues", () => {
    const one = (candidateId: string) => consensus({ candidateId, outcome: "single_source", reviewDenominator: 1, supportCount: 1, dissent: [], coverage: { reviewedBy: ["auditor-a"], missingReviewers: [] } });
    const base = canonicaliseIssues({ candidates: { "C-1": candidate(), "C-2": candidate("C-2") }, consensus: { auditorCount: 1, candidates: [one("C-1"), one("C-2")] } }, [{ candidateId: "C-1", outcome: "CONFIRMED" }], { ...coverage, limitations: ["auditor_kind:model_auditors"] });
    const variants = canonicaliseIssues({ candidates: { "V-1": { ...candidate("V-1"), variantOf: "C-1" } }, consensus: { auditorCount: 1, candidates: [one("V-1")] } }, [{ candidateId: "V-1", outcome: "CONFIRMED" }], coverage);
    const joined = withAddedIssues(base, variants.issues, ["variant_search_issues_added:1"]);
    expect(joined.issues.map(({ candidateId }) => candidateId)).toEqual(["C-1", "C-2", "V-1"]);
    expect(joined.summary).toEqual({ ...base.summary, sourceFindingCount: 3, singleSourceCount: 3 });
    expect(joined.limitations).toEqual(["auditor_kind:model_auditors", "single_source_issues_planned_without_second_auditor:2", "variant_search_issues_added:1"]);
    expect(joined.coverage).toEqual(base.coverage);
    expect(() => withAddedIssues(base, base.issues.slice(0, 1), [])).toThrow("DUPLICATE_CANONICAL_ISSUE:C-1");
  });
});
