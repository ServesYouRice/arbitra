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
    if (!/^new:[A-Za-z0-9_-]+$/u.test(id)) throw new Error(`INVALID_PEER_LOCAL_ID: "${id.slice(0, 80)}" is used where a new identifier is required; operation IDs, added evidence and location IDs, and the candidateId of every candidate created by merge, split or add_missing_finding must be new:<letters, digits, _ or -> and never a presented ID`);
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
    if (existing !== undefined || file === undefined || entry.endLine < entry.startLine || entry.endLine > file.lines.length) throw new Error("INVALID_PEER_LOCATION: a location must name a snapshot file with 1 <= startLine <= endLine <= its line count, and one location ID may not describe two ranges");
    locations.set(entry.id, { ...entry, id });
  }
  const newEvidence = new Map<string, IssueEvidence>();
  const evidence = (entry: IssueEvidence): IssueEvidence => {
    const id = local(entry.id);
    if (entry.locationIds.length === 0) throw new Error("UNGROUNDED_PEER_EVIDENCE: evidence text must be copied exactly from the lines of the locations it cites, and cite at least one location");
    const resolved = entry.locationIds.map((locationId) => {
      const location = locations.get(locationId);
      if (location === undefined) throw new Error("UNKNOWN_PEER_LOCATION: evidence and findings may only cite location IDs declared in locations or in the same finding");
      const file = snapshot.files.find(({ path }) => path === location.path);
      const quoted = (start: number) => file !== undefined && redactSecrets(file.lines.slice(start - 1, start - 1 + location.endLine - location.startLine + 1).join("\n")).text.includes(entry.text);
      if (file !== undefined && !quoted(location.startLine)) {
        // The reviewer's own new location, miscounted by a line or two (observed live): move it
        // to the one nearby range of the same length that holds the exact quotation.
        const nearby = [1, -1, 2, -2, 3, -3].map((offset) => location.startLine + offset).filter((start) => start >= 1 && start + location.endLine - location.startLine <= file.lines.length && quoted(start));
        if (nearby.length === 1 && nearby[0] !== undefined && entry.text.trim() !== "") locations.set(locationId, { ...location, startLine: nearby[0], endLine: nearby[0] + location.endLine - location.startLine });
      }
      const anchored = locations.get(locationId) ?? location;
      if (file === undefined || !redactSecrets(file.lines.slice(anchored.startLine - 1, anchored.endLine).join("\n")).text.includes(entry.text)) throw new Error("UNGROUNDED_PEER_EVIDENCE: evidence text must be copied exactly from the lines of the locations it cites, and cite at least one location");
      return location.id;
    });
    const result = { ...entry, id, locationIds: resolved };
    const prior = newEvidence.get(entry.id);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(result)) throw new Error("CONFLICTING_PEER_EVIDENCE: one evidence ID was given two different contents");
    newEvidence.set(entry.id, result);
    return result;
  };
  const findings: AuditFinding[] = parsed.findings.map((finding) => {
    const suffix = finding.sourceFindingId.startsWith("self/") ? finding.sourceFindingId.slice(5) : "";
    const sourceFindingId = local(`new:${suffix}`);
    if (finding.evidence.length === 0) throw new Error("PEER_FINDING_REQUIRES_EVIDENCE: every finding needs at least one evidence entry");
    if (finding.evidence.some(({ locationIds }) => locationIds.some((id) => !finding.locations.some((location) => location.id === id)))) throw new Error("PEER_FINDING_LOCATION_MISMATCH: a finding's evidence may only cite that finding's own locations");
    const grounded = finding.evidence.map(evidence);
    return { ...finding, sourceFindingId, locations: finding.locations.map((location) => {
      const resolved = locations.get(location.id); if (resolved === undefined) throw new Error("UNKNOWN_PEER_LOCATION: evidence and findings may only cite location IDs declared in locations or in the same finding"); return resolved;
    }), evidence: grounded };
  });
  const sourceIds = new Map(view.findingIds);
  for (const [index, finding] of parsed.findings.entries()) {
    const resolved = findings[index];
    if (resolved === undefined || sourceIds.has(finding.sourceFindingId)) throw new Error("DUPLICATE_PEER_FINDING: each finding needs a distinct self/<name> sourceFindingId that is not a presented finding");
    sourceIds.set(finding.sourceFindingId, resolved.sourceFindingId);
  }
  for (const operation of parsed.operations) {
    if (operation.type === "add_evidence" || operation.type === "add_counter_evidence") evidence(operation.evidence);
    if (operation.type === "add_missing_finding") operation.evidence.forEach(evidence);
  }
  const citation = (id: string): string => {
    const resolved = view.evidenceIds.get(id) ?? newEvidence.get(id)?.id;
    if (resolved === undefined) throw new Error("UNKNOWN_PEER_EVIDENCE: citedEvidenceIds must be presented evidence IDs or new evidence added in this reply");
    return resolved;
  };
  const candidateId = (id: string): string => id.startsWith("new:") ? newCandidate(id) : Object.hasOwn(view.candidates, id) ? id : (() => { throw new Error("UNPRESENTED_PEER_CANDIDATE: operations may only target presented candidate IDs or new:<name> candidates"); })();
  const seed = (candidate: CandidateSeed): CandidateSeed => ({ ...candidate, candidateId: newCandidate(candidate.candidateId), sourceFindingIds: candidate.sourceFindingIds.map((id) => {
    const resolved = sourceIds.get(id); if (resolved === undefined) throw new Error("UNKNOWN_PEER_SOURCE_FINDING: sourceFindingIds must name presented findings or findings added in this reply"); return resolved;
  }) });
  const seen = new Set<string>();
  const operations: IssueOperation[] = parsed.operations.map((operation): IssueOperation => {
    if (operation.authorId !== "self" || operation.round !== round || "verification" in operation || operation.type === "add_candidate") throw new Error(`INVALID_MODEL_OPERATION_AUTHORITY: every operation must use authorId "self" and round ${round}, must not carry a verification record and must not add candidates`);
    const operationId = local(operation.operationId);
    if (seen.has(operationId)) throw new Error("DUPLICATE_PEER_OPERATION: operation IDs must be unique");
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
      if (sourceEvidence.size !== addedEvidence.size || [...sourceEvidence].some((id) => !addedEvidence.has(id))) throw new Error(`PEER_MISSING_FINDING_EVIDENCE_MISMATCH: an add_missing_finding operation introduces findings from this reply's findings array: its candidate.sourceFindingIds must list their self/<name> sourceFindingIds (here: ${parsed.findings.map(({ sourceFindingId }) => sourceFindingId).join(", ") || "none"}), never a presented source, and its evidence must be exactly those findings' evidence`);
    }
    // Existing aliases must belong to the referenced candidate(s), not another
    // candidate that happened to be present in the same request.
    const referenced = operation.type === "merge" ? operation.sourceCandidateIds : [operation.candidateId];
    const targets = operation.type === "merge" || operation.type === "add_missing_finding" ? [operation.candidate] : operation.type === "split" ? operation.candidates : [];
    const allowedSources = new Set(operation.type === "add_missing_finding" ? parsed.findings.map(({ sourceFindingId }) => sourceFindingId) : referenced.flatMap((id) => view.candidates[id]?.sources.map(({ findingRef }) => findingRef) ?? []));
    if (targets.some(({ sourceFindingIds }) => sourceFindingIds.some((id) => !allowedSources.has(id)))) throw new Error("CROSS_CANDIDATE_PEER_SOURCE: merged or split candidates may only use source findings of the candidates they reference");
    const allowed = new Set(referenced.flatMap((id) => view.candidates[id]?.sources.flatMap(({ evidence }) => evidence.map(({ id }) => id)) ?? []));
    const allowedNew = new Set(parsed.operations.filter((other) => referenced.includes(other.candidateId)).flatMap((other) => other.type === "add_evidence" || other.type === "add_counter_evidence" ? [other.evidence.id] : other.type === "add_missing_finding" ? other.evidence.map(({ id }) => id) : []));
    if (operation.citedEvidenceIds.some((id) => !allowedNew.has(id) && !allowed.has(id))) throw new Error("CROSS_CANDIDATE_PEER_EVIDENCE: an operation may only cite evidence of the candidate it targets");
    return result;
  });
  const votes = operations.filter(({ type }) => type === "accept" || type === "reject" || type === "needs_verification");
  if (new Set(votes.map(({ candidateId }) => candidateId)).size !== votes.length) throw new Error("DUPLICATE_PEER_VOTE: cast at most one accept, reject or needs_verification vote per candidate");
  for (const finding of findings) if (!operations.some((operation) => operation.type === "add_missing_finding" && operation.candidate.sourceFindingIds.includes(finding.sourceFindingId))) throw new Error("UNATTACHED_PEER_FINDING: every entry in findings must be introduced by an add_missing_finding operation whose candidate.sourceFindingIds lists it; otherwise leave findings empty");
  return { operations, findings, locations: [...locations.values()] };
}
