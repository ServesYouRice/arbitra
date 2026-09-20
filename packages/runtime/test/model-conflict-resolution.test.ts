import { describe, expect, it } from "vitest";
import { agreedConflictResolution, conflictResolutionView } from "../src/model-conflict-resolution.js";
import { DEFAULT_CONSENSUS_POLICY } from "@arbitra/workflow/consensus/engine.js";
import type { PeerOperationConflict } from "../src/peer-operation-conflicts.js";

const auditors = ["a", "b", "c"].map((auditorId) => ({ auditorId, independenceGroup: auditorId }));
const votes = auditors.map(({ auditorId }) => ({ reviewerId: auditorId, selection: "retain_original", evidenceIds: ["e"], rationale: "Source" }));

describe("evidence-backed conflict resolution", () => {
  it("requires all reviewers, independent groups, and evidence without overriding dissent", () => {
    expect(agreedConflictResolution(votes, auditors, DEFAULT_CONSENSUS_POLICY)).toBe("retain_original");
    expect(agreedConflictResolution(votes.slice(0, 2), auditors, DEFAULT_CONSENSUS_POLICY)).toBeNull();
    expect(agreedConflictResolution(votes.map((vote, index) => index === 0 ? { ...vote, selection: "unresolved" } : vote), auditors, DEFAULT_CONSENSUS_POLICY)).toBeNull();
    expect(agreedConflictResolution(votes.map((vote) => ({ ...vote, evidenceIds: [] })), auditors, DEFAULT_CONSENSUS_POLICY)).toBeNull();
    expect(agreedConflictResolution(votes, auditors.map((auditor) => ({ ...auditor, independenceGroup: "same" })), DEFAULT_CONSENSUS_POLICY)).toBeNull();
    expect(agreedConflictResolution(votes.map((vote) => ({ ...vote, reviewerId: "a" })), auditors, DEFAULT_CONSENSUS_POLICY)).toBeNull();
  });

  it("anonymizes proposals and rejects invented choices or evidence", () => {
    const conflict: PeerOperationConflict = { candidateIds: ["C1"], operationIds: ["secret-operation"], reason: "contradictory_severity", proposals: [{ operationId: "secret-operation", authorId: "secret-author", candidateId: "C1", round: 1, type: "change_severity", severity: "low", reason: "Guard exists", citedEvidenceIds: ["secret-evidence"] }] };
    const view = conflictResolutionView(conflict, { candidates: {}, evidenceIds: new Map([["E1", "secret-evidence"]]), findingIds: new Map(), locationIds: new Map() });
    expect(JSON.stringify(view.input)).not.toContain("secret-");
    expect(view.parse({ selection: "proposal-1", evidenceIds: ["E1"], rationale: "Guard" })).toMatchObject({ selection: "secret-operation", evidenceIds: ["secret-evidence"] });
    expect(() => view.parse({ selection: "secret-operation", evidenceIds: ["E1"], rationale: "Guard" })).toThrow("UNKNOWN_CONFLICT_SELECTION");
    expect(() => view.parse({ selection: "retain_original", evidenceIds: ["other"], rationale: "Guard" })).toThrow("UNKNOWN_CONFLICT_EVIDENCE");
    expect(() => view.parse({ selection: "retain_original", evidenceIds: [], rationale: "Guard" })).toThrow("CONFLICT_RESOLUTION_REQUIRES_EVIDENCE");
    const prior = { reviewerId: "a", selection: "retain_original", evidenceIds: ["secret-evidence"], rationale: "Original" };
    const followup = conflictResolutionView(conflict, { candidates: {}, evidenceIds: new Map([["E1", "secret-evidence"], ["E2", "new-evidence"]]), findingIds: new Map(), locationIds: new Map() }, prior);
    expect(() => followup.parse({ selection: "proposal-1", evidenceIds: ["E1"], rationale: "Changed" })).toThrow("CONFORMITY_CONFLICT_FLIP_WITHOUT_NEW_EVIDENCE");
    expect(followup.parse({ selection: "proposal-1", evidenceIds: ["E2"], rationale: "New evidence" }).selection).toBe("secret-operation");
  });
});
