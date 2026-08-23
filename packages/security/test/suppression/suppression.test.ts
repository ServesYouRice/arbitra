import { describe, expect, it } from "vitest";
import { allocateOverlap, type OverlapSignal } from "../../src/overlap-allocator.js";
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

describe("security overlap allocation", () => {
  const signal = (path: string, changes: Partial<OverlapSignal> = {}): OverlapSignal => ({ path, level: "low", instructionShaped: false, securitySensitiveChanged: false, suspiciousDirective: false, controlPolicyChanged: false, estimatedAdditionalTokens: 60, ...changes });
  it("always forces the three security-floor classes without charging the medium/low budget", () => {
    const inputs = [signal("high.ts", { level: "high", instructionShaped: true }), signal("auth.ts", { securitySensitiveChanged: true, suspiciousDirective: true }), signal(".arbitra/protocol.yaml", { controlPolicyChanged: true })];
    const plan = allocateOverlap(inputs, { maximumAdditionalTokens: 0, mode: "ci" });
    expect(plan.decisions.map(({ disposition }) => disposition)).toEqual(["forced", "forced", "forced"]); expect(plan.budget.usedAdditionalTokens).toBe(0); expect(plan.securityCoverage.degraded).toBe(false);
  });
  it("contains cost amplification, records every decision and degrades visibly", () => {
    const inputs = Array.from({ length: 20 }, (_, index) => signal(`file-${index}.ts`, { level: index < 10 ? "medium" : "low" }));
    const plan = allocateOverlap(inputs, { maximumAdditionalTokens: 180, mode: "ci" });
    expect(plan.budget).toEqual({ maximumAdditionalTokens: 180, usedAdditionalTokens: 180, remainingAdditionalTokens: 0 }); expect(plan.decisions).toHaveLength(20); expect(plan.decisions.filter(({ disposition }) => disposition === "budgeted")).toHaveLength(3); expect(plan.decisions.filter(({ disposition }) => disposition === "not_allocated")).toHaveLength(17);
    expect(plan.securityCoverage).toEqual({ degraded: true, reason: "overlap_budget_exceeded", requiredAction: "fail_closed" });
  });
  it("offers an explicit interactive choice or configured CI behavior when degraded", () => {
    const inputs = [signal("one.ts")];
    expect(allocateOverlap(inputs, { maximumAdditionalTokens: 0, mode: "interactive" }).securityCoverage.requiredAction).toBe("offer_raise_continue_or_cancel");
    expect(allocateOverlap(inputs, { maximumAdditionalTokens: 0, mode: "ci", ciPolicy: "continue_degraded" }).securityCoverage.requiredAction).toBe("continue_degraded");
  });
});
