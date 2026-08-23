import { describe, expect, it } from "vitest";
import { validateFindings, type FindingSubmission, type ValidatableFinding, type ValidationReasonCode } from "../../src/nodes/validate-findings.js";

const snapshot = { files: { "src/auth.ts": { lineCount: 5, lineStartBytes: [0, 4, 8, 12, 16], byteLength: 20 } } } as const;
const footprints = { "auditor-a": { nodeId: "auditor-a", ranges: [{ path: "src/auth.ts", start: 0, end: 20 }] } } as const;
function finding(changes: Partial<ValidatableFinding> = {}): ValidatableFinding { return { sourceFindingId: "auditor-a/SEC-001", severity: "high", productionBlocker: true, locations: [{ id: "loc-1", path: "src/auth.ts", startLine: 1, endLine: 2 }], evidence: [{ id: "ev-1", text: "one", locationIds: ["loc-1"] }], ...changes }; }
function submission(value: ValidatableFinding = finding(), repairCount: 0 | 1 = 0): FindingSubmission { return { auditorId: "auditor-a", finding: value, repairCount }; }
function dependencies(refs: Array<{ reasons: readonly { code: string }[] }> = []) { return { rejectionStore: { async persistRejection(rejection: { reasons: readonly { code: string }[] }) { refs.push(rejection); return `rejections/${refs.length}.json`; } } }; }

describe("deterministic finding validation", () => {
  it("accepts the positive fixture for every contextual rule", async () => {
    const result = await validateFindings([submission()], snapshot, footprints, dependencies());
    expect(result.accepted).toHaveLength(1); expect(result.rejected).toHaveLength(0); expect(result.accepted[0]).toMatchObject({ validation: "accepted", repaired: false });
  });

  it.each([
    ["auditor_namespace_mismatch", finding({ sourceFindingId: "auditor-b/SEC-001" })],
    ["invalid_repository_path", finding({ locations: [{ id: "loc-1", path: "../auth.ts", startLine: 1, endLine: 2 }] })],
    ["path_not_in_snapshot", finding({ locations: [{ id: "loc-1", path: "src/missing.ts", startLine: 1, endLine: 2 }] })],
    ["invalid_line_range", finding({ locations: [{ id: "loc-1", path: "src/auth.ts", startLine: 3, endLine: 2 }] })],
    ["line_out_of_range", finding({ locations: [{ id: "loc-1", path: "src/auth.ts", startLine: 1, endLine: 402 }] })],
    ["duplicate_location_id", finding({ locations: [{ id: "loc-1", path: "src/auth.ts", startLine: 1, endLine: 1 }, { id: "loc-1", path: "src/auth.ts", startLine: 2, endLine: 2 }] })],
    ["duplicate_evidence_id", finding({ evidence: [{ id: "ev-1", text: "one", locationIds: ["loc-1"] }, { id: "ev-1", text: "two", locationIds: ["loc-1"] }] })],
    ["unknown_location_id", finding({ evidence: [{ id: "ev-1", text: "one", locationIds: ["missing"] }] })],
    ["invalid_blocker_severity", finding({ severity: "medium", productionBlocker: true })],
  ] as const)("rejects the negative %s fixture and persists its reason", async (code, value) => {
    const persisted: Array<{ reasons: readonly { code: string }[] }> = [];
    const result = await validateFindings([submission(value)], snapshot, footprints, dependencies(persisted));
    expect(result.rejected[0]!.reasons.map((reason) => reason.code)).toContain(code as ValidationReasonCode); expect(result.rejected[0]!.rejectionRef).toBe("rejections/1.json"); expect(persisted[0]!.reasons.map(({ code: persistedCode }) => persistedCode)).toContain(code);
  });

  it("rejects evidence outside exposure and reports per-auditor quality rates", async () => {
    const result = await validateFindings([submission()], snapshot, { "auditor-a": { nodeId: "auditor-a", ranges: [{ path: "src/auth.ts", start: 8, end: 20 }] } }, dependencies());
    expect(result.rejected[0]!.reasons).toMatchObject([{ code: "evidence_outside_exposure" }]);
    expect(result.summaries).toEqual([{ auditorId: "auditor-a", total: 1, accepted: 0, rejected: 1, repaired: 0, invalidLocationCount: 0, invalidLocationRate: 0, invalidEvidenceCount: 1, invalidEvidenceRate: 1 }]);
  });

  it("uses at most one repair and records that an accepted finding needed it", async () => {
    let attempts = 0;
    const result = await validateFindings([submission(finding({ locations: [{ id: "loc-1", path: "src/auth.ts", startLine: 1, endLine: 402 }] }))], snapshot, footprints, { ...dependencies(), repair: { async repair() { attempts += 1; return finding(); } } });
    expect(attempts).toBe(1); expect(result.accepted[0]).toMatchObject({ repaired: true }); expect(result.repairs).toEqual([{ sourceFindingId: "auditor-a/SEC-001", attempted: true, outcome: "accepted" }]); expect(result.summaries[0]!.repaired).toBe(1);
    const alreadyRepaired = await validateFindings([submission(finding({ severity: "low", productionBlocker: true }), 1)], snapshot, footprints, { ...dependencies(), repair: { async repair() { attempts += 1; return finding(); } } });
    expect(attempts).toBe(1); expect(alreadyRepaired.rejected).toHaveLength(1);
  });
});
