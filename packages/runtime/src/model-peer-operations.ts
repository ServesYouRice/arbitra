import { assertIssueOperation, type CandidateSeed, type IssueEvidence, type IssueOperation } from "@arbitra/core/issue-board/operations.js";
import { peerOperationsResultSchema } from "@arbitra/schemas/peer-operations.js";
import type { FindingLocation } from "@arbitra/schemas/finding.js";
import type { AuditFinding } from "./auditors.js";
import type { RepositorySnapshot } from "./repository.js";
import type { peerReviewView } from "./peer-review-view.js";
import { createHash } from "node:crypto";
import { redactSecrets } from "@arbitra/security/redaction";

type View = ReturnType<typeof peerReviewView>;
export interface PeerOperationBatch { readonly operations: readonly IssueOperation[]; readonly findings: readonly AuditFinding[]; readonly locations: readonly FindingLocation[] }

/** Validate model additions against immutable source and bind all local provenance. */
export function translatePeerOperations(value: unknown, view: View, snapshot: RepositorySnapshot, reviewerId: string, round: number, scopeId?: string): PeerOperationBatch {
  const parsed = peerOperationsResultSchema.parse(value);
  if (scopeId !== undefined && !/^[a-z0-9-]+$/u.test(scopeId)) throw new Error("INVALID_PEER_SCOPE_ID");
  const prefix = `${reviewerId}/review-${round}/${scopeId === undefined ? "" : `${scopeId}/`}`;
  const local = (id: string): string => {
    if (!/^new:[A-Za-z0-9_-]+$/u.test(id)) throw new Error("INVALID_PEER_LOCAL_ID");
    return `${prefix}${id.slice(4)}`;
  };
  const newCandidate = (id: string): string => `C-${createHash("sha256").update(local(id)).digest("hex").slice(0, 24)}`;
  const locations = new Map<string, FindingLocation>();
  for (const entry of [...parsed.locations, ...parsed.findings.flatMap(({ locations }) => locations)]) {
    const id = local(entry.id);
    const file = snapshot.files.find(({ path }) => path === entry.path);
    // Models restate a declared location inside the finding that cites it (observed live).
    // An identical restatement is the same location; a conflicting reuse of the ID is not.
    const existing = locations.get(entry.id);
    if (existing !== undefined && existing.path === entry.path && existing.startLine === entry.startLine && existing.endLine === entry.endLine) continue;
    if (existing !== undefined || file === undefined || entry.endLine < entry.startLine || entry.endLine > file.lines.length) throw new Error("INVALID_PEER_LOCATION");
    locations.set(entry.id, { ...entry, id });
  }
  const newEvidence = new Map<string, IssueEvidence>();
  const evidence = (entry: IssueEvidence): IssueEvidence => {
    const id = local(entry.id);
    if (entry.locationIds.length === 0) throw new Error("UNGROUNDED_PEER_EVIDENCE");
    const resolved = entry.locationIds.map((locationId) => {
      const location = locations.get(locationId);
      if (location === undefined) throw new Error("UNKNOWN_PEER_LOCATION");
      const file = snapshot.files.find(({ path }) => path === location.path);
      if (file === undefined || !redactSecrets(file.lines.slice(location.startLine - 1, location.endLine).join("\n")).text.includes(entry.text)) throw new Error("UNGROUNDED_PEER_EVIDENCE");
      return location.id;
    });
    const result = { ...entry, id, locationIds: resolved };
    const prior = newEvidence.get(entry.id);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(result)) throw new Error("CONFLICTING_PEER_EVIDENCE");
    newEvidence.set(entry.id, result);
    return result;
  };
  const findings: AuditFinding[] = parsed.findings.map((finding) => {
    const suffix = finding.sourceFindingId.startsWith("self/") ? finding.sourceFindingId.slice(5) : "";
    const sourceFindingId = local(`new:${suffix}`);
    if (finding.evidence.length === 0) throw new Error("PEER_FINDING_REQUIRES_EVIDENCE");
    if (finding.evidence.some(({ locationIds }) => locationIds.some((id) => !finding.locations.some((location) => location.id === id)))) throw new Error("PEER_FINDING_LOCATION_MISMATCH");
    return { ...finding, sourceFindingId, locations: finding.locations.map((location) => {
      const resolved = locations.get(location.id); if (resolved === undefined) throw new Error("UNKNOWN_PEER_LOCATION"); return resolved;
    }), evidence: finding.evidence.map(evidence) };
  });
  const sourceIds = new Map(view.findingIds);
  for (const [index, finding] of parsed.findings.entries()) {
    const resolved = findings[index];
    if (resolved === undefined || sourceIds.has(finding.sourceFindingId)) throw new Error("DUPLICATE_PEER_FINDING");
    sourceIds.set(finding.sourceFindingId, resolved.sourceFindingId);
  }
  for (const operation of parsed.operations) {
    if (operation.type === "add_evidence" || operation.type === "add_counter_evidence") evidence(operation.evidence);
    if (operation.type === "add_missing_finding") operation.evidence.forEach(evidence);
  }
  const citation = (id: string): string => {
    const resolved = view.evidenceIds.get(id) ?? newEvidence.get(id)?.id;
    if (resolved === undefined) throw new Error("UNKNOWN_PEER_EVIDENCE");
    return resolved;
  };
  const candidateId = (id: string): string => id.startsWith("new:") ? newCandidate(id) : Object.hasOwn(view.candidates, id) ? id : (() => { throw new Error("UNPRESENTED_PEER_CANDIDATE"); })();
  const seed = (candidate: CandidateSeed): CandidateSeed => ({ ...candidate, candidateId: newCandidate(candidate.candidateId), sourceFindingIds: candidate.sourceFindingIds.map((id) => {
    const resolved = sourceIds.get(id); if (resolved === undefined) throw new Error("UNKNOWN_PEER_SOURCE_FINDING"); return resolved;
  }) });
  const seen = new Set<string>();
  const operations: IssueOperation[] = parsed.operations.map((operation): IssueOperation => {
    if (operation.authorId !== "self" || operation.round !== round || "verification" in operation || operation.type === "add_candidate") throw new Error("INVALID_MODEL_OPERATION_AUTHORITY");
    const operationId = local(operation.operationId);
    if (seen.has(operationId)) throw new Error("DUPLICATE_PEER_OPERATION");
    seen.add(operationId);
    const base = { ...operation, operationId, authorId: reviewerId, candidateId: candidateId(operation.candidateId), citedEvidenceIds: operation.citedEvidenceIds.map(citation) };
    let result: IssueOperation;
    switch (operation.type) {
      case "merge": result = { ...base, type: "merge", sourceCandidateIds: operation.sourceCandidateIds.map(candidateId), candidate: seed(operation.candidate) }; break;
      case "split": result = { ...base, type: "split", candidates: operation.candidates.map(seed), reason: operation.reason }; break;
      case "add_missing_finding": result = { ...base, type: "add_missing_finding", candidate: seed(operation.candidate), evidence: operation.evidence.map(evidence) }; break;
      case "add_evidence": case "add_counter_evidence": result = { ...base, type: operation.type, evidence: evidence(operation.evidence) }; break;
      default: result = base as IssueOperation;
    }
    assertIssueOperation(result);
    if (result.type === "add_missing_finding") {
      const sourceEvidence = new Set(findings.filter(({ sourceFindingId }) => result.candidate.sourceFindingIds.includes(sourceFindingId)).flatMap(({ evidence }) => evidence.map(({ id }) => id)));
      const addedEvidence = new Set(result.evidence.map(({ id }) => id));
      if (sourceEvidence.size !== addedEvidence.size || [...sourceEvidence].some((id) => !addedEvidence.has(id))) throw new Error("PEER_MISSING_FINDING_EVIDENCE_MISMATCH");
    }
    // Existing aliases must belong to the referenced candidate(s), not another
    // candidate that happened to be present in the same request.
    const referenced = operation.type === "merge" ? operation.sourceCandidateIds : [operation.candidateId];
    const targets = operation.type === "merge" || operation.type === "add_missing_finding" ? [operation.candidate] : operation.type === "split" ? operation.candidates : [];
    const allowedSources = new Set(operation.type === "add_missing_finding" ? parsed.findings.map(({ sourceFindingId }) => sourceFindingId) : referenced.flatMap((id) => view.candidates[id]?.sources.map(({ findingRef }) => findingRef) ?? []));
    if (targets.some(({ sourceFindingIds }) => sourceFindingIds.some((id) => !allowedSources.has(id)))) throw new Error("CROSS_CANDIDATE_PEER_SOURCE");
    const allowed = new Set(referenced.flatMap((id) => view.candidates[id]?.sources.flatMap(({ evidence }) => evidence.map(({ id }) => id)) ?? []));
    const allowedNew = new Set(parsed.operations.filter((other) => referenced.includes(other.candidateId)).flatMap((other) => other.type === "add_evidence" || other.type === "add_counter_evidence" ? [other.evidence.id] : other.type === "add_missing_finding" ? other.evidence.map(({ id }) => id) : []));
    if (operation.citedEvidenceIds.some((id) => !allowedNew.has(id) && !allowed.has(id))) throw new Error("CROSS_CANDIDATE_PEER_EVIDENCE");
    return result;
  });
  const votes = operations.filter(({ type }) => type === "accept" || type === "reject" || type === "needs_verification");
  if (new Set(votes.map(({ candidateId }) => candidateId)).size !== votes.length) throw new Error("DUPLICATE_PEER_VOTE");
  for (const finding of findings) if (!operations.some((operation) => operation.type === "add_missing_finding" && operation.candidate.sourceFindingIds.includes(finding.sourceFindingId))) throw new Error("UNATTACHED_PEER_FINDING");
  return { operations, findings, locations: [...locations.values()] };
}
