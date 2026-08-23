import { describe, expect, it } from "vitest";
import { computeConsensus, DEFAULT_CONSENSUS_POLICY, type ConsensusAuditor, type ConsensusBoard, type ConsensusCandidate, type ConsensusPolicy } from "../../src/consensus/engine.js";
import { peerReviewRound, runPeerReview, type PeerReviewRequest, type ReviewRng } from "../../src/nodes/peer-review/round.js";

const auditors: ConsensusAuditor[] = [{ auditorId: "auditor-a", independenceGroup: "group-a" }, { auditorId: "auditor-b", independenceGroup: "group-b" }, { auditorId: "auditor-c", independenceGroup: "group-c" }];
function candidate(changes: Partial<ConsensusCandidate> = {}): ConsensusCandidate { return { candidateId: "C-1", claim: { title: "Authorization bypass", description: "Guard missing" }, sourceFindingIds: ["auditor-a/SEC-1", "auditor-b/SEC-2", "auditor-c/SEC-3"], severity: "high", blocker: true, status: "open", votes: [], evidence: [], counterEvidence: [], firstSeenRound: 0, lastChangedRound: 0, category: "SECURITY", ...changes }; }
function board(...candidates: ConsensusCandidate[]): ConsensusBoard { return { candidates: Object.fromEntries(candidates.map((item) => [item.candidateId, item])) }; }
const vote = (authorId: string, disposition: "accept" | "reject" | "needs_verification") => ({ authorId, disposition, citedEvidenceIds: [`ev-${authorId}`], reason: disposition });
class FixtureRng implements ReviewRng { constructor(private readonly seed: string) {} forActivity(id: string) { return new FixtureRng(`${this.seed}:${id}`); } shuffle<T>(items: T[]): T[] { const offset = [...this.seed].reduce((sum, char) => sum + char.charCodeAt(0), 0) % Math.max(1, items.length); return [...items.slice(offset), ...items.slice(0, offset)].reverse(); } }

describe("consensus semantics", () => {
  it("skips consensus for one auditor and labels findings single-source", () => { const state = computeConsensus(board(candidate()), DEFAULT_CONSENSUS_POLICY, { auditors: auditors.slice(0, 1), round: 0 }); expect(state.candidates[0]!.outcome).toBe("single_source"); });
  it("routes two-auditor material disagreement to verification without inventing a majority", () => { const state = computeConsensus(board(candidate({ votes: [vote("auditor-a", "accept"), vote("auditor-b", "reject")] })), DEFAULT_CONSENSUS_POLICY, { auditors: auditors.slice(0, 2), round: 1 }); expect(state.candidates[0]).toMatchObject({ outcome: "needs_verification", supportCount: 1, reviewDenominator: 2 }); });
  it("requires high-risk support across independence groups and preserves dissent", () => {
    const sameGroup = [{ auditorId: "auditor-a", independenceGroup: "same" }, { auditorId: "auditor-b", independenceGroup: "same" }, auditors[2]!] as const;
    const issue = candidate({ votes: [vote("auditor-a", "accept"), vote("auditor-b", "accept"), vote("auditor-c", "reject")] });
    expect(computeConsensus(board(issue), DEFAULT_CONSENSUS_POLICY, { auditors: sameGroup, round: 1 }).candidates[0]).toMatchObject({ outcome: "needs_verification", supportCount: 2, independentGroupsRepresented: 1 });
    const accepted = computeConsensus(board(issue), DEFAULT_CONSENSUS_POLICY, { auditors, round: 1 }).candidates[0]!; expect(accepted.outcome).toBe("accepted"); expect(accepted.dissent).toMatchObject([{ authorId: "auditor-c", disposition: "reject" }]);
  });
  it("escalates a qualifying high-risk minority objection rather than outvoting it", () => { const issue = candidate({ votes: [vote("auditor-a", "accept"), vote("auditor-b", "accept"), vote("auditor-c", "reject")], objections: [{ authorId: "auditor-c", reason: "reachable path", citesLocation: true, evidenceType: "repository", resolvedBy: null }] }); expect(computeConsensus(board(issue), DEFAULT_CONSENSUS_POLICY, { auditors, round: 1 }).candidates[0]).toMatchObject({ outcome: "needs_verification", escalateToVerification: true }); });
});

describe("peer review rounds", () => {
  it("replays identical randomized labels/order and hides each reviewer's own sources", async () => {
    const requestsA: PeerReviewRequest[] = []; const requestsB: PeerReviewRequest[] = [];
    const run = (requests: PeerReviewRequest[]) => peerReviewRound(board(candidate()), DEFAULT_CONSENSUS_POLICY, 1, { auditors, rng: new FixtureRng("run-1"), runtime: { async review(request) { requests.push(request); return []; } } });
    const first = await run(requestsA); const second = await run(requestsB); expect(first.dispatches).toEqual(second.dispatches); expect(requestsA).toEqual(requestsB);
    for (const request of requestsA) { const sources = request.candidates.flatMap(({ peerSources }) => peerSources.map(({ findingRef }) => findingRef)); expect(sources.some((source) => source.startsWith(request.reviewerId))).toBe(false); expect(sources.every((source) => /^Auditor [A-Z]\//u.test(source))).toBe(true); }
  });

  it("round two sends only changed or disputed delta candidates", async () => {
    const changed = candidate({ candidateId: "C-changed", lastChangedRound: 1 }); const stable = candidate({ candidateId: "C-stable", status: "accepted", lastChangedRound: 0 }); const requests: PeerReviewRequest[] = [];
    await peerReviewRound(board(changed, stable), DEFAULT_CONSENSUS_POLICY, 2, { auditors, rng: new FixtureRng("delta"), runtime: { async review(request) { requests.push(request); return []; } } });
    expect(requests.flatMap(({ candidates }) => candidates.map(({ candidateId }) => candidateId))).not.toContain("C-stable"); expect(requests.every(({ candidates }) => candidates.map(({ candidateId }) => candidateId).includes("C-changed"))).toBe(true);
  });

  it("implements full, risk-weighted, and minimal selection", async () => {
    const low = candidate({ candidateId: "C-low", severity: "low", blocker: false, category: "DOCUMENTATION", sourceFindingIds: ["auditor-a/LOW", "auditor-b/LOW"], lowConfidence: false });
    const counts = async (policy: ConsensusPolicy) => (await peerReviewRound(board(low), policy, 1, { auditors, rng: new FixtureRng(policy.name), runtime: { async review() { return []; } } })).dispatches.filter(({ candidateIds }) => candidateIds.length > 0).length;
    expect(await counts({ ...DEFAULT_CONSENSUS_POLICY, name: "full" })).toBe(3); expect(await counts(DEFAULT_CONSENSUS_POLICY)).toBe(2); expect(await counts({ ...DEFAULT_CONSENSUS_POLICY, name: "minimal" })).toBe(0);
  });

  it("stops at three rounds with explicit non-consensus", async () => {
    const result = await runPeerReview(board(candidate()), { auditors, rng: new FixtureRng("cap"), runtime: { async review() { return []; } }, async apply(current) { return current; }, maximumRounds: 3 });
    expect(result.rounds).toBe(3); expect(result.consensus).toMatchObject({ exhausted: true, candidates: [{ candidateId: "C-1", outcome: "non_consensus" }] });
  });
});
