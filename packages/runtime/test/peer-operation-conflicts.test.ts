import { describe, expect, it } from "vitest";
import type { IssueOperation } from "@arbitra/core/issue-board/operations.js";
import { adjudicatePeerOperations } from "../src/peer-operation-conflicts.js";

const seed = (candidateId: string) => ({ candidateId, title: "Claim", description: "Description", severity: "high" as const, blocker: true, sourceFindingIds: ["a/source"] });
const base = (operationId: string, candidateId: string) => ({ operationId, candidateId, authorId: operationId, round: 1, citedEvidenceIds: ["e1"] });
const merge = (id: string, sources: string[]): IssueOperation => ({ ...base(id, `new-${id}`), type: "merge", candidate: seed(`new-${id}`), sourceCandidateIds: sources });

describe("peer operation conflict adjudication", () => {
  it("defers transitive structural conflicts without choosing by reviewer order", () => {
    const operations = [merge("a", ["C1", "C2"]), merge("b", ["C3", "C4"]), merge("c", ["C2", "C3"]), merge("d", ["C5", "C6"])];
    const first = adjudicatePeerOperations(operations);
    const reversed = adjudicatePeerOperations([...operations].reverse());
    expect(first.conflicts).toEqual(reversed.conflicts);
    expect(first.accepted.map(({ operationId }) => operationId)).toEqual(["d"]);
    expect(first.conflicts).toMatchObject([{ candidateIds: ["C1", "C2", "C3", "C4"], operationIds: ["a", "b", "c"], reason: "overlapping_structural_edits" }]);
  });

  it("preserves nonconflicting evidence and defers contradictory field changes", () => {
    const operations: IssueOperation[] = [
      { ...base("high", "C1"), type: "change_severity", severity: "high", reason: "Risk" },
      { ...base("low", "C1"), type: "change_severity", severity: "low", reason: "Mitigated" },
      { ...base("yes", "C1"), type: "change_blocker", blocker: true, reason: "Blocks" },
      { ...base("no", "C1"), type: "change_blocker", blocker: false, reason: "Does not block" },
      { ...base("ev", "C1"), type: "add_counter_evidence", evidence: { id: "e1", text: "source", locationIds: ["loc"] } },
    ];
    const result = adjudicatePeerOperations(operations);
    expect(result.accepted.map(({ operationId }) => operationId)).toEqual(["ev"]);
    expect(result.conflicts.map(({ reason }) => reason).sort()).toEqual(["contradictory_blocker", "contradictory_severity"]);
  });
});
