import { createHash } from "node:crypto";
import type { CandidateSeed } from "@arbitra/core/issue-board/operations.js";
import type { ConsensusAuditor, ConsensusPolicy } from "@arbitra/workflow/consensus/engine.js";
import { modelConflictResolutionSchema } from "@arbitra/schemas/model-results.js";
import type { PeerOperationConflict } from "./peer-operation-conflicts.js";
import type { peerReviewView } from "./peer-review-view.js";

export interface ConflictResolutionVote {
  readonly reviewerId: string;
  readonly selection: string;
  readonly evidenceIds: readonly string[];
  readonly rationale: string;
}

export function conflictId(conflict: PeerOperationConflict): string {
  return createHash("sha256").update(JSON.stringify([...conflict.operationIds].sort())).digest("hex");
}

/** Expose proposal content, never author/operation/source identity. */
export function conflictResolutionView(conflict: PeerOperationConflict, view: ReturnType<typeof peerReviewView>, prior?: ConflictResolutionVote) {
  const proposalIds = new Map<string, string>();
  const findingAliases = new Map([...view.findingIds].map(([alias, id]) => [id, alias]));
  const seed = ({ title, description, severity, blocker, sourceFindingIds }: CandidateSeed) => ({ title, description, severity, blocker,
    sourceFindingRefs: sourceFindingIds.flatMap((id) => { const alias = findingAliases.get(id); return alias === undefined ? [] : [alias]; }),
    unshownSourceCount: sourceFindingIds.filter((id) => !findingAliases.has(id)).length,
  });
  const evidenceAliases = new Map([...view.evidenceIds].map(([alias, id]) => [id, alias]));
  const proposals = conflict.proposals.map((operation, index) => {
    const proposalId = `proposal-${index + 1}`;
    proposalIds.set(proposalId, operation.operationId);
    const common = { proposalId, type: operation.type, evidenceIds: operation.citedEvidenceIds.flatMap((id) => {
      const alias = evidenceAliases.get(id); return alias === undefined ? [] : [alias];
    }) };
    switch (operation.type) {
      case "merge": return { ...common, sourceCandidateIds: operation.sourceCandidateIds, candidate: seed(operation.candidate) };
      case "split": return { ...common, candidateId: operation.candidateId, candidates: operation.candidates.map(seed), reason: operation.reason };
      case "change_severity": return { ...common, candidateId: operation.candidateId, severity: operation.severity, reason: operation.reason };
      case "change_blocker": return { ...common, candidateId: operation.candidateId, blocker: operation.blocker, reason: operation.reason };
      default: throw new Error("INVALID_CONFLICT_PROPOSAL");
    }
  });
  const priorSelection = prior === undefined ? undefined : [...proposalIds].find(([, id]) => id === prior.selection)?.[0] ?? prior.selection;
  const previousDecision = prior === undefined ? null : { selection: priorSelection, rationale: prior.rationale, evidenceIds: prior.evidenceIds.flatMap((id) => { const alias = evidenceAliases.get(id); return alias === undefined ? [] : [alias]; }) };
  return { input: { reason: conflict.reason, candidates: view.candidates, proposals, previousDecision }, parse(value: unknown): Omit<ConflictResolutionVote, "reviewerId"> {
    const parsed = modelConflictResolutionSchema.parse(value);
    const selection = proposalIds.get(parsed.selection) ?? parsed.selection;
    if (!proposalIds.has(parsed.selection) && !["retain_original", "unresolved"].includes(parsed.selection)) throw new Error("UNKNOWN_CONFLICT_SELECTION");
    if (selection !== "unresolved" && parsed.evidenceIds.length === 0) throw new Error("CONFLICT_RESOLUTION_REQUIRES_EVIDENCE");
    const evidenceIds = parsed.evidenceIds.map((id) => {
      const resolved = view.evidenceIds.get(id); if (resolved === undefined) throw new Error("UNKNOWN_CONFLICT_EVIDENCE"); return resolved;
    });
    if (prior !== undefined && prior.selection !== selection && !evidenceIds.some((id) => !prior.evidenceIds.includes(id))) throw new Error("CONFORMITY_CONFLICT_FLIP_WITHOUT_NEW_EVIDENCE");
    return { selection, evidenceIds: [...new Set(evidenceIds)], rationale: parsed.rationale };
  } };
}

/** Structural resolution requires explicit agreement, not majority suppression of dissent.
 * Every configured auditor must respond; quorum and independence remain mandatory. */
export function agreedConflictResolution(votes: readonly ConflictResolutionVote[], auditors: readonly ConsensusAuditor[], policy: ConsensusPolicy): string | null {
  if (auditors.length < 2 || votes.length !== auditors.length || new Set(votes.map(({ reviewerId }) => reviewerId)).size !== votes.length) return null;
  if (auditors.some(({ auditorId }) => !votes.some(({ reviewerId }) => reviewerId === auditorId))) return null;
  const selection = votes[0]?.selection;
  if (selection === undefined || selection === "unresolved" || votes.some((vote) => vote.selection !== selection || vote.evidenceIds.length === 0)) return null;
  if (votes.length < policy.quorum || new Set(auditors.map(({ independenceGroup }) => independenceGroup)).size < policy.minimumIndependentGroupsForHighRisk) return null;
  return selection;
}
