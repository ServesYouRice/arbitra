export type ConsensusPolicyName = "full" | "risk_weighted" | "minimal";
export type ConsensusOutcome = "accepted" | "rejected" | "needs_verification" | "non_consensus" | "single_source";
export interface ConsensusVote { readonly authorId: string; readonly disposition: "accept" | "reject" | "needs_verification"; readonly citedEvidenceIds: readonly string[]; readonly reason: string }
export interface ConsensusObjection { readonly authorId: string; readonly reason: string; readonly citesLocation: boolean; readonly evidenceType: "repository" | "test" | "specification" | "inference" | "speculation"; readonly resolvedBy: string | null }
export interface ConsensusCandidate {
  readonly candidateId: string; readonly claim: { readonly title: string; readonly description: string }; readonly sourceFindingIds: readonly string[];
  readonly severity: "critical" | "high" | "medium" | "low" | "informational"; readonly blocker: boolean; readonly status: string;
  readonly votes: readonly ConsensusVote[]; readonly objections?: readonly ConsensusObjection[]; readonly evidence: readonly unknown[]; readonly counterEvidence: readonly unknown[];
  readonly firstSeenRound: number; readonly lastChangedRound: number; readonly category?: string; readonly highBlastRadius?: boolean; readonly lowConfidence?: boolean;
}
export interface ConsensusBoard { readonly candidates: Readonly<Record<string, ConsensusCandidate>> }
export interface ConsensusAuditor { readonly auditorId: string; readonly independenceGroup: string }
export interface ConsensusPolicy { readonly name: ConsensusPolicyName; readonly quorum: number; readonly minimumIndependentGroupsForHighRisk: number }
export const DEFAULT_CONSENSUS_POLICY: ConsensusPolicy = Object.freeze({ name: "risk_weighted", quorum: 2, minimumIndependentGroupsForHighRisk: 2 });
export interface CandidateConsensus { readonly candidateId: string; readonly outcome: ConsensusOutcome; readonly supportCount: number; readonly reviewDenominator: number; readonly independentGroupsRepresented: number; readonly dissent: readonly ConsensusVote[]; readonly counterEvidence: readonly unknown[]; readonly coverage: { readonly reviewedBy: readonly string[]; readonly missingReviewers: readonly string[] }; readonly escalateToVerification: boolean; readonly reason: string }
export interface ConsensusState { readonly policy: ConsensusPolicyName; readonly auditorCount: number; readonly round: number; readonly exhausted: boolean; readonly candidates: readonly CandidateConsensus[] }

export function computeConsensus(board: ConsensusBoard, policy: ConsensusPolicy = DEFAULT_CONSENSUS_POLICY, context: { readonly auditors: readonly ConsensusAuditor[]; readonly round: number; readonly maximumRounds?: number }): ConsensusState {
  const maximumRounds = context.maximumRounds ?? 3; if (!Number.isSafeInteger(maximumRounds) || maximumRounds < 1 || maximumRounds > 3) throw new Error("INVALID_PEER_REVIEW_MAXIMUM_ROUNDS");
  const auditors = context.auditors; const auditorIds = new Set(auditors.map(({ auditorId }) => auditorId)); if (auditorIds.size !== auditors.length || auditors.length === 0) throw new Error("INVALID_CONSENSUS_AUDITORS");
  const groupByAuditor = new Map(auditors.map(({ auditorId, independenceGroup }) => [auditorId, independenceGroup])); const exhausted = context.round >= maximumRounds;
  const candidates = Object.values(board.candidates).sort((a, b) => a.candidateId.localeCompare(b.candidateId)).map((candidate) => decide(candidate, policy, auditors, groupByAuditor, exhausted));
  return Object.freeze({ policy: policy.name, auditorCount: auditors.length, round: context.round, exhausted, candidates: Object.freeze(candidates) });
}

export function isHighRisk(candidate: ConsensusCandidate): boolean { return candidate.severity === "critical" || candidate.severity === "high" || candidate.blocker || /(?:security|authorization|data_integrity|architecture|migration)/iu.test(candidate.category ?? "") || candidate.highBlastRadius === true; }

function decide(candidate: ConsensusCandidate, policy: ConsensusPolicy, auditors: readonly ConsensusAuditor[], groups: ReadonlyMap<string, string>, exhausted: boolean): CandidateConsensus {
  const latest = latestVotes(candidate.votes, new Set(auditors.map(({ auditorId }) => auditorId))); const reviewedBy = [...latest.keys()].sort(); const missing = auditors.map(({ auditorId }) => auditorId).filter((id) => !latest.has(id));
  const accepts = [...latest.values()].filter(({ disposition }) => disposition === "accept"); const rejects = [...latest.values()].filter(({ disposition }) => disposition === "reject"); const verification = [...latest.values()].filter(({ disposition }) => disposition === "needs_verification");
  const evidenceBackedAccept = accepts.filter(({ citedEvidenceIds }) => citedEvidenceIds.length > 0); const evidenceBackedReject = rejects.filter(({ citedEvidenceIds }) => citedEvidenceIds.length > 0);
  const representedGroups = new Set(evidenceBackedAccept.map(({ authorId }) => groups.get(authorId)).filter((value): value is string => value !== undefined));
  const blockingObjection = isHighRisk(candidate) && (candidate.objections ?? []).some((objection) => objection.citesLocation && objection.evidenceType !== "speculation" && objection.resolvedBy === null);
  let outcome: ConsensusOutcome; let reason: string;
  if (auditors.length === 1) { outcome = "single_source"; reason = "One auditor: consensus stage is skipped."; }
  else if (auditors.length === 2 && (verification.length > 0 || accepts.length !== 2 && rejects.length !== 2)) { outcome = "needs_verification"; reason = "Two-auditor material disagreement has no majority semantics."; }
  else if (blockingObjection) { outcome = "needs_verification"; reason = "An unresolved high-risk evidence-backed objection requires targeted verification."; }
  else if (verification.length > 0 || candidate.counterEvidence.length > 0 && accepts.length > 0) { outcome = "needs_verification"; reason = "Evidence is incomplete or conflicting."; }
  else if (evidenceBackedAccept.length >= policy.quorum && (!isHighRisk(candidate) || representedGroups.size >= policy.minimumIndependentGroupsForHighRisk)) { outcome = "accepted"; reason = "Evidence-backed acceptance met quorum and independence policy with no blocking objection."; }
  else if (evidenceBackedReject.length >= policy.quorum && evidenceBackedAccept.length === 0) { outcome = "rejected"; reason = "Evidence-backed rejection met quorum with no significant supported dissent."; }
  else if (exhausted) { outcome = "non_consensus"; reason = "Review rounds exhausted without policy convergence."; }
  else { outcome = "needs_verification"; reason = "Consensus requirements are not yet satisfied."; }
  const dissent = [...latest.values()].filter(({ disposition }) => outcome === "accepted" ? disposition !== "accept" : outcome === "rejected" ? disposition !== "reject" : true);
  return Object.freeze({ candidateId: candidate.candidateId, outcome, supportCount: evidenceBackedAccept.length, reviewDenominator: auditors.length, independentGroupsRepresented: representedGroups.size, dissent: Object.freeze(dissent), counterEvidence: Object.freeze([...candidate.counterEvidence]), coverage: Object.freeze({ reviewedBy: Object.freeze(reviewedBy), missingReviewers: Object.freeze(missing) }), escalateToVerification: outcome === "needs_verification", reason });
}
function latestVotes(votes: readonly ConsensusVote[], allowed: ReadonlySet<string>): Map<string, ConsensusVote> { const result = new Map<string, ConsensusVote>(); for (const vote of votes) if (allowed.has(vote.authorId)) result.set(vote.authorId, vote); return result; }
