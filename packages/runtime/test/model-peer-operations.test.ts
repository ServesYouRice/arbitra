import { describe, expect, it } from "vitest";
import { SeededRng } from "@arbitra/core/services/rng.js";
import { translatePeerOperations } from "../src/model-peer-operations.js";
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
    // An identical restatement of a declared location is accepted; a conflicting reuse is not.
    expect(translate(response([operation], [location, { ...location }])).operations).toHaveLength(1);
    expect(() => translate(response([operation], [location, { ...location, endLine: 2 }]))).toThrow("INVALID_PEER_LOCATION");
    expect(() => translate(response([{ ...base, type: "accept", reason: "Claim", citedEvidenceIds: ["C2/source-1/evidence-1"] }]))).toThrow("CROSS_CANDIDATE_PEER_EVIDENCE");
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
