import { describe, expect, it } from "vitest";
import { suppressionCandidates, SUPPRESSION_CANDIDATE_NOTE } from "../../src/suppression.js";

describe("suppression candidate join", () => {
  const scan = [{ path: "src/auth.ts", instructionRisk: { level: "high" as const, affectedRanges: [{ ruleId: "instruction_shaped_comment", byteStart: 10, byteEnd: 30 }] } }];
  const scope = { paths: ["src/auth.ts"] };
  const exposure = [{ auditorId: "auditor-a", ranges: [{ path: "src/auth.ts", start: 0, end: 40 }] }];
  it("emits an exposed, uncited risky surface with non-accusatory wording", () => {
    expect(suppressionCandidates(scan, scope, exposure, [])).toEqual([{ path: "src/auth.ts", scannerHits: ["instruction_shaped_comment"], instructionRisk: "high", affectedRanges: [{ start: 10, end: 30 }], readBy: ["auditor-a"], findingsCiting: [], note: SUPPRESSION_CANDIDATE_NOTE }]);
    expect(SUPPRESSION_CANDIDATE_NOTE).toContain("not proof of a defect or an attack"); expect(SUPPRESSION_CANDIDATE_NOTE).toContain("unresolved audit uncertainty");
  });
  it("does not emit outside-scope, unread, clean, or cited surfaces", () => {
    expect(suppressionCandidates(scan, { paths: [] }, exposure, [])).toEqual([]); expect(suppressionCandidates(scan, scope, [], [])).toEqual([]);
    expect(suppressionCandidates(scan, scope, exposure, [{ sourceFindingId: "auditor-b/SEC-1", citations: [{ path: "src/auth.ts", start: 15, end: 20 }] }])).toEqual([]);
    expect(suppressionCandidates([{ path: "src/auth.ts", instructionRisk: { level: null, affectedRanges: [] } }], scope, exposure, [])).toEqual([]);
  });
});
