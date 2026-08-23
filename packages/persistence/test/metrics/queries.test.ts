import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { rebuildIndex } from "../../src/index-db/rebuild.js";
import { CrossProtocolComparisonError, contributionQuery, costQuery, protocolComparison, type PremiseInput, type RunSummaryInput } from "../../src/metrics/queries.js";
import { IncomparableIdentityError, MetricStore } from "../../src/metrics/query.js";
import { TraceRecorder, type ModelActivityTraceRecord, type TraceOutcome } from "../../src/trace.js";

const temporaryRoots: string[] = [];
afterEach(async () => {
  for (const path of temporaryRoots.splice(0)) {
    const resolvedPath = resolve(path); const resolvedTemp = resolve(tmpdir());
    if (!resolvedPath.startsWith(`${resolvedTemp}${sep}`)) throw new Error("UNSAFE_TEST_CLEANUP_PATH");
    await rm(resolvedPath, { recursive: true, force: true });
  }
});

const MODEL_A_IDENTITY = JSON.stringify(["model-a", "1", "fake", "1"]);
const MODEL_B_IDENTITY = JSON.stringify(["model-b", "1", "fake", "1"]);
const premise: PremiseInput = {
  protocolIdentity: "audit@1.0.0", currency: "USD",
  auditors: [
    { auditorId: "reviewer-a", modelIdentity: MODEL_A_IDENTITY, protocolIdentity: "audit@1.0.0", independenceGroup: "provider-a", recall: 0.5, precision: 0.75, falsePositiveRate: 0.25, uniqueTrueContribution: 2, marginalTrueContribution: 2, repairFrequency: 0.25, invalidEvidenceRate: 0, refusalRate: 0, cost: 0.01, latencyMs: 1200 },
    { auditorId: "reviewer-b", modelIdentity: MODEL_B_IDENTITY, protocolIdentity: "audit@1.0.0", independenceGroup: "provider-b", recall: 0.25, precision: null, falsePositiveRate: null, uniqueTrueContribution: 0, marginalTrueContribution: 0, repairFrequency: null, invalidEvidenceRate: null, refusalRate: null, cost: 0.01, latencyMs: 900 },
  ],
  consensus: { acceptedIssueCount: 2, trueAcceptedIssueCount: 1, precision: 0.5, recall: 0.5, costPerTrueAcceptedIssue: 2.05 },
};

describe("evaluation queries over the guarded metric substrate", () => {
  it("segments contribution by model identity and joins measured ground-truth scoring", async () => {
    const store = await storeWith([trace("a", "success"), { ...trace("b", "success"), modelId: "model-b" }]);
    const result = contributionQuery({ store, premise });
    expect(result.segmentation).toEqual(["model"]);
    expect(result.denominator).toMatchObject({ activityCount: 2, auditorCount: 2, groundTruthAvailable: true });
    const first = result.rows.find(({ modelIdentity }) => modelIdentity === MODEL_A_IDENTITY);
    expect(first).toMatchObject({ recall: 0.5, precision: 0.75, uniqueTrueContribution: 2, refusalRate: 0, latencyMs: 1200, independenceGroup: "provider-a" });
    expect(first?.activityCount).toBe(1);
  });

  it("returns unavailable rather than zero for every unmeasured value", async () => {
    const store = await storeWith([trace("a", "success")]);
    const contribution = contributionQuery({ store });
    expect(contribution.rows[0]).toMatchObject({ recall: null, precision: null, falsePositiveRate: null, uniqueTrueContribution: null, marginalTrueContribution: null, repairFrequency: null, invalidEvidenceRate: null, refusalRate: null, latencyMs: null, independenceGroup: null });
    expect(contribution.denominator.groundTruthAvailable).toBe(false);
    const cost = costQuery({ store });
    expect(cost).toMatchObject({ currency: null, costPerTrueAcceptedIssue: null, consensusPrecision: null, consensusRecall: null, verificationResolutionRate: null, escalatedPairs: null, securityOverlapBudget: null, suppressionCandidateCount: null });
  });

  it("reports a run with no independence data as explicitly not applicable", async () => {
    const store = await storeWith([trace("a", "success")]);
    const single: PremiseInput = { ...premise, auditors: [premise.auditors[0]!] };
    expect(contributionQuery({ store, premise: single }).independence).toEqual({ applicable: false, reason: "single_auditor_run_produces_no_independence_data", groups: ["provider-a"] });
    expect(contributionQuery({ store }).independence).toEqual({ applicable: false, reason: "no_ground_truth_measurement", groups: [] });
    expect(contributionQuery({ store, premise }).independence).toEqual({ applicable: true, reason: null, groups: ["provider-a", "provider-b"] });
  });

  it("derives run-level rates from recorded counters only", async () => {
    const store = await storeWith([trace("a", "success"), { ...trace("b", "success"), modelId: "model-b" }]);
    const summary: RunSummaryInput = { verification: { itemCount: 4, resolvedDisputes: 3 }, escalatedPairs: 2, securityOverlapBudget: { budget: 8, used: 6 }, suppressionCandidateCount: 1 };
    const cost = costQuery({ store, premise, runSummary: summary });
    expect(cost).toMatchObject({ totalCostUsd: 0.02, currency: "USD", costPerTrueAcceptedIssue: 2.05, consensusPrecision: 0.5, consensusRecall: 0.5, verificationResolutionRate: 0.75, cacheHitRate: 0.25, escalatedPairs: 2, suppressionCandidateCount: 1 });
    expect(cost.securityOverlapBudget).toEqual({ budget: 8, used: 6, usage: 0.75 });
    expect(costQuery({ store, runSummary: { verification: { itemCount: 0, resolvedDisputes: 0 }, securityOverlapBudget: { budget: 0, used: 0 } } })).toMatchObject({ verificationResolutionRate: null });
  });

  it("reports total cost as unavailable when any activity cost is unknown", async () => {
    const store = await storeWith([trace("a", "success"), { ...trace("b", "success"), costUsd: null }]);
    expect(costQuery({ store }).totalCostUsd).toBeNull();
  });

  it("refuses to aggregate across protocol identity at the query layer", async () => {
    const store = await storeWith([trace("a", "success"), { ...trace("b", "success"), protocolHash: "protocol-hash-b", protocolVersion: "2.0.0" }]);
    expect(() => contributionQuery({ store })).toThrowError(IncomparableIdentityError);
    expect(() => costQuery({ store })).toThrow("INCOMPARABLE_IDENTITY_MIX:protocol");
  });

  it("refuses a cross-protocol comparison with an explanation and compares matching identities", async () => {
    const store = await storeWith([trace("a", "success")]);
    expect(() => protocolComparison({ store, protocolIdentity: "audit@1.0.0" }, { store, protocolIdentity: "audit@2.0.0" })).toThrowError(CrossProtocolComparisonError);
    expect(() => protocolComparison({ store, protocolIdentity: "audit@1.0.0" }, { store, protocolIdentity: "audit@2.0.0" })).toThrow(/CROSS_PROTOCOL_COMPARISON_REFUSED: audit@1\.0\.0 and audit@2\.0\.0 are different protocol identities/u);
    const comparison = protocolComparison({ store, protocolIdentity: "audit@1.0.0" }, { store, protocolIdentity: "audit@1.0.0", runIds: ["run-1"] });
    expect(comparison.comparable).toBe(true);
    expect(comparison.sides).toHaveLength(2);
    expect(comparison.sides[0]?.rows[0]?.group).toHaveProperty("protocol");
  });
});

async function storeWith(traces: readonly ModelActivityTraceRecord[]): Promise<MetricStore> {
  const root = await mkdtemp(join(tmpdir(), "arbitra-eval-")); temporaryRoots.push(root);
  const recorder = new TraceRecorder(root);
  for (const record of traces) await recorder.record(record);
  await rebuildIndex(root);
  return new MetricStore(root);
}

function trace(activityId: string, outcome: TraceOutcome): ModelActivityTraceRecord {
  return {
    schemaVersion: 1, runId: "run-1", nodeId: `node-${activityId}`, activityId, attempt: 1,
    modelId: "model-a", modelProfileVersion: "1", transportId: "fake", transportVersion: "1",
    harnessId: "canonical", harnessVersion: "1", harnessPolicyHash: "harness-policy",
    protocolId: "audit", protocolVersion: "1.0.0", protocolHash: "protocol-hash-a",
    promptHash: "prompt-hash", resolvedProviderConfigHash: "provider-config-hash",
    capability: "balanced", effortRequested: "high", effortResolved: "high",
    inputArtifactRefs: ["artifacts/input.json"], outputArtifactRef: outcome === "success" ? "artifacts/output.json" : null,
    durationMs: 100, tokenUsage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 25, cacheWriteTokens: 0 },
    costUsd: 0.01, cacheHitRate: 0.25, toolCallCount: 2, toolCallErrors: 1, repairCount: 1,
    refusal: outcome === "refusal" ? "policy refusal" : null,
    error: outcome === "error" || outcome === "cancelled" ? { code: outcome === "error" ? "HTTP" : "CANCELLED", message: outcome } : null,
    continuationState: { hash: "continuation-hash", byteLength: 16, scope: "session" },
    advisorTokens: null, outcome,
  };
}
