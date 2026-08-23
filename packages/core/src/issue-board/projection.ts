import { assertIssueOperation, type CandidateSeed, type IssueEvidence, type IssueOperation, type IssueSeverity } from "./operations.js";

export interface IssueVote { readonly authorId: string; readonly disposition: "accept" | "reject" | "needs_verification"; readonly reason: string; readonly round: number; readonly citedEvidenceIds: readonly string[] }
export interface IssueCandidate {
  readonly candidateId: string; readonly claim: { readonly title: string; readonly description: string }; readonly sourceFindingIds: readonly string[];
  readonly evidence: readonly IssueEvidence[]; readonly counterEvidence: readonly IssueEvidence[]; readonly severity: IssueSeverity; readonly blocker: boolean;
  readonly votes: readonly IssueVote[]; readonly remediationSupplements: readonly string[]; readonly verificationSupplements: readonly string[];
  readonly parentCandidateIds: readonly string[]; readonly childCandidateIds: readonly string[]; readonly firstSeenRound: number; readonly lastChangedRound: number;
  readonly status: "open" | "accepted" | "rejected" | "needs_verification" | "merged" | "split";
}
export interface IssueBoard { readonly candidates: Readonly<Record<string, IssueCandidate>>; readonly operationIds: readonly string[] }
interface MutableCandidate { candidateId: string; claim: { title: string; description: string }; sourceFindingIds: string[]; evidence: IssueEvidence[]; counterEvidence: IssueEvidence[]; severity: IssueSeverity; blocker: boolean; votes: IssueVote[]; remediationSupplements: string[]; verificationSupplements: string[]; parentCandidateIds: string[]; childCandidateIds: string[]; firstSeenRound: number; lastChangedRound: number; status: IssueCandidate["status"] }

export function projectBoard(operations: readonly IssueOperation[]): IssueBoard {
  const candidates = new Map<string, MutableCandidate>(); const operationIds = new Set<string>();
  for (const operation of operations) {
    assertIssueOperation(operation); if (operationIds.has(operation.operationId)) throw new Error(`DUPLICATE_ISSUE_OPERATION:${operation.operationId}`); operationIds.add(operation.operationId);
    switch (operation.type) {
      case "add_candidate": add(candidates, operation.candidate, operation.round, [], []); break;
      case "add_missing_finding": { const candidate = add(candidates, operation.candidate, operation.round, [], []); candidate.evidence.push(...operation.evidence); break; }
      case "accept": case "reject": case "needs_verification": { const candidate = requireCandidate(candidates, operation.candidateId); candidate.votes.push(Object.freeze({ authorId: operation.authorId, disposition: operation.type, reason: operation.reason, round: operation.round, citedEvidenceIds: Object.freeze([...operation.citedEvidenceIds]) })); candidate.status = operation.type === "needs_verification" ? "needs_verification" : operation.type === "accept" ? "accepted" : "rejected"; changed(candidate, operation.round); break; }
      case "add_evidence": case "add_counter_evidence": { const candidate = requireCandidate(candidates, operation.candidateId); (operation.type === "add_evidence" ? candidate.evidence : candidate.counterEvidence).push(operation.evidence); changed(candidate, operation.round); break; }
      case "change_severity": { const candidate = requireCandidate(candidates, operation.candidateId); candidate.severity = operation.severity; changed(candidate, operation.round); break; }
      case "change_blocker": { const candidate = requireCandidate(candidates, operation.candidateId); candidate.blocker = operation.blocker; changed(candidate, operation.round); break; }
      case "supplement_remediation": case "supplement_verification": { const candidate = requireCandidate(candidates, operation.candidateId); (operation.type === "supplement_remediation" ? candidate.remediationSupplements : candidate.verificationSupplements).push(operation.text); changed(candidate, operation.round); break; }
      case "merge": { const sources = operation.sourceCandidateIds.map((id) => requireCandidate(candidates, id)); const target = add(candidates, operation.candidate, operation.round, operation.sourceCandidateIds, []); for (const source of sources) { source.status = "merged"; source.childCandidateIds.push(target.candidateId); changed(source, operation.round); } break; }
      case "split": { const source = requireCandidate(candidates, operation.candidateId); source.status = "split"; for (const seed of operation.candidates) { add(candidates, seed, operation.round, [source.candidateId], []); source.childCandidateIds.push(seed.candidateId); } changed(source, operation.round); break; }
    }
  }
  return Object.freeze({ candidates: Object.freeze(Object.fromEntries([...candidates].sort(([a], [b]) => a.localeCompare(b)).map(([id, candidate]) => [id, freezeCandidate(candidate)]))), operationIds: Object.freeze([...operationIds]) });
}

export function boardDelta(board: IssueBoard, sinceRound: number): readonly IssueCandidate[] { if (!Number.isSafeInteger(sinceRound) || sinceRound < -1) throw new Error("INVALID_DELTA_ROUND"); return Object.freeze(Object.values(board.candidates).filter(({ lastChangedRound }) => lastChangedRound > sinceRound).sort((a, b) => a.candidateId.localeCompare(b.candidateId))); }
export interface IssueOperationSink { append(operation: IssueOperation): Promise<void> }
export class IssueBoardController {
  readonly #operations: IssueOperation[];
  constructor(private readonly sink: IssueOperationSink, initial: readonly IssueOperation[] = []) { projectBoard(initial); this.#operations = [...initial]; }
  async append(operation: IssueOperation): Promise<void> { assertIssueOperation(operation); projectBoard([...this.#operations, operation]); await this.sink.append(operation); this.#operations.push(operation); }
  project(): IssueBoard { return projectBoard(this.#operations); }
  delta(sinceRound: number): readonly IssueCandidate[] { return boardDelta(this.project(), sinceRound); }
}
function add(candidates: Map<string, MutableCandidate>, seed: CandidateSeed, round: number, parents: readonly string[], children: readonly string[]): MutableCandidate { if (candidates.has(seed.candidateId)) throw new Error(`DUPLICATE_ISSUE_CANDIDATE:${seed.candidateId}`); const value: MutableCandidate = { candidateId: seed.candidateId, claim: { title: seed.title, description: seed.description }, sourceFindingIds: [...seed.sourceFindingIds], evidence: [], counterEvidence: [], severity: seed.severity, blocker: seed.blocker, votes: [], remediationSupplements: [], verificationSupplements: [], parentCandidateIds: [...parents], childCandidateIds: [...children], firstSeenRound: round, lastChangedRound: round, status: "open" }; candidates.set(seed.candidateId, value); return value; }
function requireCandidate(candidates: Map<string, MutableCandidate>, id: string): MutableCandidate { const value = candidates.get(id); if (value === undefined) throw new Error(`UNKNOWN_ISSUE_CANDIDATE:${id}`); return value; }
function changed(candidate: MutableCandidate, round: number): void { if (round < candidate.firstSeenRound) throw new Error("ISSUE_OPERATION_ROUND_REGRESSION"); candidate.lastChangedRound = Math.max(candidate.lastChangedRound, round); }
function freezeCandidate(value: MutableCandidate): IssueCandidate { return Object.freeze({ ...value, claim: Object.freeze({ ...value.claim }), sourceFindingIds: Object.freeze([...value.sourceFindingIds]), evidence: Object.freeze([...value.evidence]), counterEvidence: Object.freeze([...value.counterEvidence]), votes: Object.freeze([...value.votes]), remediationSupplements: Object.freeze([...value.remediationSupplements]), verificationSupplements: Object.freeze([...value.verificationSupplements]), parentCandidateIds: Object.freeze([...value.parentCandidateIds]), childCandidateIds: Object.freeze([...value.childCandidateIds]) }); }
