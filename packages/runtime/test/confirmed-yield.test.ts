import { describe, expect, it } from "vitest";
import type { ModelActivityTraceRecord } from "@arbitra/persistence/trace.js";
import type { CanonicalIssueSet } from "@arbitra/workflow/nodes/canonical-issues.js";
import { confirmedYield } from "../src/confirmed-yield.js";

type Issue = CanonicalIssueSet["issues"][number];
const issue = (candidateId: string, sourceFindingIds: string[], disposition: Issue["disposition"], verificationOutcome: Issue["verificationOutcome"], severity: Issue["severity"] = "medium"): Issue => ({
  candidateId, claim: { trust: "untrusted_data", title: candidateId, description: candidateId }, severity, blocker: false, disposition, consensusClaim: null,
  supportCount: 1, reviewDenominator: 3, dissent: [], counterEvidence: [], sourceFindingIds, verificationOutcome, coverage: { reviewedBy: [], missingReviewers: [] }, singleSource: false,
});
const set = (issues: Issue[]) => ({ issues }) as unknown as CanonicalIssueSet;
const trace = (nodeId: string, inputTokens: number, outputTokens: number) => ({ nodeId, tokenUsage: { inputTokens, outputTokens } }) as unknown as ModelActivityTraceRecord;
const models = { "auditor-a": { modelId: "claude-opus-5-5" }, "auditor-b": { modelId: "gpt-6.1-sol" }, "auditor-c": { modelId: "gemini-3.8-flash-high" } };

describe("what a run confirmed against the source", () => {
  it("counts only verifier-confirmed issues as confirmed and prices them in recorded tokens", () => {
    const result = confirmedYield(set([
      issue("i1", ["auditor-a/scope-1/x", "auditor-b/scope-2/y"], "accepted", "CONFIRMED", "high"),
      issue("i2", ["auditor-a/scope-1/z"], "accepted", "CONFIRMED"),
      issue("i3", ["auditor-c/window-1/w"], "rejected", "REJECTED"),
      issue("i4", ["auditor-b/scope-2/v"], "needs_verification", "STILL_NEEDS_VERIFICATION"),
      issue("i5", ["auditor-c/window-1/u"], "accepted", null, "low"),
      issue("i6", ["auditor-c/window-1/t"], "needs_verification", null, "low"),
    ]), models, [trace("auditor-a", 900, 100), trace("verification", 2_000, 1_000)]);
    expect(result).toMatchObject({ candidates: 6, confirmed: 2, confirmedBySeverity: { high: 1, medium: 1 }, rejected: 1, unsettled: 1, acceptedUnchecked: 1, notChecked: 1, tokens: 4_000, tokensPerConfirmed: 2_000 });
  });

  it("credits each auditor with its discovery findings, not with what it added after reading the others", () => {
    const result = confirmedYield(set([
      issue("i1", ["auditor-a/scope-1/x", "auditor-b/review-1/scope-2/op-1/evidence"], "accepted", "CONFIRMED"),
      issue("i2", ["auditor-a/scope-1/y", "auditor-c/window-1/y"], "accepted", "CONFIRMED"),
      issue("i3", ["auditor-b/review-1/op-2/evidence"], "accepted", "CONFIRMED"),
      issue("i4", ["auditor-c/window-1/z"], "rejected", "REJECTED"),
    ]), models, [trace("auditor-c", 500, 500)]);
    expect(result.auditors).toEqual([
      { auditorId: "auditor-a", modelId: "claude-opus-5-5", findings: 2, confirmed: 2, confirmedAlone: 1, discoveryTokens: null },
      { auditorId: "auditor-b", modelId: "gpt-6.1-sol", findings: 0, confirmed: 0, confirmedAlone: 0, discoveryTokens: null },
      { auditorId: "auditor-c", modelId: "gemini-3.8-flash-high", findings: 2, confirmed: 1, confirmedAlone: 0, discoveryTokens: 1_000 },
    ]);
  });

  it("reports no price when nothing was confirmed or no usage was recorded", () => {
    expect(confirmedYield(set([issue("i1", ["auditor-a/scope-1/x"], "rejected", "REJECTED")]), models, [trace("auditor-a", 10, 10)]).tokensPerConfirmed).toBeNull();
    expect(confirmedYield(set([issue("i1", ["auditor-a/scope-1/x"], "accepted", "CONFIRMED")]), models, []).tokens).toBeNull();
  });
});
