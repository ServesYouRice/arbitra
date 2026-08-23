import { describe, expect, it } from "vitest";
import { escalateToVerification, verifyItem, verifyItems, VERIFICATION_SUBGRAPH_NODE, type ModelVerificationRequest, type VerificationIssueOperation } from "../../src/nodes/verification/engine.js";
import type { VerificationAttempt, VerificationItem, VerificationMethod, VerificationTools } from "../../src/nodes/verification/ladder.js";

function item(changes: Partial<VerificationItem> = {}): VerificationItem { return { candidateId: "C-1", severity: "high", claim: "Authorization guard is missing", question: "Does the cited path permit access without authorization?", citedEvidenceIds: ["ev-1"], citedContext: [{ evidenceId: "ev-1", text: "return record" }], symbols: ["authorize"], routes: ["GET /records"], dependencies: ["auth-middleware"], ...changes }; }
function attempt(method: Exclude<VerificationMethod, "single_model_question">, verdict: VerificationAttempt["verdict"] = "inconclusive"): VerificationAttempt { return { method, verdict, evidenceIds: verdict === "inconclusive" ? [] : ["ev-verified"], artifactRefs: [`artifact:${method}`], toolCallIds: [`tool:${method}`], activityId: `activity:${method}`, confidence: verdict === "inconclusive" ? null : 0.95 }; }
function tools(verdicts: Partial<Record<Exclude<VerificationMethod, "single_model_question">, VerificationAttempt["verdict"]>> = {}, calls: string[] = [], policies: unknown[] = []): VerificationTools {
  const call = async (method: Exclude<VerificationMethod, "single_model_question">) => { calls.push(method); return attempt(method, verdicts[method]); };
  return { readCitedLines: async () => call("cited_lines"), searchSymbolOrCallPath: async () => call("symbol_or_call_path"), inspectRouteConfigMiddleware: async () => call("route_config_middleware"), inspectDependencyOrImportPath: async () => call("dependency_or_import_path"), runAllowlistedSafeTest: async (_item, policy) => { policies.push(policy); return call("allowlisted_safe_test"); }, boundedDeterministicCheck: async () => call("bounded_deterministic_check") };
}

describe("verification subgraph", () => {
  it("is represented as the existing subgraph kind with verification purpose", () => { expect(VERIFICATION_SUBGRAPH_NODE).toEqual({ kind: "subgraph", purpose: "verification" }); });
  it("implements the exact high-risk evidence-backed objection predicate", () => {
    expect(escalateToVerification({ severity: "high", objections: [{ citesLocation: true, evidenceType: "repository", resolvedBy: null }] })).toBe(true);
    expect(escalateToVerification({ severity: "medium", objections: [{ citesLocation: true, evidenceType: "repository", resolvedBy: null }] })).toBe(false);
    expect(escalateToVerification({ severity: "critical", objections: [{ citesLocation: true, evidenceType: "speculation", resolvedBy: null }] })).toBe(false);
    expect(escalateToVerification({ severity: "critical", objections: [{ citesLocation: true, evidenceType: "test", resolvedBy: "op-1" }] })).toBe(false);
  });

  it("resolves the premise dispute mechanically at the earliest conclusive rung and appends evidence-rich operation", async () => {
    const calls: string[] = []; const operations: VerificationIssueOperation[] = [];
    const result = await verifyItem(item(), tools({ symbol_or_call_path: "confirmed" }, calls), { allowModelCall: true }, { model: { async verify() { throw new Error("model called after deterministic resolution"); } }, sink: { async append(operation) { operations.push(operation); } }, round: 1 });
    expect(calls).toEqual(["cited_lines", "symbol_or_call_path"]); expect(result).toMatchObject({ outcome: "CONFIRMED", method: "symbol_or_call_path", modelCalls: 0 });
    expect(operations[0]).toMatchObject({ type: "accept", citedEvidenceIds: ["ev-verified"], verification: { result: "CONFIRMED", method: "symbol_or_call_path", artifactRefs: ["artifact:symbol_or_call_path"], toolCallIds: ["tool:symbol_or_call_path"], activityId: "activity:symbol_or_call_path" } });
  });

  it("permits one narrow model question only after every deterministic rung is inconclusive", async () => {
    const calls: string[] = []; const requests: ModelVerificationRequest[] = [];
    const result = await verifyItem(item(), tools({}, calls), { allowModelCall: true }, { model: { async verify(request) { requests.push(request); return { outcome: "STILL_NEEDS_VERIFICATION", evidenceIds: ["ev-1"], artifactRefs: ["model-answer"], activityId: "model-activity", confidence: 0.6 }; } }, sink: { async append() {} }, round: 2 });
    expect(calls).toEqual(["cited_lines", "symbol_or_call_path", "route_config_middleware", "dependency_or_import_path", "bounded_deterministic_check"]); expect(requests).toHaveLength(1); expect(Object.keys(requests[0]!)).toEqual(["candidateId", "question", "context"]); expect(requests[0]!.question).not.toContain("\n"); expect(JSON.stringify(requests[0])).not.toContain("Issue Board"); expect(result.modelCalls).toBe(1);
  });

  it("runs an existing test only with the derived repository script policy", async () => {
    const policies: unknown[] = [];
    await verifyItem(item({ allowlistedTest: "pnpm test -- auth" }), tools({ allowlisted_safe_test: "rejected" }, [], policies), { allowModelCall: false }, { sink: { async append() {} }, round: 1 });
    expect(policies).toEqual([{ executionPolicy: "derived_repository_script", command: "pnpm test -- auth" }]);
  });

  it("enforces the configurable item budget and reports rung distribution and resolutions", async () => {
    const operations: VerificationIssueOperation[] = [];
    const run = await verifyItems([item(), item({ candidateId: "C-2" })], tools({ cited_lines: "confirmed" }), { maximumItems: 1, allowModelCall: false, round: 1 }, { sink: { async append(operation) { operations.push(operation); } } });
    expect(operations).toHaveLength(1); expect(run.metrics).toMatchObject({ itemCount: 1, resolvedDisputes: 1, modelCalls: 0, deferredItemIds: ["C-2"], rungDistribution: { cited_lines: 1, single_model_question: 0 } });
  });
});
