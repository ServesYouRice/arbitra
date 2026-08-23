import { describe, expect, it } from "vitest";
import { assertIssueOperation, type CandidateSeed, type IssueOperation } from "../../src/issue-board/operations.js";
import { boardDelta, IssueBoardController, projectBoard } from "../../src/issue-board/projection.js";

const seed = (candidateId: string, sourceFindingIds = [`auditor-a/${candidateId}`]): CandidateSeed => ({ candidateId, title: `Title ${candidateId}`, description: `Description ${candidateId}`, sourceFindingIds, severity: "high", blocker: true });
const base = (operationId: string, candidateId: string, round: number, citedEvidenceIds: readonly string[] = []) => ({ operationId, candidateId, authorId: "auditor-a", round, citedEvidenceIds });
const evidence = { id: "ev-1", text: "quoted source", locationIds: ["loc-1"] };

function completeLog(): IssueOperation[] { return [
  { ...base("op-1", "C-1", 0), type: "add_candidate", candidate: seed("C-1") },
  { ...base("op-2", "C-2", 0), type: "add_candidate", candidate: seed("C-2") },
  { ...base("op-3", "C-1", 1, ["ev-1"]), type: "add_evidence", evidence },
  { ...base("op-4", "C-1", 1, ["ev-1"]), type: "add_counter_evidence", evidence: { ...evidence, id: "ev-counter" }, citedEvidenceIds: ["ev-counter"] },
  { ...base("op-5", "C-1", 1, ["ev-1"]), type: "accept", reason: "Evidence supports it" },
  { ...base("op-6", "C-1", 1, ["ev-1"]), type: "change_severity", severity: "critical", reason: "Reachable remotely" },
  { ...base("op-7", "C-1", 1, ["ev-1"]), type: "change_blocker", blocker: false, reason: "Mitigated in deployment" },
  { ...base("op-8", "C-1", 1), type: "supplement_remediation", text: "Add an authorization guard." },
  { ...base("op-9", "C-1", 1), type: "supplement_verification", text: "Exercise the denied path." },
  { ...base("op-10", "C-3", 2), type: "merge", sourceCandidateIds: ["C-1", "C-2"], candidate: seed("C-3", ["auditor-a/C-1", "auditor-b/C-2"]) },
  { ...base("op-11", "C-3", 3), type: "split", candidates: [seed("C-4"), seed("C-5")], reason: "Two root causes" },
  { ...base("op-12", "C-6", 3, ["ev-1"]), type: "add_missing_finding", candidate: seed("C-6"), evidence: [evidence] },
  { ...base("op-13", "C-4", 3, ["ev-1"]), type: "needs_verification", reason: "Trigger unclear" },
  { ...base("op-14", "C-5", 3, ["ev-1"]), type: "reject", reason: "Counter-evidence disproves it" },
] as IssueOperation[]; }

describe("Issue Board projection", () => {
  it("projects the same operation log deterministically", () => { const operations = completeLog(); expect(projectBoard(operations)).toEqual(projectBoard(operations)); expect(JSON.stringify(projectBoard(operations))).toBe(JSON.stringify(projectBoard([...operations]))); });

  it("covers every operation type and preserves merge/split lineage", () => {
    const operations = completeLog(); for (const operation of operations) expect(() => assertIssueOperation(operation)).not.toThrow();
    expect(new Set(operations.map(({ type }) => type))).toEqual(new Set(["add_candidate", "add_missing_finding", "accept", "reject", "needs_verification", "merge", "split", "add_evidence", "add_counter_evidence", "change_severity", "change_blocker", "supplement_remediation", "supplement_verification"]));
    const board = projectBoard(operations);
    expect(board.candidates["C-1"]).toMatchObject({ status: "merged", childCandidateIds: ["C-3"] });
    expect(board.candidates["C-3"]).toMatchObject({ status: "split", parentCandidateIds: ["C-1", "C-2"], childCandidateIds: ["C-4", "C-5"] });
    expect(board.candidates["C-4"]).toMatchObject({ status: "needs_verification", parentCandidateIds: ["C-3"], firstSeenRound: 3, lastChangedRound: 3 });
  });

  it("selects only candidates changed after a round", () => { expect(boardDelta(projectBoard(completeLog()), 2).map(({ candidateId }) => candidateId)).toEqual(["C-3", "C-4", "C-5", "C-6"]); });

  it("validates before durable append and requires cited evidence", async () => {
    const persisted: IssueOperation[] = []; const controller = new IssueBoardController({ async append(operation) { persisted.push(operation); } });
    await controller.append({ ...base("op-1", "C-1", 0), type: "add_candidate", candidate: seed("C-1") });
    await expect(controller.append({ ...base("op-2", "C-1", 1), type: "accept", reason: "unsupported" })).rejects.toThrow("ISSUE_OPERATION_REQUIRES_EVIDENCE:accept");
    expect(persisted).toHaveLength(1); expect(controller.project().operationIds).toEqual(["op-1"]);
  });
});
