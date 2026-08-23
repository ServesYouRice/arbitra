export type IssueSeverity = "critical" | "high" | "medium" | "low" | "informational";
export interface IssueEvidence { readonly id: string; readonly text: string; readonly locationIds: readonly string[] }
export interface CandidateSeed { readonly candidateId: string; readonly title: string; readonly description: string; readonly sourceFindingIds: readonly string[]; readonly severity: IssueSeverity; readonly blocker: boolean }
interface BaseOperation { readonly operationId: string; readonly candidateId: string; readonly authorId: string; readonly round: number; readonly citedEvidenceIds: readonly string[] }
export type IssueOperation =
  | (BaseOperation & { readonly type: "add_candidate"; readonly candidate: CandidateSeed })
  | (BaseOperation & { readonly type: "add_missing_finding"; readonly candidate: CandidateSeed; readonly evidence: readonly IssueEvidence[] })
  | (BaseOperation & { readonly type: "accept" | "reject" | "needs_verification"; readonly reason: string })
  | (BaseOperation & { readonly type: "merge"; readonly sourceCandidateIds: readonly string[]; readonly candidate: CandidateSeed })
  | (BaseOperation & { readonly type: "split"; readonly candidates: readonly CandidateSeed[]; readonly reason: string })
  | (BaseOperation & { readonly type: "add_evidence" | "add_counter_evidence"; readonly evidence: IssueEvidence })
  | (BaseOperation & { readonly type: "change_severity"; readonly severity: IssueSeverity; readonly reason: string })
  | (BaseOperation & { readonly type: "change_blocker"; readonly blocker: boolean; readonly reason: string })
  | (BaseOperation & { readonly type: "supplement_remediation" | "supplement_verification"; readonly text: string });

const EVIDENCE_REQUIRED = new Set<IssueOperation["type"]>(["accept", "reject", "needs_verification", "add_evidence", "add_counter_evidence", "change_severity", "change_blocker", "add_missing_finding"]);

export function assertIssueOperation(operation: IssueOperation): void {
  for (const [name, value] of [["operationId", operation.operationId], ["candidateId", operation.candidateId], ["authorId", operation.authorId]] as const) if (value.trim() === "") throw new Error(`INVALID_ISSUE_OPERATION:${name}`);
  if (!Number.isSafeInteger(operation.round) || operation.round < 0) throw new Error("INVALID_ISSUE_OPERATION:round");
  if (EVIDENCE_REQUIRED.has(operation.type) && operation.citedEvidenceIds.length === 0) throw new Error(`ISSUE_OPERATION_REQUIRES_EVIDENCE:${operation.type}`);
  if (operation.type === "add_candidate") assertCandidate(operation.candidate, operation.candidateId);
  if (operation.type === "add_missing_finding") { assertCandidate(operation.candidate, operation.candidateId); if (operation.evidence.length === 0) throw new Error("MISSING_FINDING_REQUIRES_EVIDENCE"); }
  if (operation.type === "merge") { assertCandidate(operation.candidate, operation.candidateId); if (operation.sourceCandidateIds.length < 2 || new Set(operation.sourceCandidateIds).size !== operation.sourceCandidateIds.length) throw new Error("INVALID_MERGE_SOURCES"); }
  if (operation.type === "split") { if (operation.candidates.length < 2 || new Set(operation.candidates.map(({ candidateId }) => candidateId)).size !== operation.candidates.length) throw new Error("INVALID_SPLIT_TARGETS"); for (const candidate of operation.candidates) assertCandidate(candidate, candidate.candidateId); }
  if ((operation.type === "add_evidence" || operation.type === "add_counter_evidence") && !operation.citedEvidenceIds.includes(operation.evidence.id)) throw new Error("ISSUE_EVIDENCE_ID_NOT_CITED");
  if ("reason" in operation && operation.reason.trim() === "") throw new Error("INVALID_ISSUE_OPERATION:reason");
  if ("text" in operation && operation.text.trim() === "") throw new Error("INVALID_ISSUE_OPERATION:text");
}
function assertCandidate(candidate: CandidateSeed, expectedId: string): void { if (candidate.candidateId !== expectedId || candidate.title.trim() === "" || candidate.description.trim() === "" || candidate.sourceFindingIds.length === 0) throw new Error("INVALID_CANDIDATE_SEED"); }
