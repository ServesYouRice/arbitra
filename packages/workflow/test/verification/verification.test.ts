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
    expect(calls).toEqual(["cited_lines", "symbol_or_call_path", "route_config_middleware", "dependency_or_import_path", "bounded_deterministic_check"]); expect(requests).toHaveLength(1); const request = requiredAt(requests, 0); expect(Object.keys(request)).toEqual(["candidateId", "question", "context"]); expect(request.question).not.toContain("\n"); expect(JSON.stringify(request)).not.toContain("Issue Board"); expect(result.modelCalls).toBe(1);
  });

  it("keeps the verifier's reason with its outcome, and records none for an answer that gave none", async () => {
    // Observed on the real-project runs (October 2026): a "cannot tell" or "rejected" outcome carried no reason, so checking one meant reading its tool trace.
    const operations: VerificationIssueOperation[] = [];
    const answer = (reason?: string) => ({ model: { async verify() { return { outcome: "REJECTED" as const, evidenceIds: ["ev-1"], artifactRefs: [], activityId: "model-activity", confidence: 0.7, ...(reason === undefined ? {} : { reason }) }; } }, sink: { async append(operation: VerificationIssueOperation) { operations.push(operation); } }, round: 1 });
    const result = await verifyItem(item(), tools(), { allowModelCall: true }, answer("The caller checks for null before this line."));
    expect(result).toMatchObject({ outcome: "REJECTED", reason: "The caller checks for null before this line." });
    expect(operations[0]?.verification).toMatchObject({ result: "REJECTED", reason: "The caller checks for null before this line." });
    const without = await verifyItem(item(), tools(), { allowModelCall: true }, answer());
    expect(Object.hasOwn(without, "reason")).toBe(false);
    expect(Object.hasOwn(operations[1]?.verification ?? {}, "reason")).toBe(false);
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

  it("caps model questions while continuing deterministic verification after exhaustion", async () => {
    const requests: string[] = [];
    const verificationTools = tools();
    verificationTools.readCitedLines = async ({ candidateId }) => attempt("cited_lines", candidateId === "C-3" ? "confirmed" : "inconclusive");
    const run = await verifyItems([item(), item({ candidateId: "C-2" }), item({ candidateId: "C-3" })], verificationTools,
      { maximumItems: 3, maximumModelCalls: 1, allowModelCall: true, round: 1 },
      { sink: { async append() {} }, model: { async verify({ candidateId }) { requests.push(candidateId); return { outcome: "CONFIRMED", evidenceIds: ["ev-1"], artifactRefs: [], activityId: "model", confidence: 0.9 }; } } });
    expect(requests).toEqual(["C-1"]);
    expect(run.results.map(({ outcome }) => outcome)).toEqual(["CONFIRMED", "STILL_NEEDS_VERIFICATION", "CONFIRMED"]);
    expect(run.metrics).toMatchObject({ itemCount: 3, modelCalls: 1, resolvedDisputes: 2 });
  });

  it("leaves an item unverified when its question cannot fit, and spends no model question on it", async () => {
    const requests: string[] = [];
    const run = await verifyItems([item(), item({ candidateId: "C-2" })], tools(),
      { maximumItems: 2, maximumModelCalls: 1, allowModelCall: true, round: 1 },
      { sink: { async append() {} }, model: { async fits({ candidateId }) { return candidateId !== "C-1"; }, async verify({ candidateId }) { requests.push(candidateId); return { outcome: "CONFIRMED", evidenceIds: ["ev-1"], artifactRefs: [], activityId: "model", confidence: 0.9 }; } } });
    expect(requests).toEqual(["C-2"]);
    expect(run.results.map(({ outcome, method, contextLimited }) => [outcome, method, contextLimited])).toEqual([["STILL_NEEDS_VERIFICATION", "bounded_deterministic_check", true], ["CONFIRMED", "single_model_question", false]]);
    expect(run.metrics).toMatchObject({ modelCalls: 1, resolvedDisputes: 1, contextLimitedItemIds: ["C-1"] });
  });

  it("asks the model questions together and records the outcomes in item order", async () => {
    // Observed live (P20 pilot): fifty items were verified one after another.
    const asked: string[] = []; const operations: VerificationIssueOperation[] = []; let inFlight = 0; let most = 0;
    const verificationTools = tools();
    verificationTools.readCitedLines = async ({ candidateId }) => attempt("cited_lines", candidateId === "C-2" ? "rejected" : "inconclusive");
    const run = await verifyItems(["C-1", "C-2", "C-3", "C-4"].map((candidateId) => item({ candidateId })), verificationTools,
      { maximumItems: 4, maximumModelCalls: 2, allowModelCall: true, round: 1 },
      { sink: { async append(operation) { operations.push(operation); } },
        // Every question is in flight before the first answer, and the last one asked answers first.
        together: async (list, work) => Promise.all(list.map((entry) => work(entry))),
        model: { async verify({ candidateId }) {
          asked.push(candidateId); inFlight += 1; most = Math.max(most, inFlight);
          await new Promise((resolve) => setTimeout(resolve, candidateId === "C-1" ? 20 : 1));
          inFlight -= 1;
          return { outcome: candidateId === "C-1" ? "CONFIRMED" : "REJECTED", evidenceIds: ["ev-1"], artifactRefs: [], activityId: `model:${candidateId}`, confidence: 0.9 };
        } } });
    // The two questions go to the first two items the rungs left open; the item a rung settled spends none.
    expect(asked).toEqual(["C-1", "C-3"]); expect(most).toBe(2);
    expect(run.results.map(({ candidateId, outcome, method }) => [candidateId, outcome, method])).toEqual([["C-1", "CONFIRMED", "single_model_question"], ["C-2", "REJECTED", "cited_lines"], ["C-3", "REJECTED", "single_model_question"], ["C-4", "STILL_NEEDS_VERIFICATION", "bounded_deterministic_check"]]);
    expect(operations.map(({ candidateId }) => candidateId)).toEqual(["C-1", "C-2", "C-3", "C-4"]);
    expect(run.metrics).toMatchObject({ itemCount: 4, modelCalls: 2, resolvedDisputes: 3 });
  });

  it("puts the questions a model groups to it in one call each, and records every answer under its own item", async () => {
    const singles: string[] = []; const groups: string[][] = []; const operations: VerificationIssueOperation[] = [];
    const run = await verifyItems(["C-1", "C-2", "C-3"].map((candidateId) => item({ candidateId })), tools(),
      { maximumItems: 3, allowModelCall: true, round: 1 },
      { sink: { async append(operation) { operations.push(operation); } },
        model: {
          // C-1 and C-3 share the files they cite; C-2 is asked alone.
          async group(requests) { const byId = new Map(requests.map((request) => [request.candidateId, request])); return [[byId.get("C-1"), byId.get("C-3")], [byId.get("C-2")]].map((group) => group.filter((entry): entry is ModelVerificationRequest => entry !== undefined)); },
          async verifyGroup(requests) { groups.push(requests.map(({ candidateId }) => candidateId)); return requests.map(({ candidateId }) => ({ outcome: candidateId === "C-1" ? "CONFIRMED" as const : "REJECTED" as const, evidenceIds: ["ev-1"], artifactRefs: [], activityId: "model:group", confidence: 0.8 })); },
          async verify({ candidateId }) { singles.push(candidateId); return { outcome: "CONFIRMED", evidenceIds: ["ev-1"], artifactRefs: [], activityId: `model:${candidateId}`, confidence: 0.9 }; },
        } });
    expect(groups).toEqual([["C-1", "C-3"]]); expect(singles).toEqual(["C-2"]);
    expect(run.results.map(({ candidateId, outcome }) => [candidateId, outcome])).toEqual([["C-1", "CONFIRMED"], ["C-2", "CONFIRMED"], ["C-3", "REJECTED"]]);
    expect(operations.map(({ candidateId }) => candidateId)).toEqual(["C-1", "C-2", "C-3"]);
    expect(run.metrics).toMatchObject({ modelCalls: 3, modelQuestionCalls: 2 });
    // A grouping that leaves a question out is refused.
    await expect(verifyItems([item()], tools(), { maximumItems: 1, allowModelCall: true, round: 1 }, { sink: { async append() {} },
      model: { async group() { return []; }, async verifyGroup() { return []; }, async verify() { throw new Error("unreachable"); } } })).rejects.toThrow("VERIFICATION_GROUPS_INVALID");
  });
});

function requiredAt<T>(values: readonly T[], index: number): T { const value = values[index]; if (value === undefined) throw new RangeError(`Missing test value at index ${index}`); return value; }
