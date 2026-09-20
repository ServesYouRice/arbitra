import { projectBoard, type IssueBoard } from "@arbitra/core/issue-board/projection.js";
import type { IssueOperation } from "@arbitra/core/issue-board/operations.js";
import type { ConsensusCandidate } from "@arbitra/workflow/consensus/engine.js";
import type { ConvergenceResult } from "./pipeline.js";
import type { AuditFinding } from "./auditors.js";
import type { PeerOperationBatch } from "./model-peer-operations.js";
import { adjudicatePeerOperations, type PeerOperationConflict } from "./peer-operation-conflicts.js";
import { conflictId, type ConflictResolutionVote } from "./model-conflict-resolution.js";

/** Rebuildable append-only board plus the source records required downstream. */
export class ModelPeerBoard {
  readonly operations: IssueOperation[] = [];
  readonly conflicts: PeerOperationConflict[] = [];
  readonly resolvedConflicts: { conflict: PeerOperationConflict; selection: string; round: number; votes: readonly ConflictResolutionVote[] }[] = [];
  private readonly findings = new Map<string, AuditFinding>();
  private readonly additions = new Map<string, AuditFinding[]>();

  constructor(initial: ConvergenceResult) {
    for (const candidate of Object.values(initial.board.candidates)) {
      const members = (initial.candidateFindings[candidate.candidateId] ?? []).map(namespaceFinding);
      for (const finding of members) this.findings.set(finding.sourceFindingId, finding);
      const base = { authorId: "discovery", round: 0, candidateId: candidate.candidateId, citedEvidenceIds: [] };
      this.operations.push({ ...base, operationId: `seed:${candidate.candidateId}`, type: "add_candidate", candidate: { candidateId: candidate.candidateId, title: candidate.claim.title, description: candidate.claim.description, severity: candidate.severity, blocker: candidate.blocker, sourceFindingIds: candidate.sourceFindingIds } });
      members.flatMap(({ evidence }) => evidence).forEach((evidence, index) => this.operations.push({ ...base, operationId: `seed:${candidate.candidateId}:evidence:${index}`, type: "add_evidence", evidence, citedEvidenceIds: [evidence.id] }));
    }
  }

  apply(batches: readonly PeerOperationBatch[]): void {
    const adjudication = adjudicatePeerOperations(batches.flatMap(({ operations }) => operations));
    const incoming = adjudication.accepted;
    // Reviews are independent against the pre-round board. Apply their evidence and
    // votes before retiring a source via a structural operation from another review.
    const ordered = [...incoming.filter(({ type }) => type !== "merge" && type !== "split"), ...incoming.filter(({ type }) => type === "merge" || type === "split")];
    projectBoard([...this.operations, ...ordered]);
    for (const batch of batches) {
      for (const finding of batch.findings) {
        if (this.findings.has(finding.sourceFindingId)) throw new Error("DUPLICATE_BOARD_SOURCE_FINDING");
        this.findings.set(finding.sourceFindingId, finding);
      }
      for (const operation of batch.operations) {
        if (operation.type !== "add_evidence" && operation.type !== "add_counter_evidence") continue;
        const source = this.view().candidateFindings[operation.candidateId]?.[0];
        if (source === undefined) throw new Error("BOARD_SOURCE_FINDING_ABSENT");
        const finding: AuditFinding = { ...source, sourceFindingId: `${operation.operationId}/evidence`, locations: batch.locations.filter(({ id }) => operation.evidence.locationIds.includes(id)), evidence: [operation.evidence] };
        const entries = this.additions.get(operation.candidateId) ?? [];
        entries.push(finding); this.additions.set(operation.candidateId, entries);
      }
    }
    this.operations.push(...ordered);
    this.conflicts.push(...adjudication.conflicts);
  }

  resolve(conflict: PeerOperationConflict, selection: string, round: number, votes: readonly ConflictResolutionVote[]): void {
    const index = this.conflicts.indexOf(conflict);
    if (index < 0) throw new Error("UNKNOWN_BOARD_CONFLICT");
    const active = this.view().candidates;
    if (conflict.candidateIds.some((id) => !Object.hasOwn(active, id))) throw new Error("STALE_BOARD_CONFLICT");
    if (selection !== "retain_original") {
      const proposal = conflict.proposals.find(({ operationId }) => operationId === selection);
      if (proposal === undefined) throw new Error("UNKNOWN_BOARD_CONFLICT_PROPOSAL");
      const operation = { ...proposal, operationId: `resolution:${conflictId(conflict)}:${round}`, authorId: "peer-resolution", round };
      projectBoard([...this.operations, operation]);
      this.operations.push(operation);
    }
    this.resolvedConflicts.push({ conflict, selection, round, votes: structuredClone(votes) });
    this.conflicts.splice(index, 1);
  }

  view(): { board: IssueBoard; candidates: Record<string, ConsensusCandidate>; candidateFindings: Record<string, readonly AuditFinding[]> } {
    const board = projectBoard(this.operations);
    const candidateFindings: Record<string, readonly AuditFinding[]> = {};
    const candidates: Record<string, ConsensusCandidate> = {};
    const extras = (id: string): AuditFinding[] => [...(this.additions.get(id) ?? []), ...(board.candidates[id]?.parentCandidateIds ?? []).flatMap(extras)];
    const lineage = (id: string): string[] => [id, ...(board.candidates[id]?.parentCandidateIds ?? []).flatMap(lineage)];
    for (const candidate of Object.values(board.candidates)) {
      if (candidate.status === "merged" || candidate.status === "split") continue;
      const members = [...candidate.sourceFindingIds.flatMap((id) => { const finding = this.findings.get(id); return finding === undefined ? [] : [finding]; }), ...extras(candidate.candidateId)];
      const uniqueMembers = [...new Map(members.map((finding) => [finding.sourceFindingId, finding])).values()];
      candidateFindings[candidate.candidateId] = uniqueMembers;
      const latestVotes = [...new Map(candidate.votes.map((vote) => [vote.authorId, vote])).values()];
      candidates[candidate.candidateId] = { ...candidate, sourceFindingIds: uniqueMembers.map(({ sourceFindingId }) => sourceFindingId), ...(members[0] === undefined ? {} : { category: members[0].category }),
        unresolvedOperationIds: this.conflicts.filter(({ candidateIds }) => candidateIds.some((id) => lineage(candidate.candidateId).includes(id))).flatMap(({ operationIds }) => operationIds),
        votes: latestVotes, objections: latestVotes.filter(({ disposition }) => disposition === "reject").map(({ authorId, reason, citedEvidenceIds }) => ({ authorId, reason, citesLocation: citedEvidenceIds.length > 0, evidenceType: "repository", resolvedBy: null })) };
    }
    return { board, candidates, candidateFindings };
  }
}

function namespaceFinding(finding: AuditFinding): AuditFinding {
  const locations = new Map(finding.locations.map(({ id }) => [id, `${finding.sourceFindingId}/location/${id}`]));
  return { ...finding, locations: finding.locations.map((location) => ({ ...location, id: locations.get(location.id) ?? location.id })), evidence: finding.evidence.map((evidence) => ({ ...evidence, id: `${finding.sourceFindingId}/evidence/${evidence.id}`, locationIds: evidence.locationIds.map((id) => {
    const resolved = locations.get(id); if (resolved === undefined) throw new Error("BOARD_EVIDENCE_LOCATION_ABSENT"); return resolved;
  }) })) };
}
