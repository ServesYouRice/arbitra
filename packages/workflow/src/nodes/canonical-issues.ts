type Severity = "critical" | "high" | "medium" | "low" | "informational";
type ConsensusOutcome = "accepted" | "rejected" | "needs_verification" | "non_consensus" | "single_source";
type VerificationOutcome = "CONFIRMED" | "REJECTED" | "STILL_NEEDS_VERIFICATION";
interface Evidence { readonly id: string; readonly text: string; readonly locationIds: readonly string[] }
interface Vote { readonly authorId: string; readonly disposition: "accept" | "reject" | "needs_verification"; readonly citedEvidenceIds: readonly string[]; readonly reason: string }
interface BoardCandidate { readonly candidateId: string; readonly claim: { readonly title: string; readonly description: string }; readonly sourceFindingIds: readonly string[]; readonly severity: Severity; readonly blocker: boolean; readonly counterEvidence: readonly Evidence[] }
interface CandidateConsensus { readonly candidateId: string; readonly outcome: ConsensusOutcome; readonly supportCount: number; readonly reviewDenominator: number; readonly dissent: readonly Vote[]; readonly coverage: { readonly reviewedBy: readonly string[]; readonly missingReviewers: readonly string[] }; readonly reason: string }
export interface CanonicalisationBoard { readonly candidates: Readonly<Record<string, BoardCandidate>>; readonly consensus: { readonly auditorCount: number; readonly candidates: readonly CandidateConsensus[] } }
export interface CanonicalVerification { readonly candidateId: string; readonly outcome: VerificationOutcome }
export interface CanonicalCoverage {
  readonly securityCoverage: { readonly degraded: boolean; readonly reason: string | null; readonly requiredAction?: string };
  readonly suppressionCandidates: readonly unknown[];
  readonly unexaminedSurfaces: readonly unknown[];
  readonly limitations: readonly string[];
}
export interface CanonicalIssue {
  readonly candidateId: string; readonly claim: { readonly trust: "untrusted_data"; readonly title: string; readonly description: string };
  readonly severity: Severity; readonly blocker: boolean; readonly disposition: ConsensusOutcome; readonly consensusClaim: string | null;
  readonly supportCount: number; readonly reviewDenominator: number; readonly dissent: readonly Vote[]; readonly counterEvidence: readonly Evidence[];
  readonly sourceFindingIds: readonly string[]; readonly verificationOutcome: VerificationOutcome | null;
  readonly coverage: { readonly reviewedBy: readonly string[]; readonly missingReviewers: readonly string[] }; readonly singleSource: boolean;
}
export interface CanonicalIssueSet {
  readonly schemaVersion: 1; readonly issues: readonly CanonicalIssue[]; readonly minorityFindingIds: readonly string[];
  readonly coverage: { readonly complete: boolean; readonly securityCoverage: CanonicalCoverage["securityCoverage"]; readonly suppressionCandidates: readonly unknown[]; readonly unexaminedSurfaces: readonly unknown[] };
  readonly limitations: readonly string[];
  readonly summary: { readonly auditorCount: number; readonly sourceFindingCount: number; readonly acceptedCount: number; readonly rejectedCount: number; readonly unresolvedCount: number; readonly singleSourceCount: number };
}

export function canonicaliseIssues(board: CanonicalisationBoard, verification: readonly CanonicalVerification[], coverage: CanonicalCoverage): CanonicalIssueSet {
  if (!Number.isSafeInteger(board.consensus.auditorCount) || board.consensus.auditorCount < 1) throw new Error("INVALID_CANONICAL_AUDITOR_COUNT");
  const consensusById = uniqueById(board.consensus.candidates, "DUPLICATE_CANONICAL_CONSENSUS");
  const verificationById = uniqueById(verification, "DUPLICATE_CANONICAL_VERIFICATION");
  const singleSource = board.consensus.auditorCount === 1;
  const issues = Object.values(board.candidates).sort((a, b) => a.candidateId.localeCompare(b.candidateId)).map((candidate): CanonicalIssue => {
    if (candidate.sourceFindingIds.length === 0) throw new Error(`CANONICAL_ISSUE_REQUIRES_SOURCE_FINDING:${candidate.candidateId}`);
    const consensus = consensusById.get(candidate.candidateId); if (consensus === undefined) throw new Error(`MISSING_CANONICAL_CONSENSUS:${candidate.candidateId}`);
    if (consensus.reviewDenominator !== board.consensus.auditorCount) throw new Error(`CANONICAL_REVIEW_DENOMINATOR_MISMATCH:${candidate.candidateId}`);
    const verified = verificationById.get(candidate.candidateId)?.outcome ?? null;
    const disposition = singleSource ? "single_source" : verified === "CONFIRMED" ? "accepted" : verified === "REJECTED" ? "rejected" : verified === "STILL_NEEDS_VERIFICATION" ? "needs_verification" : consensus.outcome;
    return Object.freeze({
      candidateId: candidate.candidateId,
      claim: Object.freeze({ trust: "untrusted_data" as const, title: candidate.claim.title, description: candidate.claim.description }),
      severity: candidate.severity,
      blocker: candidate.blocker,
      disposition,
      consensusClaim: singleSource ? null : consensus.reason,
      supportCount: consensus.supportCount,
      reviewDenominator: consensus.reviewDenominator,
      dissent: Object.freeze(consensus.dissent.map((vote) => Object.freeze({ ...vote, citedEvidenceIds: Object.freeze([...vote.citedEvidenceIds]) }))),
      counterEvidence: Object.freeze(candidate.counterEvidence.map((evidence) => Object.freeze({ ...evidence, locationIds: Object.freeze([...evidence.locationIds]) }))),
      sourceFindingIds: Object.freeze([...new Set(candidate.sourceFindingIds)].sort()),
      verificationOutcome: verified,
      coverage: Object.freeze({ reviewedBy: Object.freeze([...consensus.coverage.reviewedBy].sort()), missingReviewers: Object.freeze([...consensus.coverage.missingReviewers].sort()) }),
      singleSource,
    });
  });
  for (const id of verificationById.keys()) if (!(id in board.candidates)) throw new Error(`ORPHAN_CANONICAL_VERIFICATION:${id}`);
  const incompleteReview = issues.some((issue) => issue.coverage.missingReviewers.length > 0);
  const complete = !coverage.securityCoverage.degraded && coverage.suppressionCandidates.length === 0 && coverage.unexaminedSurfaces.length === 0 && !incompleteReview;
  const limitations = [...new Set([
    ...coverage.limitations,
    ...(coverage.securityCoverage.degraded ? [`security_coverage_degraded:${coverage.securityCoverage.reason ?? "unspecified"}`] : []),
    ...(coverage.suppressionCandidates.length > 0 ? [`suppression_candidates:${coverage.suppressionCandidates.length}`] : []),
    ...(coverage.unexaminedSurfaces.length > 0 ? [`unexamined_surfaces:${coverage.unexaminedSurfaces.length}`] : []),
    ...(incompleteReview ? ["incomplete_peer_review_coverage"] : []),
  ])].sort();
  const minorityFindingIds = issues.filter((issue) => (issue.severity === "critical" || issue.severity === "high") && issue.disposition !== "accepted" && issue.supportCount > 0).map(({ candidateId }) => candidateId);
  const sourceFindingCount = new Set(issues.flatMap(({ sourceFindingIds }) => sourceFindingIds)).size;
  return Object.freeze({
    schemaVersion: 1,
    issues: Object.freeze(issues),
    minorityFindingIds: Object.freeze(minorityFindingIds),
    coverage: Object.freeze({ complete, securityCoverage: Object.freeze({ ...coverage.securityCoverage }), suppressionCandidates: Object.freeze([...coverage.suppressionCandidates]), unexaminedSurfaces: Object.freeze([...coverage.unexaminedSurfaces]) }),
    limitations: Object.freeze(limitations),
    summary: Object.freeze({ auditorCount: board.consensus.auditorCount, sourceFindingCount, acceptedCount: issues.filter(({ disposition }) => disposition === "accepted").length, rejectedCount: issues.filter(({ disposition }) => disposition === "rejected").length, unresolvedCount: issues.filter(({ disposition }) => disposition === "needs_verification" || disposition === "non_consensus").length, singleSourceCount: issues.filter(({ singleSource: value }) => value).length }),
  });
}

function uniqueById<T extends { readonly candidateId: string }>(values: readonly T[], error: string): Map<string, T> { const result = new Map<string, T>(); for (const value of values) { if (result.has(value.candidateId)) throw new Error(`${error}:${value.candidateId}`); result.set(value.candidateId, value); } return result; }
