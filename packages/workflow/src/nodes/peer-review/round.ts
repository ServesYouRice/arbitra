import { computeConsensus, DEFAULT_CONSENSUS_POLICY, isHighRisk, type ConsensusAuditor, type ConsensusBoard, type ConsensusCandidate, type ConsensusPolicy, type ConsensusState } from "../../consensus/engine.js";

export interface ReviewRng { forActivity(activityId: string): ReviewRng; shuffle<T>(items: T[]): T[] }
export interface PeerIssueOperation { readonly operationId: string; readonly candidateId: string; readonly authorId: string; readonly round: number; readonly type: string; readonly citedEvidenceIds: readonly string[]; readonly [key: string]: unknown }
export interface PresentedPeerSource { readonly label: string; readonly findingRef: string }
export interface ReviewCandidateView { readonly candidateId: string; readonly claim: ConsensusCandidate["claim"]; readonly severity: ConsensusCandidate["severity"]; readonly blocker: boolean; readonly peerSources: readonly PresentedPeerSource[] }
export interface PeerReviewRequest { readonly reviewerId: string; readonly round: number; readonly candidates: readonly ReviewCandidateView[]; readonly instruction: "return_typed_issue_operations_with_evidence_ids" }
export interface PeerReviewRuntime { review(request: PeerReviewRequest): Promise<readonly PeerIssueOperation[]> }
export interface RoundDispatchRecord { readonly round: number; readonly reviewerId: string; readonly candidateIds: readonly string[]; readonly reasons: Readonly<Record<string, string>>; readonly peerPresentation: Readonly<Record<string, readonly PresentedPeerSource[]>> }
export interface PeerReviewRoundResult { readonly operations: readonly PeerIssueOperation[]; readonly dispatches: readonly RoundDispatchRecord[] }

export async function peerReviewRound(board: ConsensusBoard, policy: ConsensusPolicy, round: number, dependencies: { readonly auditors: readonly ConsensusAuditor[]; readonly rng: ReviewRng; readonly runtime: PeerReviewRuntime }): Promise<PeerReviewRoundResult> {
  if (!Number.isSafeInteger(round) || round < 1 || round > 3) throw new Error("PEER_REVIEW_ROUND_OUT_OF_RANGE");
  if (dependencies.auditors.length <= 1) return Object.freeze({ operations: Object.freeze([]), dispatches: Object.freeze([]) });
  const allCandidates = Object.values(board.candidates).sort((a, b) => a.candidateId.localeCompare(b.candidateId)); const operations: PeerIssueOperation[] = []; const dispatches: RoundDispatchRecord[] = [];
  const reviewerOrder = dependencies.rng.forActivity(`peer-review:${round}:reviewers`).shuffle([...dependencies.auditors]);
  for (const [reviewerIndex, reviewer] of reviewerOrder.entries()) {
    const rng = dependencies.rng.forActivity(`peer-review:${round}:${reviewer.auditorId}`); const selected = allCandidates.flatMap((candidate) => { const reason = selectionReason(candidate, policy, round, reviewerIndex, dependencies.auditors.length); return reason === null ? [] : [{ candidate, reason }]; });
    const views = rng.shuffle(selected.map(({ candidate }) => view(candidate, reviewer.auditorId, rng))); const reasons = Object.fromEntries(selected.map(({ candidate, reason }) => [candidate.candidateId, reason]));
    const request = Object.freeze({ reviewerId: reviewer.auditorId, round, candidates: Object.freeze(views), instruction: "return_typed_issue_operations_with_evidence_ids" as const });
    const returned = views.length === 0 ? [] : await dependencies.runtime.review(request);
    const presented = new Map(selected.map(({ candidate }) => [candidate.candidateId, candidate]));
    for (const operation of returned) validateReturnedOperation(operation, reviewer.auditorId, round, presented);
    operations.push(...returned); dispatches.push(Object.freeze({ round, reviewerId: reviewer.auditorId, candidateIds: Object.freeze(views.map(({ candidateId }) => candidateId)), reasons: Object.freeze(reasons), peerPresentation: Object.freeze(Object.fromEntries(views.map(({ candidateId, peerSources }) => [candidateId, peerSources]))) }));
  }
  return Object.freeze({ operations: Object.freeze(operations), dispatches: Object.freeze(dispatches) });
}

export async function runPeerReview(initialBoard: ConsensusBoard, dependencies: { readonly auditors: readonly ConsensusAuditor[]; readonly rng: ReviewRng; readonly runtime: PeerReviewRuntime; readonly apply: (board: ConsensusBoard, operations: readonly PeerIssueOperation[]) => Promise<ConsensusBoard>; readonly policy?: ConsensusPolicy; readonly maximumRounds?: number }): Promise<{ readonly board: ConsensusBoard; readonly consensus: ConsensusState; readonly operations: readonly PeerIssueOperation[]; readonly dispatches: readonly RoundDispatchRecord[]; readonly rounds: number }> {
  const policy = dependencies.policy ?? DEFAULT_CONSENSUS_POLICY; const maximumRounds = dependencies.maximumRounds ?? 3;
  if (!Number.isSafeInteger(maximumRounds) || maximumRounds < 1 || maximumRounds > 3) throw new Error("INVALID_PEER_REVIEW_MAXIMUM_ROUNDS");
  if (dependencies.auditors.length === 1) return Object.freeze({ board: initialBoard, consensus: computeConsensus(initialBoard, policy, { auditors: dependencies.auditors, round: 0, maximumRounds }), operations: Object.freeze([]), dispatches: Object.freeze([]), rounds: 0 });
  let board = initialBoard; const operations: PeerIssueOperation[] = []; const dispatches: RoundDispatchRecord[] = []; let consensus: ConsensusState | null = null;
  for (let round = 1; round <= maximumRounds; round += 1) {
    const result = await peerReviewRound(board, policy, round, dependencies); operations.push(...result.operations); dispatches.push(...result.dispatches); board = await dependencies.apply(board, result.operations); consensus = computeConsensus(board, policy, { auditors: dependencies.auditors, round, maximumRounds });
    if (consensus.candidates.every(({ outcome, reason }) => outcome !== "needs_verification" || reason !== "Consensus requirements are not yet satisfied.")) return Object.freeze({ board, consensus, operations: Object.freeze(operations), dispatches: Object.freeze(dispatches), rounds: round });
  }
  return Object.freeze({ board, consensus: consensus!, operations: Object.freeze(operations), dispatches: Object.freeze(dispatches), rounds: maximumRounds });
}

function selectionReason(candidate: ConsensusCandidate, policy: ConsensusPolicy, round: number, reviewerIndex: number, auditorCount: number): string | null {
  const dispositions = new Set(candidate.votes.map(({ disposition }) => disposition)); const disputed = dispositions.size > 1 || dispositions.has("needs_verification") || candidate.counterEvidence.length > 0 || (candidate.objections ?? []).some(({ resolvedBy }) => resolvedBy === null); const unresolved = candidate.status === "open" || candidate.status === "needs_verification";
  if (round === 2 && !(candidate.lastChangedRound >= 1 || disputed)) return null;
  if (round === 3 && !unresolved) return null;
  if (round > 1) return disputed ? "disputed" : "changed_or_unresolved";
  if (policy.name === "full") return "full_policy";
  if (policy.name === "minimal") return disputed || isHighRisk(candidate) || candidate.sourceFindingIds.length === 1 || candidate.lowConfidence === true ? "minimal_risk_or_dispute" : null;
  if (isHighRisk(candidate)) return "risk_weighted_all_auditors";
  return reviewerIndex < Math.min(policy.quorum, auditorCount) ? "risk_weighted_quorum" : null;
}
function view(candidate: ConsensusCandidate, reviewerId: string, rng: ReviewRng): ReviewCandidateView {
  const peerIds = [...new Set(candidate.sourceFindingIds.map((id) => id.split("/", 1)[0]!).filter((id) => id !== reviewerId))]; const labelPool = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) => `Auditor ${letter}`); const labels = rng.shuffle(labelPool.slice(0, peerIds.length)); const labelByPeer = new Map(rng.shuffle(peerIds).map((peer, index) => [peer, labels[index]! ]));
  const sources = candidate.sourceFindingIds.flatMap((id) => { const [author, ...rest] = id.split("/"); if (author === reviewerId || !labelByPeer.has(author!)) return []; const label = labelByPeer.get(author!)!; return [{ label, findingRef: `${label}/${rest.join("/")}` }]; });
  return Object.freeze({ candidateId: candidate.candidateId, claim: candidate.claim, severity: candidate.severity, blocker: candidate.blocker, peerSources: Object.freeze(rng.shuffle(sources)) });
}
function validateReturnedOperation(operation: PeerIssueOperation, reviewerId: string, round: number, candidates: ReadonlyMap<string, ConsensusCandidate>): void {
  const candidate = candidates.get(operation.candidateId);
  if (operation.authorId !== reviewerId || operation.round !== round || candidate === undefined) throw new Error("INVALID_PEER_REVIEW_OPERATION_PROVENANCE");
  if (["accept", "reject", "needs_verification", "change_severity", "change_blocker", "add_evidence", "add_counter_evidence"].includes(operation.type) && operation.citedEvidenceIds.length === 0) throw new Error(`PEER_OPERATION_REQUIRES_EVIDENCE:${operation.type}`);
  if (operation.type === "accept" || operation.type === "reject" || operation.type === "needs_verification") {
    const prior = [...candidate.votes].reverse().find(({ authorId }) => authorId === reviewerId);
    const addsEvidence = operation.citedEvidenceIds.some((id) => !prior?.citedEvidenceIds.includes(id));
    if (prior !== undefined && prior.disposition !== operation.type && !addsEvidence) throw new Error("CONFORMITY_VOTE_FLIP_WITHOUT_NEW_EVIDENCE");
  }
}
