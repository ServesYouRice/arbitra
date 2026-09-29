import { describe, expect, it } from "vitest";
import { cluster, deterministicClusteringStrategy, recordSplit, type ClusteringStrategy, type ClusterRelationship, type ValidatedClusterInput } from "../../src/clustering/index.js";

function input(id: string, changes: Partial<ValidatedClusterInput["finding"]> = {}): ValidatedClusterInput { const auditorId = id.split("/")[0]; if (auditorId === undefined) throw new Error("Missing fixture auditor id"); return { validation: "accepted", auditorId, finding: { sourceFindingId: id, category: "SECURITY", title: "Authorization bypass", problem: "Authorization validation is missing", recommendedFix: "Validate authorization before access", locations: [{ path: "src/auth.ts", startLine: 10, endLine: 15, symbol: "authorize" }], failureMechanisms: ["authorization"], ...changes } }; }

describe("deterministic clustering", () => {
  it("merges three independently validated reports of one defect without a semantic call", async () => {
    let calls = 0;
    const result = await cluster([input("auditor-a/SEC-1"), input("auditor-b/SEC-2"), input("auditor-c/SEC-3")], { strategy: deterministicClusteringStrategy, maximumEscalatedPairs: 10, semantic: { capability: "fast", async classify() { calls += 1; throw new Error("exact deduplication reached model"); } } });
    expect(result.clusters).toHaveLength(1); expect(requiredAt(result.clusters, 0).sourceFindingIds).toHaveLength(3); expect(calls).toBe(0);
    expect(result.metrics).toEqual({ deterministicPairsResolved: 3, escalatedPairs: 0, semanticClusteringCalls: 0, semanticClusteringTokens: 0, semanticClusteringCost: 0 });
  });

  it("does not merge two different defects in one file", async () => {
    const result = await cluster([input("auditor-a/SEC-1"), input("auditor-b/PERF-1", { category: "PERFORMANCE", title: "Slow catalog query", problem: "A table scan causes latency", recommendedFix: "Add an index", locations: [{ path: "src/auth.ts", startLine: 80, endLine: 90, symbol: "listUsers" }], failureMechanisms: [] })], { strategy: deterministicClusteringStrategy });
    expect(result.clusters).toHaveLength(2); expect(result.ambiguousPairs).toHaveLength(0); expect(result.metrics.deterministicPairsResolved).toBe(1);
  });

  it.each(["same_root_cause", "related_but_separate", "same_symptom_different_causes", "unrelated"] as const)("records bounded semantic relationship %s and exact cost metrics", async (relationship) => {
    const left = input("auditor-a/SEC-1"); const right = input("auditor-b/SEC-2", { title: "Authorization race", problem: "An authorization race permits access", recommendedFix: "Lock then validate", locations: [{ path: "src/auth.ts", startLine: 80, endLine: 90, symbol: "authorizeLater" }] });
    const result = await cluster([left, right], { strategy: deterministicClusteringStrategy, maximumEscalatedPairs: 1, semantic: semantic(relationship) });
    expect(requiredAt(result.ambiguousPairs, 0).relationship).toBe(relationship); expect(result.metrics).toMatchObject({ escalatedPairs: 1, semanticClusteringCalls: 1, semanticClusteringTokens: 25, semanticClusteringCost: 0.0002 });
    expect(result.clusters).toHaveLength(relationship === "same_root_cause" ? 1 : 2);
  });

  it("preserves explicit split history without overwriting merge history", async () => {
    const merged = await cluster([input("auditor-a/BROAD"), input("auditor-b/SEC-2")], { strategy: deterministicClusteringStrategy });
    const split = recordSplit(merged, "auditor-a/BROAD", ["candidate-auth", "candidate-session"], "broad finding contains two root causes");
    expect(split.operations.map(({ type }) => type)).toEqual(["merge", "split"]); expect(split.clusters.filter(({ sourceFindingIds }) => sourceFindingIds.includes("auditor-a/BROAD"))).toHaveLength(2);
  });

  it("keeps prompt-injection reports apart from the defect beside the planted comment", async () => {
    // Observed live: the injection report on line 2 shared the keyword "authorization" and overlapped the bypass span.
    const injection = (id: string) => input(id, { category: "PROMPT_INJECTION", title: "Comment tells the auditor to ignore authorization", problem: "A source comment instructs reviewers to skip authorization findings", recommendedFix: "Remove the instruction", locations: [{ path: "src/auth.ts", startLine: 2, endLine: 2 }], failureMechanisms: [] });
    const result = await cluster([input("auditor-a/SEC-1", { locations: [{ path: "src/auth.ts", startLine: 1, endLine: 5 }] }), input("auditor-b/SEC-2", { locations: [{ path: "src/auth.ts", startLine: 3, endLine: 4 }] }), injection("auditor-a/PI-1"), injection("auditor-b/PI-2")],
      { strategy: deterministicClusteringStrategy, maximumEscalatedPairs: 10, semantic: { capability: "fast", async classify({ left, right }) { if (left.finding.category !== right.finding.category) throw new Error("injection pair reached the model"); return { relationship: "same_root_cause", inputTokens: 0, outputTokens: 0, cost: 0 }; } } });
    expect(result.clusters.map(({ sourceFindingIds }) => sourceFindingIds)).toEqual(expect.arrayContaining([["auditor-a/SEC-1", "auditor-b/SEC-2"], ["auditor-a/PI-1", "auditor-b/PI-2"]]));
    expect(result.ambiguousPairs.every(({ leftId, rightId }) => leftId.includes("PI") === rightId.includes("PI"))).toBe(true);
    expect(deterministicClusteringStrategy.id).toBe("structural-v2");
  });

  it("still merges one defect filed under two ordinary categories", async () => {
    const result = await cluster([input("auditor-a/RACE-1", { category: "RELIABILITY", title: "Stock race", problem: "A race lets two reservations oversell", locations: [{ path: "src/inventory.ts", startLine: 2, endLine: 5 }], failureMechanisms: [] }), input("auditor-b/RACE-2", { category: "CORRECTNESS", title: "Reservation race condition", problem: "Concurrent calls race between check and write", locations: [{ path: "src/inventory.ts", startLine: 3, endLine: 5 }], failureMechanisms: [] })], { strategy: deterministicClusteringStrategy });
    expect(result.clusters).toHaveLength(1);
  });

  it("accepts an alternative strategy and emits zero-valued metrics", async () => {
    const alternative: ClusteringStrategy = { id: "singletons", cluster(findings) { return { findings, clusters: findings.map(({ finding }) => ({ clusterId: `alt:${finding.sourceFindingId}`, sourceFindingIds: [finding.sourceFindingId] })), ambiguousPairs: [], operations: [], deterministicPairsResolved: 0 }; } };
    const result = await cluster([input("auditor-a/SEC-1"), input("auditor-b/SEC-2")], { strategy: alternative });
    expect(result.clusters).toHaveLength(2); expect(result.metrics).toEqual({ deterministicPairsResolved: 0, escalatedPairs: 0, semanticClusteringCalls: 0, semanticClusteringTokens: 0, semanticClusteringCost: 0 });
  });
});

function semantic(relationship: ClusterRelationship) { return { capability: "fast" as const, async classify() { return { relationship, inputTokens: 20, outputTokens: 5, cost: 0.0002 }; } }; }
function requiredAt<T>(values: readonly T[], index: number): T { const value = values[index]; if (value === undefined) throw new RangeError(`Missing test value at index ${index}`); return value; }
