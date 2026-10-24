import { describe, expect, it } from "vitest";
import { SeededRng } from "@arbitra/core/services/rng.js";
import { translatePeerOperations, translateValidPeerOperations, wellFormedPeerReply, type PeerOperationBatch } from "../src/model-peer-operations.js";
import { peerReviewView } from "../src/peer-review-view.js";
import { ModelPeerBoard } from "../src/model-peer-board.js";
import { computeConsensus, DEFAULT_CONSENSUS_POLICY } from "@arbitra/workflow/consensus/engine.js";
import type { AuditFinding } from "../src/auditors.js";

const snapshot = { root: "fixture", files: [{ path: "a.ts", lines: ["return null;"], byteLength: 12, lineStartBytes: [0] }] };
const finding: AuditFinding = { sourceFindingId: "peer/f1", category: "CORRECTNESS", title: "Original", problem: "Problem", recommendedFix: "Fix", severity: "high", productionBlocker: true, locations: [{ id: "l1", path: "a.ts", startLine: 1, endLine: 1 }], evidence: [{ id: "e1", text: "return null;", locationIds: ["l1"] }] };
const view = peerReviewView(["C1", "C2"], { C1: [finding], C2: [{ ...finding, sourceFindingId: "peer/f2" }] }, "reviewer", new SeededRng("run"));
const base = { operationId: "new:op", authorId: "self", round: 1, candidateId: "C1", citedEvidenceIds: ["C1/source-1/evidence-1"] };
const seed = (candidateId: string) => ({ candidateId, title: "New claim", description: "New description", sourceFindingIds: ["C1/source-1"], severity: "high", blocker: true });
const response = (operations: unknown[], locations: unknown[] = [], findings: unknown[] = []) => ({ operations, locations, findings });
const translate = (value: unknown) => translatePeerOperations(value, view, snapshot, "reviewer", 1);

describe("model board operations", () => {
  it("namespaces repeated local IDs independently across context batches", () => {
    const value = response([{ ...base, type: "accept", reason: "Grounded" }]);
    const first = translatePeerOperations(value, view, snapshot, "reviewer", 1, "batch-a");
    const second = translatePeerOperations(value, view, snapshot, "reviewer", 1, "batch-b");
    expect(first.operations[0]?.operationId).not.toBe(second.operations[0]?.operationId);
    expect(first.operations[0]?.authorId).toBe("reviewer");
    expect(first.operations[0]?.citedEvidenceIds).toEqual(second.operations[0]?.citedEvidenceIds);
  });
  it("translates votes, supplements, severity, blocker, merge and split with private provenance", () => {
    const value = response([
      { ...base, operationId: "new:accept", type: "accept", reason: "Grounded" },
      ...["supplement_remediation", "supplement_verification"].map((type) => ({ ...base, operationId: `new:${type}`, type, text: "Advice" })),
      { ...base, operationId: "new:severity", type: "change_severity", severity: "critical", reason: "Risk" },
      { ...base, operationId: "new:blocker", type: "change_blocker", blocker: false, reason: "Mitigated" },
      { ...base, operationId: "new:merge", candidateId: "new:merged", type: "merge", sourceCandidateIds: ["C1", "C2"], candidate: seed("new:merged") },
      { ...base, operationId: "new:split", type: "split", candidates: [seed("new:split1"), seed("new:split2")], reason: "Separate causes" },
    ]);
    const result = translate(value);
    expect(result.operations).toHaveLength(7);
    expect(result.operations.every(({ authorId, citedEvidenceIds }) => authorId === "reviewer" && citedEvidenceIds[0] === "e1")).toBe(true);
    const merged = result.operations.find(({ type }) => type === "merge");
    if (merged?.type !== "merge") throw new Error("MERGE_ABSENT");
    expect(merged?.candidateId).toMatch(/^C-[a-f0-9]+$/u);
    expect(merged?.candidate.sourceFindingIds).toEqual(["peer/f1"]);
    expect(translate(value)).toEqual(result);
    for (const type of ["reject", "needs_verification"]) expect(translate(response([{ ...base, type, reason: "Grounded" }])).operations[0]?.type).toBe(type);
    expect(() => translate(response([{ ...base, type: "accept", reason: "First" }, { ...base, operationId: "new:second", type: "reject", reason: "Second" }]))).toThrow("DUPLICATE_PEER_VOTE");
  });

  it("grounds added evidence and rejects fabrication, authority spoofing and cross-candidate citations", () => {
    const location = { id: "new:loc", path: "a.ts", startLine: 1, endLine: 1 };
    const operation = { ...base, type: "add_counter_evidence", citedEvidenceIds: ["new:ev"], evidence: { id: "new:ev", text: "return null;", locationIds: ["new:loc"] } };
    expect(translate(response([operation], [location])).operations[0]).toMatchObject({ evidence: { id: "reviewer/review-1/ev", locationIds: ["reviewer/review-1/loc"] } });
    expect(() => translate(response([{ ...operation, evidence: { ...operation.evidence, text: "invented" } }], [location]))).toThrow("UNGROUNDED_PEER_EVIDENCE");
    expect(() => translate(response([{ ...base, type: "accept", reason: "Claim", authorId: "another-reviewer" }]))).toThrow("INVALID_MODEL_OPERATION_AUTHORITY");
    // Added evidence that leaves its own ID out of its citations is completed, not refused (observed live: 6 of 23 repair calls in one run).
    expect(translate(response([{ ...operation, citedEvidenceIds: [] }], [location])).operations[0]).toMatchObject({ citedEvidenceIds: ["reviewer/review-1/ev"], evidence: { id: "reviewer/review-1/ev" } });
    // An identical restatement of a declared location is accepted; a conflicting reuse is not.
    expect(translate(response([operation], [location, { ...location }])).operations).toHaveLength(1);
    expect(() => translate(response([operation], [location, { ...location, endLine: 2 }]))).toThrow("INVALID_PEER_LOCATION");
    expect(() => translate(response([{ ...base, type: "accept", reason: "Claim", citedEvidenceIds: ["C2/source-1/evidence-1"] }]))).toThrow("CROSS_CANDIDATE_PEER_EVIDENCE");
    // Beside evidence of its own candidate, another candidate's is left out and the vote stands (observed live: 10 of 28 repair calls in one run).
    expect(translate(response([{ ...base, type: "accept", reason: "Claim", citedEvidenceIds: ["C1/source-1/evidence-1", "C2/source-1/evidence-1"] }])).operations[0]?.citedEvidenceIds).toHaveLength(1);
    // Evidence another candidate's operation adds in the same reply is foreign as well; an ID that names nothing is still refused.
    expect(translate(response([{ ...operation, candidateId: "C2" }, { ...base, operationId: "new:vote", type: "accept", reason: "Claim", citedEvidenceIds: ["C1/source-1/evidence-1", "new:ev"] }], [location])).operations[1]?.citedEvidenceIds).toHaveLength(1);
    expect(() => translate(response([{ ...base, type: "accept", reason: "Claim", citedEvidenceIds: ["C1/source-1/evidence-1", "C9/source-1/evidence-1"] }]))).toThrow("UNKNOWN_PEER_EVIDENCE");
  });

  it("leaves out an operation that fails its own validation and keeps the rest of the reply", () => {
    // Observed live (P20 pilot): one quotation that was not exact refused a reply of about 20 operations, and 39 of 155 calls repeated such replies.
    const location = { id: "new:loc", path: "a.ts", startLine: 1, endLine: 1 };
    const invented = { ...base, operationId: "new:added", type: "add_counter_evidence", citedEvidenceIds: ["new:ev"], evidence: { id: "new:ev", text: "invented", locationIds: ["new:loc"] } };
    const vote = { ...base, operationId: "new:vote", type: "reject", reason: "Claim", citedEvidenceIds: ["C1/source-1/evidence-1", "new:ev"] };
    const advice = { ...base, operationId: "new:advice", type: "supplement_remediation", text: "Advice" };
    const keep = (operations: unknown[]) => translateValidPeerOperations(response(operations, [location]), view, snapshot, "reviewer", 1);
    const kept = keep([invented, vote, advice]);
    expect(kept.refused).toMatchObject([{ operationId: "new:added", type: "add_counter_evidence", candidateId: "C1" }]);
    expect(kept.refused[0]?.reason).toContain("UNGROUNDED_PEER_EVIDENCE");
    // The vote loses the withdrawn evidence and stands on its candidate's own.
    expect(kept.batch.operations.map(({ type, citedEvidenceIds }) => [type, citedEvidenceIds])).toEqual([["reject", ["e1"]], ["supplement_remediation", ["e1"]]]);
    // An operation left without the evidence it needs is refused in turn.
    const onlyNew = { ...vote, citedEvidenceIds: ["new:ev"] };
    expect(keep([invented, onlyNew, advice, { ...advice, operationId: "new:advice-2" }]).refused.map(({ operationId }) => operationId)).toEqual(["new:added", "new:vote"]);
    // A reply that would lose more than half of its operations is refused whole, and so is a fault of the reply itself.
    expect(() => keep([invented, onlyNew, advice])).toThrow("ISSUE_OPERATION_REQUIRES_EVIDENCE");
    expect(() => keep([invented])).toThrow("UNGROUNDED_PEER_EVIDENCE");
    expect(() => keep([{ ...base, type: "accept", reason: "First" }, { ...base, operationId: "new:second", type: "reject", reason: "Second" }, advice])).toThrow("DUPLICATE_PEER_VOTE");
    // A further check names operations of the translated batch to leave out.
    const also = translateValidPeerOperations(response([{ ...base, type: "accept", reason: "Grounded" }, advice]), view, snapshot, "reviewer", 1, undefined, (batch) => batch.operations.flatMap(({ type }, index) => type === "accept" ? [{ index, reason: "FIXTURE_REFUSED" }] : []));
    expect(also.refused).toMatchObject([{ operationId: "new:op", reason: "FIXTURE_REFUSED" }]);
    expect(also.batch.operations.map(({ type }) => type)).toEqual(["supplement_remediation"]);
  });

  it("leaves out an operation of the wrong shape like any other invalid operation", () => {
    // Observed live (P20 pilot): five votes without a type refused a reply of 25 operations.
    const untyped = { operationId: "new:untyped", authorId: "self", round: 1, candidateId: "C2", citedEvidenceIds: ["C2/source-1/evidence-1"], reason: "Grounded" };
    const advice = { ...base, operationId: "new:advice", type: "supplement_remediation", text: "Advice" };
    const kept = translateValidPeerOperations(response([{ ...base, type: "accept", reason: "Grounded" }, untyped, advice]), view, snapshot, "reviewer", 1);
    expect(kept.batch.operations.map(({ type }) => type)).toEqual(["accept", "supplement_remediation"]);
    expect(kept.refused).toMatchObject([{ operationId: "new:untyped", type: "untyped", candidateId: "C2" }]);
    expect(kept.refused[0]?.reason).toContain("type");
    // A finding only the malformed operation introduced goes with it.
    const finding = { schemaVersion: 1, sourceFindingId: "self/missing", category: "CORRECTNESS", title: "Missing", problem: "Missing claim", recommendedFix: "Fix", severity: "high", productionBlocker: false, status: "needs_verification", confidence: 0.5, productionImpact: "", trigger: "", verification: "", dependencies: [], relatedRisks: [],
      locations: [{ id: "new:location", path: "a.ts", startLine: 1, endLine: 1 }], evidence: [{ id: "new:evidence", text: "return null;", locationIds: ["new:location"] }] };
    // Without its evidence, the addition has the wrong shape.
    const malformedAddition = { ...base, operationId: "new:addition", type: "add_missing_finding", candidateId: "new:added", candidate: { ...seed("new:added"), sourceFindingIds: ["self/missing"] } };
    expect(wellFormedPeerReply(response([{ ...base, type: "accept", reason: "Grounded" }, malformedAddition, advice], [], [finding])).reply.findings).toEqual([]);
    // More than half of the operations of the wrong shape, or a reply of the wrong shape, is refused whole.
    expect(() => translateValidPeerOperations(response([untyped, { ...untyped, operationId: "new:untyped-2" }, advice]), view, snapshot, "reviewer", 1)).toThrow();
    expect(() => translateValidPeerOperations({ operations: [advice] }, view, snapshot, "reviewer", 1)).toThrow();
  });

  describe("withdraws only the citations that a left-out operation's own evidence would have resolved", () => {
    const location = { id: "new:loc", path: "a.ts", startLine: 1, endLine: 1 };
    const vote = { ...base, operationId: "new:vote", type: "reject", reason: "Claim", citedEvidenceIds: ["C1/source-1/evidence-1", "new:ev"] };
    const advice = { ...base, operationId: "new:advice", type: "supplement_remediation", text: "Advice" };
    const keep = (operations: unknown[]) => translateValidPeerOperations(response(operations, [location]), view, snapshot, "reviewer", 1);
    const cited = ({ batch }: ReturnType<typeof keep>) => batch.operations.map(({ type, citedEvidenceIds }) => [type, citedEvidenceIds]);
    it("evidence of an operation of the wrong shape", () => {
      // The vote also cites its candidate's own evidence, so it stands on that.
      const malformed = keep([{ ...base, operationId: "new:added", type: "add_counter_evidence", citedEvidenceIds: ["new:ev"], evidence: { id: "new:ev", text: "", locationIds: ["new:loc"] } }, vote, advice]);
      expect(malformed.refused.map(({ operationId }) => operationId)).toEqual(["new:added"]);
      expect(cited(malformed)).toEqual([["reject", ["e1"]], ["supplement_remediation", ["e1"]]]);
    });
    it("but not presented evidence that a refused addition reused the ID of", () => {
      const presented = keep([{ ...base, operationId: "new:added", type: "add_evidence", evidence: { id: "C1/source-1/evidence-1", text: "return null;", locationIds: ["new:loc"] } }, { ...vote, citedEvidenceIds: ["C1/source-1/evidence-1"] }, advice]);
      expect(presented.refused).toMatchObject([{ operationId: "new:added", reason: expect.stringContaining("INVALID_PEER_LOCAL_ID") }]);
      expect(cited(presented)).toEqual([["reject", ["e1"]], ["supplement_remediation", ["e1"]]]);
    });
  });

  it("applies structural changes with source context and removes retired claims from consensus", () => {
    const candidate = { candidateId: "C1", claim: { title: "Original", description: "Problem" }, sourceFindingIds: [finding.sourceFindingId], severity: "high" as const, blocker: true, status: "open", votes: [], evidence: finding.evidence, counterEvidence: [], firstSeenRound: 0, lastChangedRound: 0 };
    const board = { candidates: { C1: candidate } };
    const modelBoard = new ModelPeerBoard({ board, candidateFindings: { C1: [finding] }, rejectedCount: 0, consensus: computeConsensus(board, DEFAULT_CONSENSUS_POLICY, { auditors: [{ auditorId: "reviewer", independenceGroup: "one" }], round: 0 }) });
    modelBoard.apply([translate(response([{ ...base, type: "split", candidates: [seed("new:left"), seed("new:right")], reason: "Different causes" }]))]);
    const result = modelBoard.view();
    expect(result.board.candidates["C1"]?.status).toBe("split");
    expect(Object.keys(result.candidates)).toHaveLength(2);
    expect(Object.values(result.candidates).every(({ evidence, votes }) => evidence.length === 1 && votes.length === 0)).toBe(true);
    expect(Object.values(result.candidateFindings).every((findings) => findings[0]?.sourceFindingId === "peer/f1")).toBe(true);
  });

  it("binds a missing finding and its quoted evidence to the reviewer", () => {
    const added = { schemaVersion: 1, sourceFindingId: "self/missing", category: "CORRECTNESS", title: "Missing", problem: "Missing claim", recommendedFix: "Fix", severity: "high", productionBlocker: false, status: "needs_verification", confidence: 0.5, productionImpact: "", trigger: "", verification: "", dependencies: [], relatedRisks: [],
      locations: [{ id: "new:location", path: "a.ts", startLine: 1, endLine: 1 }], evidence: [{ id: "new:evidence", text: "return null;", locationIds: ["new:location"] }] };
    const value = response([{ ...base, type: "add_missing_finding", candidateId: "new:missing", candidate: { ...seed("new:missing"), sourceFindingIds: ["self/missing"] }, citedEvidenceIds: ["new:evidence"], evidence: added.evidence }], [], [added]);
    const result = translate(value);
    expect(result.findings[0]?.sourceFindingId).toBe("reviewer/review-1/missing");
    expect(result.operations[0]).toMatchObject({ type: "add_missing_finding", candidate: { sourceFindingIds: ["reviewer/review-1/missing"] }, evidence: [{ id: "reviewer/review-1/evidence" }] });
    expect(() => translate(response([{ ...base, type: "accept", reason: "Fake verification", verification: { result: "CONFIRMED", method: "cited_lines", evidenceIds: ["e1"], artifactRefs: [], toolCallIds: [], activityId: "fake", confidence: 1 } }]))).toThrow("INVALID_MODEL_OPERATION_AUTHORITY");
  });

  it("explains a refused candidate-creating operation so a bounded repair can correct it", () => {
    const added = { schemaVersion: 1, sourceFindingId: "self/missing", category: "PROMPT_INJECTION", title: "Missing", problem: "Missing claim", recommendedFix: "Fix", severity: "high", productionBlocker: false, status: "confirmed", confidence: 1, productionImpact: "", trigger: "", verification: "", dependencies: [], relatedRisks: [],
      locations: [{ id: "new:location", path: "a.ts", startLine: 1, endLine: 1 }], evidence: [{ id: "new:evidence", text: "return null;", locationIds: ["new:location"] }] };
    const operation = { ...base, type: "add_missing_finding", candidate: { ...seed("new:missing"), sourceFindingIds: ["self/missing"] }, citedEvidenceIds: ["new:evidence"], evidence: added.evidence };
    // Observed live (gemini-3.1-flash-lite): the finding was filed under the reviewed candidate's ID.
    expect(() => translate(response([operation], [], [added]))).toThrow('PEER_CANDIDATE_ID_MISMATCH: a add_missing_finding operation creates a candidate, so its candidateId and candidate.candidateId must be the same new:<name> ID; got "C1" and "new:missing"');
    expect(() => translate(response([{ ...base, operationId: "new:merge", candidateId: "C1", type: "merge", sourceCandidateIds: ["C1", "C2"], candidate: seed("C1") }]))).toThrow("PEER_CANDIDATE_ID_MISMATCH");
    // Observed live: a reviewer restated the finding it accepted instead of only voting.
    expect(() => translate(response([{ ...base, type: "accept", reason: "Grounded" }], [], [added]))).toThrow('to agree with a presented candidate, vote on it and do not restate it. Unattached: "self/missing"');
    expect(() => translate(response([{ ...base, operationId: "C1-vote", type: "accept", reason: "Grounded" }]))).toThrow('INVALID_PEER_LOCAL_ID: "C1-vote" is used where a new identifier is required');
  });

  it("keeps reused discovery evidence IDs distinct when candidates merge", () => {
    const other = { ...finding, sourceFindingId: "other/f1", evidence: [{ ...finding.evidence[0], id: "e1", text: "different source", locationIds: ["l1"] }] };
    const candidate = (candidateId: string, member: AuditFinding) => ({ candidateId, claim: { title: member.title, description: member.problem }, sourceFindingIds: [member.sourceFindingId], severity: "high" as const, blocker: true, status: "open", votes: [], evidence: member.evidence, counterEvidence: [], firstSeenRound: 0, lastChangedRound: 0 });
    const board = { candidates: { C1: candidate("C1", finding), C2: candidate("C2", other) } };
    const modelBoard = new ModelPeerBoard({ board, candidateFindings: { C1: [finding], C2: [other] }, rejectedCount: 0, consensus: computeConsensus(board, DEFAULT_CONSENSUS_POLICY, { auditors: [{ auditorId: "reviewer", independenceGroup: "one" }], round: 0 }) });
    modelBoard.apply([{ operations: [{ operationId: "merge", candidateId: "C3", authorId: "reviewer", round: 1, citedEvidenceIds: [], type: "merge", sourceCandidateIds: ["C1", "C2"], candidate: { ...seed("C3"), severity: "high", sourceFindingIds: ["peer/f1", "other/f1"] } }], findings: [], locations: [] }]);
    const merged = modelBoard.view().board.candidates["C3"];
    expect(merged?.evidence.map(({ id }) => id).sort()).toEqual(["other/f1/evidence/e1", "peer/f1/evidence/e1"]);
    expect(merged?.evidence.map(({ text }) => text).sort()).toEqual(["different source", "return null;"]);
  });
});

describe("peer-facing output schema", () => {
  it("does not advertise the verifier-only verification record", async () => {
    const { PEER_OPERATIONS_OUTPUT_SCHEMA } = await import("../src/model-pipeline.js");
    const { operations, findings } = (PEER_OPERATIONS_OUTPUT_SCHEMA as { properties: Record<string, unknown> }).properties;
    expect(JSON.stringify(operations)).not.toContain('"verification"');
    expect(JSON.stringify(findings)).toContain('"verification"');
    expect(JSON.stringify(PEER_OPERATIONS_OUTPUT_SCHEMA)).toContain('"needs_verification"');
  });
});

describe("peer location anchoring", () => {
  it("moves the reviewer's own miscounted location to the unique nearby range holding the exact quote", () => {
    const lines = ["export function parse(text) {", "  return parseInt(text);", "}"];
    const three = { root: "fixture", files: [{ path: "a.ts", lines, byteLength: 0, lineStartBytes: [0] }] };
    const location = { id: "new:loc", path: "a.ts", startLine: 3, endLine: 3 };
    const operation = { ...base, type: "add_counter_evidence", citedEvidenceIds: ["new:ev"], evidence: { id: "new:ev", text: "return parseInt(text);", locationIds: ["new:loc"] } };
    const moved = translatePeerOperations(response([operation], [location]), view, three, "reviewer", 1);
    expect(moved.locations).toContainEqual({ id: "reviewer/review-1/loc", path: "a.ts", startLine: 2, endLine: 2 });
    expect(() => translatePeerOperations(response([{ ...operation, evidence: { ...operation.evidence, text: "return Number(text);" } }], [location]), view, three, "reviewer", 1)).toThrow("UNGROUNDED_PEER_EVIDENCE");
  });

  it("does not move a location that evidence or a finding already holds at its declared range", () => {
    const lines = ["export function parse(text) {", "  return parseInt(text);", "}"];
    const three = { root: "fixture", files: [{ path: "a.ts", lines, byteLength: 0, lineStartBytes: [0] }] };
    // Every evidence entry quotes the lines its locations have in the batch, and every finding holds the batch's locations.
    const holds = ({ operations, findings, locations }: PeerOperationBatch) => [...operations.flatMap((operation) => operation.type === "add_evidence" || operation.type === "add_counter_evidence" ? [operation.evidence] : operation.type === "add_missing_finding" ? operation.evidence : []), ...findings.flatMap(({ evidence }) => evidence)]
      .every(({ text, locationIds }) => locationIds.every((id) => { const at = locations.find((location) => location.id === id); return at !== undefined && lines.slice(at.startLine - 1, at.endLine).join("\n").includes(text); }))
      && findings.every((added) => added.locations.every((location) => locations.some((entry) => JSON.stringify(entry) === JSON.stringify(location))));
    const header = { ...base, operationId: "new:header", type: "add_evidence", citedEvidenceIds: ["new:header"], evidence: { id: "new:header", text: "export function parse(text) {", locationIds: ["new:loc"] } };
    const body = { ...base, operationId: "new:body", type: "add_counter_evidence", citedEvidenceIds: ["new:body"], evidence: { id: "new:body", text: "return parseInt(text);", locationIds: ["new:loc"] } };
    const advice = { ...base, operationId: "new:advice", type: "supplement_remediation", text: "Advice" };
    // Evidence that does not hold at a shared location is refused; the location is not moved from under evidence that does.
    const shared = translateValidPeerOperations(response([header, body, advice], [{ id: "new:loc", path: "a.ts", startLine: 1, endLine: 1 }]), view, three, "reviewer", 1);
    expect(shared.refused).toMatchObject([{ operationId: "new:body", reason: expect.stringContaining("UNGROUNDED_PEER_EVIDENCE") }]);
    expect(holds(shared.batch)).toBe(true);
    // The same for a location of a finding added in the reply.
    const added = { schemaVersion: 1, sourceFindingId: "self/missing", category: "CORRECTNESS", title: "Missing", problem: "Missing claim", recommendedFix: "Fix", severity: "high", productionBlocker: false, status: "needs_verification", confidence: 0.5, productionImpact: "", trigger: "", verification: "", dependencies: [], relatedRisks: [],
      locations: [{ id: "new:location", path: "a.ts", startLine: 1, endLine: 1 }], evidence: [{ id: "new:evidence", text: "export function parse(text) {", locationIds: ["new:location"] }] };
    const addition = { ...base, operationId: "new:addition", type: "add_missing_finding", candidateId: "new:missing", candidate: { ...seed("new:missing"), sourceFindingIds: ["self/missing"] }, citedEvidenceIds: ["new:evidence"], evidence: added.evidence };
    const ofFinding = translateValidPeerOperations(response([addition, { ...body, evidence: { ...body.evidence, locationIds: ["new:location"] } }, advice], [], [added]), view, three, "reviewer", 1);
    expect(ofFinding.refused).toMatchObject([{ operationId: "new:body", reason: expect.stringContaining("UNGROUNDED_PEER_EVIDENCE") }]);
    expect(holds(ofFinding.batch)).toBe(true);
  });
});
