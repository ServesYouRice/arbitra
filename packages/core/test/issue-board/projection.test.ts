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

  it("retains evidence, counter-evidence and supplements through merge and split without transferring votes", () => {
    const board = projectBoard(completeLog().slice(0, 11));
    for (const id of ["C-3", "C-4", "C-5"]) {
      expect(board.candidates[id]).toMatchObject({ evidence: [evidence], counterEvidence: [{ ...evidence, id: "ev-counter" }], remediationSupplements: ["Add an authorization guard."], verificationSupplements: ["Exercise the denied path."], votes: [] });
      expect(board.candidates[id]?.sourceFindingIds).toContain("auditor-a/C-1");
      expect(board.candidates[id]?.sourceFindingIds).toContain("auditor-a/C-2");
    }
    expect(board.candidates["C-1"]?.votes).toHaveLength(1);
  });

  it("rejects attempts to resurrect or merge retired claims", () => {
    const log = completeLog().slice(0, 11);
    expect(() => projectBoard([...log, { ...base("resurrect", "C-1", 4, ["ev-1"]), type: "accept", reason: "Old claim" }])).toThrow("RETIRED_ISSUE_CANDIDATE:C-1");
    expect(() => projectBoard([...log, { ...base("merge-again", "C-7", 4), type: "merge", sourceCandidateIds: ["C-1", "C-4"], candidate: seed("C-7") }])).toThrow("RETIRED_ISSUE_CANDIDATE:C-1");
  });

  it("deduplicates identical inherited evidence and rejects conflicting evidence identities", () => {
    const log = completeLog().slice(0, 3);
    const merge: IssueOperation = { ...base("merge", "C-3", 2), type: "merge", sourceCandidateIds: ["C-1", "C-2"], candidate: seed("C-3") };
    const duplicate: IssueOperation = { ...base("duplicate", "C-2", 1, ["ev-1"]), type: "add_evidence", evidence };
    expect(projectBoard([...log, duplicate, merge]).candidates["C-3"]?.evidence).toEqual([evidence]);
    expect(() => projectBoard([...log, { ...duplicate, evidence: { ...evidence, text: "different quote" } }, merge])).toThrow("CONFLICTING_ISSUE_EVIDENCE:ev-1");
  });

  it("rejects stale operations and serializes competing durable writes", async () => {
    const initial: IssueOperation = { ...base("op-1", "C-1", 0), type: "add_candidate", candidate: seed("C-1") };
    const latest: IssueOperation = { ...base("op-2", "C-1", 2), type: "supplement_remediation", text: "Latest advice" };
    expect(() => projectBoard([initial, latest, { ...base("op-3", "C-1", 1), type: "supplement_remediation", text: "Stale advice" }])).toThrow("ISSUE_OPERATION_ROUND_REGRESSION");
    const persisted: IssueOperation[] = [];
    const controller = new IssueBoardController({ async append(operation) { await Promise.resolve(); persisted.push(operation); } });
    const results = await Promise.allSettled([controller.append(initial), controller.append(initial)]);
    expect(results.map(({ status }) => status)).toEqual(["fulfilled", "rejected"]);
    expect(persisted).toHaveLength(1);
  });

  it("validates before durable append and requires cited evidence", async () => {
    const persisted: IssueOperation[] = []; const controller = new IssueBoardController({ async append(operation) { persisted.push(operation); } });
    await controller.append({ ...base("op-1", "C-1", 0), type: "add_candidate", candidate: seed("C-1") });
    await expect(controller.append({ ...base("op-2", "C-1", 1), type: "accept", reason: "unsupported" })).rejects.toThrow("ISSUE_OPERATION_REQUIRES_EVIDENCE:accept");
    expect(persisted).toHaveLength(1); expect(controller.project().operationIds).toEqual(["op-1"]);
  });

  it("owns queued and initial operations and freezes projected evidence independently", async () => {
    const initial = { ...base("initial", "C-1", 0), type: "add_candidate" as const, candidate: { ...seed("C-1") } };
    const controller = new IssueBoardController({ async append() {} }, [initial]);
    initial.candidate.title = "Changed outside controller";
    const submitted = { ...base("evidence", "C-1", 1, ["ev-1"]), type: "add_evidence" as const, evidence: { ...evidence, locationIds: ["loc-1"] } };
    const pending = controller.append(submitted);
    submitted.evidence.text = "Changed before queue executes";
    await pending;
    expect(controller.project().candidates["C-1"]?.claim.title).toBe("Title C-1");
    expect(controller.project().candidates["C-1"]?.evidence).toEqual([evidence]);
    const projected = controller.project().candidates["C-1"]?.evidence[0];
    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.isFrozen(projected?.locationIds)).toBe(true);
  });

  it("rejects malformed operation payloads before writing", async () => {
    const persisted: IssueOperation[] = [];
    const controller = new IssueBoardController({ async append(operation) { persisted.push(operation); } });
    const malformed = { ...base("bad", "C-1", 0), type: "add_candidate", candidate: { ...seed("C-1"), severity: "catastrophic" } } as unknown as IssueOperation;
    await expect(controller.append(malformed)).rejects.toThrow("INVALID_ISSUE_OPERATION_SHAPE");
    expect(persisted).toEqual([]);
  });
});
