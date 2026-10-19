import { assertIssueOperation, type CandidateSeed, type IssueEvidence, type IssueOperation } from "@arbitra/core/issue-board/operations.js";
import { boardOperationSchema } from "@arbitra/schemas/board-operation.js";
import { peerOperationsResultSchema, peerReplyEnvelopeSchema, type PeerOperationsResult } from "@arbitra/schemas/peer-operations.js";
import type { FindingLocation } from "@arbitra/schemas/finding.js";
import type { ConsensusCandidate, ConsensusVote } from "@arbitra/workflow/consensus/engine.js";
import type { AuditFinding } from "./auditors.js";
import type { RepositorySnapshot } from "./repository.js";
import type { peerReviewView } from "./peer-review-view.js";
import { createHash } from "node:crypto";
import { redactSecrets } from "@arbitra/security/redaction";

type View = ReturnType<typeof peerReviewView>;
export interface PeerOperationBatch { readonly operations: readonly IssueOperation[]; readonly findings: readonly AuditFinding[]; readonly locations: readonly FindingLocation[] }

/** One operation of a reply failed its own validation; the message is the refusal the reviewer would be shown. */
export class PeerOperationRefusal extends Error {
  constructor(readonly operationIndex: number, cause: unknown) { super(cause instanceof Error ? cause.message : String(cause), { cause }); this.name = "PeerOperationRefusal"; }
}
export interface RefusedPeerOperation { readonly operationId: string; readonly type: string; readonly candidateId: string; readonly reason: string }

/**
 * Translates a reply and leaves out each operation that fails its own validation, so one bad operation does not
 * cost the whole reply. Evidence a refused operation would have added is withdrawn from the other operations'
 * citations, and an operation left without the evidence it needs is refused in turn. `alsoRefuse` names further
 * operations of the translated batch to leave out. The reply itself is refused, as before, when its shape, its
 * locations or its findings are invalid, or when more than half of its operations would be left out.
 * Observed live (P20 pilot): 39 of 155 calls in one panel run repeated a reply of about 20 operations over one
 * or two of them, and a reply still invalid after its repairs lost all of them.
 */
export function translateValidPeerOperations(value: unknown, view: View, snapshot: RepositorySnapshot, reviewerId: string, round: number, scopeId?: string,
  alsoRefuse: (batch: PeerOperationBatch) => readonly { readonly index: number; readonly reason: string }[] = () => []): { readonly batch: PeerOperationBatch; readonly refused: readonly RefusedPeerOperation[] } {
  const { reply: original, malformed, total } = wellFormedPeerReply(value);
  let parsed = original;
  const refused: RefusedPeerOperation[] = [...malformed];
  const leaveOut = (index: number, reason: string, error: unknown): void => {
    const operation = parsed.operations[index];
    if (operation === undefined || (refused.length + 1) * 2 > total) throw error;
    refused.push({ operationId: operation.operationId, type: operation.type, candidateId: operation.candidateId, reason: reason.slice(0, 300) });
    const withdrawn = new Set(operation.type === "add_evidence" || operation.type === "add_counter_evidence" ? [operation.evidence.id] : operation.type === "add_missing_finding" ? operation.evidence.map(({ id }) => id) : []);
    const operations = parsed.operations.filter((_, at) => at !== index).map((other) => withdrawn.size === 0 ? other : { ...other, citedEvidenceIds: other.citedEvidenceIds.filter((id) => !withdrawn.has(id)) });
    // A finding that only the refused operation introduced goes with it.
    const introduced = new Set(operations.flatMap((other) => other.type === "add_missing_finding" ? other.candidate.sourceFindingIds : []));
    parsed = { ...parsed, operations, findings: operation.type === "add_missing_finding" ? parsed.findings.filter(({ sourceFindingId }) => introduced.has(sourceFindingId)) : parsed.findings };
  };
  for (;;) {
    let batch: PeerOperationBatch;
    try { batch = translatePeerOperations(parsed, view, snapshot, reviewerId, round, scopeId); }
    catch (error) {
      if (!(error instanceof PeerOperationRefusal)) throw error;
      leaveOut(error.operationIndex, error.message, error);
      continue;
    }
    const [next] = alsoRefuse(batch);
    if (next === undefined) return { batch, refused };
    leaveOut(next.index, next.reason, new Error(next.reason));
  }
}

/**
 * The operations of a reply that have a valid shape, and a refusal for each that has not, so an operation of the
 * wrong shape is left out like one that fails its other checks. A finding only such an operation introduced goes
 * with it. The reply is refused whole, with the schema's own message, when its envelope is invalid or when more
 * than half of its operations have the wrong shape. Observed live (P20 pilot): five votes without a `type` refused
 * a reply of 25 operations, and its repair took 100 seconds and changed other votes.
 */
export function wellFormedPeerReply(value: unknown): { readonly reply: PeerOperationsResult; readonly malformed: readonly RefusedPeerOperation[]; readonly total: number } {
  const envelope = peerReplyEnvelopeSchema.parse(value);
  const malformed: RefusedPeerOperation[] = [];
  const dropped = new Set<string>();
  const operations = envelope.operations.flatMap((raw, index) => {
    const checked = boardOperationSchema.safeParse(raw);
    if (checked.success) return [checked.data];
    const fields = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
    const text = (field: string, fallback: string) => typeof fields[field] === "string" ? fields[field] : fallback;
    const candidate = typeof fields["candidate"] === "object" && fields["candidate"] !== null ? fields["candidate"] as Record<string, unknown> : {};
    if (Array.isArray(candidate["sourceFindingIds"])) for (const id of candidate["sourceFindingIds"]) if (typeof id === "string") dropped.add(id);
    malformed.push({ operationId: text("operationId", `operation ${index + 1}`), type: text("type", "untyped"), candidateId: text("candidateId", ""),
      reason: checked.error.issues.map(({ path, message }) => `${path.join(".") || "operation"}: ${message}`).join("; ").slice(0, 300) });
    return [];
  });
  if (malformed.length * 2 > envelope.operations.length) peerOperationsResultSchema.parse(value);
  const introduced = new Set(operations.flatMap((operation) => operation.type === "add_missing_finding" ? operation.candidate.sourceFindingIds : []));
  const findings = envelope.findings.filter(({ sourceFindingId }) => introduced.has(sourceFindingId) || !dropped.has(sourceFindingId));
  return { reply: { ...envelope, operations, findings }, malformed, total: envelope.operations.length };
}

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
  // A failure that belongs to one operation names it, so a caller can leave that operation out.
  for (const [index, operation] of parsed.operations.entries()) {
    try {
      if (operation.type === "add_evidence" || operation.type === "add_counter_evidence") evidence(operation.evidence);
      if (operation.type === "add_missing_finding") operation.evidence.forEach(evidence);
    } catch (error) { throw new PeerOperationRefusal(index, error); }
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
  const translateOne = (operation: (typeof parsed.operations)[number]): IssueOperation => {
    if (operation.authorId !== "self" || operation.round !== round || "verification" in operation || operation.type === "add_candidate") throw new Error(`INVALID_MODEL_OPERATION_AUTHORITY: every operation must use authorId "self" and round ${round}, must not carry a verification record and must not add candidates`);
    // A created candidate is addressed by the operation that creates it (observed live: a
    // model filed add_missing_finding under the existing candidate it was reviewing).
    const created = operation.type === "add_missing_finding" || operation.type === "merge" ? operation.candidate.candidateId : null;
    if (created !== null && (created !== operation.candidateId || !created.startsWith("new:"))) throw new Error(`PEER_CANDIDATE_ID_MISMATCH: a ${operation.type} operation creates a candidate, so its candidateId and candidate.candidateId must be the same new:<name> ID; got ${JSON.stringify(operation.candidateId.slice(0, 80))} and ${JSON.stringify(created.slice(0, 80))}`);
    const operationId = local(operation.operationId);
    if (seen.has(operationId)) throw new Error("DUPLICATE_PEER_OPERATION: operation IDs must be unique");
    seen.add(operationId);
    // Added evidence cites itself. A reply that leaves its own ID out is completed here instead of refused: the
    // slip is bookkeeping, and each refusal cost a whole repair call (observed live: 6 of 23 repairs in one run).
    const cited = (operation.type === "add_evidence" || operation.type === "add_counter_evidence") && !operation.citedEvidenceIds.includes(operation.evidence.id) ? [...operation.citedEvidenceIds, operation.evidence.id] : operation.citedEvidenceIds;
    // Existing aliases must belong to the referenced candidate(s), not another
    // candidate that happened to be present in the same request.
    const referenced = operation.type === "merge" ? operation.sourceCandidateIds : [operation.candidateId];
    const allowed = new Set(referenced.flatMap((id) => view.candidates[id]?.sources.flatMap(({ evidence }) => evidence.map(({ id }) => id)) ?? []));
    const allowedNew = new Set(parsed.operations.filter((other) => referenced.includes(other.candidateId)).flatMap((other) => other.type === "add_evidence" || other.type === "add_counter_evidence" ? [other.evidence.id] : other.type === "add_missing_finding" ? other.evidence.map(({ id }) => id) : []));
    // A citation of another candidate's evidence is left out and the operation stands on the evidence of its own
    // candidate; with none of its own left it is refused. Observed live (P20 pilot): 10 of 28 repair calls in one
    // run repeated a reply of about 20 operations over one or two such citations, and every operation concerned
    // also cited evidence of its own candidate. An ID that names no evidence at all is still refused below.
    const foreign = (id: string): boolean => !allowedNew.has(id) && !allowed.has(id) && (view.evidenceIds.has(id) || newEvidence.has(id));
    const own = cited.filter((id) => !foreign(id));
    if (own.length === 0 && cited.length > 0) throw new Error("CROSS_CANDIDATE_PEER_EVIDENCE: an operation may only cite evidence of the candidate it targets");
    const base = { ...operation, operationId, authorId: reviewerId, candidateId: candidateId(operation.candidateId), citedEvidenceIds: own.map(citation) };
    let result: IssueOperation;
    switch (operation.type) {
      case "merge": result = { ...base, type: "merge", sourceCandidateIds: operation.sourceCandidateIds.map(candidateId), candidate: seed(operation.candidate) }; break;
      case "split": result = { ...base, type: "split", candidates: operation.candidates.map(seed), reason: operation.reason }; break;
      case "add_missing_finding": result = { ...base, type: "add_missing_finding", candidate: seed(operation.candidate), evidence: operation.evidence.map(evidence) }; break;
      case "add_evidence": case "add_counter_evidence": result = { ...base, type: operation.type, evidence: evidence(operation.evidence) }; break;
      default: result = base as IssueOperation;
    }
    assertExplainedIssueOperation(result);
    if (result.type === "add_missing_finding") {
      const sourceEvidence = new Set(findings.filter(({ sourceFindingId }) => result.candidate.sourceFindingIds.includes(sourceFindingId)).flatMap(({ evidence }) => evidence.map(({ id }) => id)));
      const addedEvidence = new Set(result.evidence.map(({ id }) => id));
      if (sourceEvidence.size !== addedEvidence.size || [...sourceEvidence].some((id) => !addedEvidence.has(id))) throw new Error(`PEER_MISSING_FINDING_EVIDENCE_MISMATCH: an add_missing_finding operation introduces findings from this reply's findings array: its candidate.sourceFindingIds must list their self/<name> sourceFindingIds (here: ${parsed.findings.map(({ sourceFindingId }) => sourceFindingId).join(", ") || "none"}), never a presented source, and its evidence must be exactly those findings' evidence`);
    }
    const targets = operation.type === "merge" || operation.type === "add_missing_finding" ? [operation.candidate] : operation.type === "split" ? operation.candidates : [];
    const allowedSources = new Set(operation.type === "add_missing_finding" ? parsed.findings.map(({ sourceFindingId }) => sourceFindingId) : referenced.flatMap((id) => view.candidates[id]?.sources.map(({ findingRef }) => findingRef) ?? []));
    if (targets.some(({ sourceFindingIds }) => sourceFindingIds.some((id) => !allowedSources.has(id)))) throw new Error("CROSS_CANDIDATE_PEER_SOURCE: merged or split candidates may only use source findings of the candidates they reference");
    return result;
  };
  const operations: IssueOperation[] = parsed.operations.map((operation, index) => {
    try { return translateOne(operation); }
    catch (error) { throw new PeerOperationRefusal(index, error); }
  });
  const votes = operations.filter(({ type }) => type === "accept" || type === "reject" || type === "needs_verification");
  if (new Set(votes.map(({ candidateId }) => candidateId)).size !== votes.length) throw new Error("DUPLICATE_PEER_VOTE: cast at most one accept, reject or needs_verification vote per candidate");
  // Observed live: models restate the presented findings they vote on. Name the entries so a repair can drop them.
  const unattached = parsed.findings.filter((_, index) => { const finding = findings[index]; return finding !== undefined && !operations.some((operation) => operation.type === "add_missing_finding" && operation.candidate.sourceFindingIds.includes(finding.sourceFindingId)); });
  if (unattached.length > 0) throw new Error(`UNATTACHED_PEER_FINDING: every entry in findings must be introduced by an add_missing_finding operation whose candidate.sourceFindingIds lists it; otherwise leave findings empty. Findings are only for problems no presented candidate covers: to agree with a presented candidate, vote on it and do not restate it. Unattached: ${unattached.map(({ sourceFindingId }) => JSON.stringify(sourceFindingId.slice(0, 80))).join(", ")}`);
  return { operations, findings, locations: [...locations.values()] };
}

type VotingBoard = Readonly<Record<string, Pick<ConsensusCandidate, "votes">>>;
const latestVote = (board: VotingBoard, candidateId: string, reviewerId: string): ConsensusVote | undefined =>
  [...(board[candidateId]?.votes ?? [])].reverse().find(({ authorId }) => authorId === reviewerId);

export const EARLIER_VOTES_RULE = "These are your own earlier votes on the presented candidates, with the evidence each one cited. Keep a vote, or change it only by also citing at least one evidence ID it did not cite (for example new evidence you add in this reply with add_evidence or add_counter_evidence). A changed vote that cites only the same evidence is refused.";

/** The reviewer's own latest vote on each presented candidate, with its evidence under this view's aliases. */
export function earlierPeerVotes(view: View, board: VotingBoard, reviewerId: string): Record<string, { readonly vote: ConsensusVote["disposition"]; readonly citedEvidenceIds: readonly string[] }> {
  return Object.fromEntries(Object.keys(view.candidates).flatMap((candidateId) => {
    const vote = latestVote(board, candidateId, reviewerId);
    if (vote === undefined) return [];
    const aliases = [...view.evidenceIds].filter(([alias, id]) => alias.startsWith(`${candidateId}/`) && vote.citedEvidenceIds.includes(id)).map(([alias]) => alias);
    return [[candidateId, { vote: vote.disposition, citedEvidenceIds: aliases }]];
  }));
}

/**
 * The consensus round refuses a changed vote that cites no new evidence (anti-conformity).
 * Observed live: a reviewer that is not shown its earlier vote flips it on the same evidence,
 * which failed the whole run. Refusing it at the model boundary lets the reviewer repair it.
 */
export function assertChangedVotesCiteNewEvidence(operations: readonly IssueOperation[], board: VotingBoard, reviewerId: string): void {
  const changed = changedVotesWithoutNewEvidence(operations, board, reviewerId);
  if (changed.length > 0) throw new Error(`PEER_VOTE_CHANGED_WITHOUT_NEW_EVIDENCE: ${changed.map(({ change }) => change).join("; ")}. ${EARLIER_VOTES_RULE}`);
}

/** The changed votes that cite nothing their reviewer's earlier vote did not cite, by position in `operations`. */
export function changedVotesWithoutNewEvidence(operations: readonly IssueOperation[], board: VotingBoard, reviewerId: string): readonly { readonly index: number; readonly change: string; readonly reason: string }[] {
  return operations.flatMap((operation, index) => {
    if (operation.type !== "accept" && operation.type !== "reject" && operation.type !== "needs_verification") return [];
    const prior = latestVote(board, operation.candidateId, reviewerId);
    if (prior === undefined || prior.disposition === operation.type || !operation.citedEvidenceIds.every((id) => prior.citedEvidenceIds.includes(id))) return [];
    const change = `${operation.candidateId} (earlier ${prior.disposition}, now ${operation.type})`;
    return [{ index, change, reason: `PEER_VOTE_CHANGED_WITHOUT_NEW_EVIDENCE: ${change}. ${EARLIER_VOTES_RULE}` }];
  });
}

/** Core refusals carry bare codes; a peer reply is repaired from its refusal, so each code gets its rule. */
const ISSUE_OPERATION_RULES: readonly (readonly [string, string])[] = [
  ["INVALID_ISSUE_OPERATION_SHAPE", "each operation must match the typed board operation schema for its type"],
  ["INVALID_CANDIDATE_SEED", "every created candidate needs a non-empty title, description and sourceFindingIds, and a candidateId equal to its operation's candidateId"],
  ["MISSING_FINDING_REQUIRES_EVIDENCE", "an add_missing_finding operation must carry the evidence of the finding it introduces"],
  ["INVALID_MERGE_SOURCES", "a merge needs at least two distinct sourceCandidateIds"],
  ["INVALID_SPLIT_TARGETS", "a split needs at least two candidates with distinct new:<name> candidateIds"],
  ["ISSUE_EVIDENCE_ID_NOT_CITED", "an add_evidence or add_counter_evidence operation must list its own evidence id in citedEvidenceIds"],
  ["ISSUE_OPERATION_REQUIRES_EVIDENCE", "votes, evidence, severity, blocker and add_missing_finding operations must cite at least one evidence ID"],
  ["INVALID_ISSUE_OPERATION", "operation IDs, candidate IDs, reasons and supplement text must be non-empty"],
];
function assertExplainedIssueOperation(operation: IssueOperation): void {
  try { assertIssueOperation(operation); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const rule = ISSUE_OPERATION_RULES.find(([code]) => message === code || message.startsWith(`${code}:`))?.[1];
    if (rule === undefined) throw error;
    throw new Error(`${message}: ${rule}`, { cause: error });
  }
}
