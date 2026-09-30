import { describe, expect, it } from "vitest";

import type { AnalysisReport, ConditionInstance } from "../src/premise-evaluation/analysis.js";
import { assertSameFixtures, compareLineups } from "../src/premise-evaluation/lineups.js";
import type { EvaluationProtocol } from "../src/premise-evaluation/protocol.js";
import type { PremiseGroundTruth } from "../src/metrics/premise.js";

const defects = Array.from({ length: 12 }, (_, index) => `DEF-${index + 1}`);
const truth: PremiseGroundTruth = { fixtureId: "p20-demo", version: 1, items: defects.map((id) => ({ id, kind: "defect", category: "correctness", path: "repo/src/a.ts", location: "a", detectionCriteria: id, rationale: id })) };
const truths = new Map([["p20-demo", truth]]);
const usage = { requests: 1, failedRequests: 0, inputTokens: 100, outputTokens: 10, unknownUsageRequests: 0, attemptDurationMs: 0, repairTurns: 0 };
const instance = (condition: ConditionInstance["condition"], detected: readonly string[], tokens = 110): ConditionInstance =>
  ({ condition, fixtureId: "p20-demo", runIds: [], detected, reported: detected.length, trueReported: detected.length, decoyReports: 0, unlistedReports: 0, decoysHit: [], injectionReportsExcluded: 0, severityAdequate: 0,
    premise: {} as ConditionInstance["premise"], usage: { ...usage, inputTokens: tokens - 10 }, wallClockMs: 0 });
const report = (identity: string, instances: readonly ConditionInstance[]) => ({ protocolIdentity: identity, instances, conditions: [], missingRuns: [] }) as unknown as AnalysisReport;
const analysis = { bootstrapIterations: 2_000, seed: 20260930, confidence: 0.95 };

describe("P20 lineup comparisons", () => {
  it("pairs the defects both lineups observed and applies the prespecified verdict", () => {
    // Three runs of one strong model pooled find half the defects; a three-model panel finds all of them.
    const reports = { premium: report("p20-premium@1.0.0", [instance("B", defects.slice(0, 6)), instance("A_pipeline", defects.slice(0, 5))]), cheap: report("p20-cheap@1.0.0", [instance("C", defects, 330), instance("D", defects.slice(0, 11))]) };
    const result = compareLineups({ comparisonId: "p20-lineups", version: "1.0.0", analysis, comparisons: [
      { name: "cheap panel discovery vs strong model x3", left: { lineup: "cheap", condition: "C" }, right: { lineup: "premium", condition: "B" } },
      { name: "cheap pipeline vs strong single pipeline", left: { lineup: "cheap", condition: "D" }, right: { lineup: "premium", condition: "A_pipeline" } },
      { name: "no shared observations", left: { lineup: "cheap", condition: "A" }, right: { lineup: "premium", condition: "B" } },
    ] }, reports, truths);
    expect(result.comparisonIdentity).toBe("p20-lineups@1.0.0");
    expect(result.comparisons.map(({ name, verdict: outcome, recallDifference }) => [name, outcome, recallDifference.estimate, recallDifference.units])).toEqual([
      ["cheap panel discovery vs strong model x3", "worthwhile", 0.5, 12],
      ["cheap pipeline vs strong single pipeline", "worthwhile", 0.5, 12],
    ]);
    expect(result.comparisons[0]?.knownTokenRatio).toBe(3);
    expect(Object.keys(result.lineups)).toEqual(["premium", "cheap"]);
    expect(() => compareLineups({ comparisonId: "x", version: "1", analysis, comparisons: [{ name: "absent", left: { lineup: "light", condition: "D" }, right: { lineup: "premium", condition: "B" } }] }, reports, truths)).toThrow("P20_LINEUP_REPORT_ABSENT:light");
  });

  it("refuses lineups that do not run the same fixtures", () => {
    const protocol = (source: string) => ({ fixtures: [{ id: "p20-demo", source, groundTruth: "gt.json", exclude: [], rubric: {} }] }) as unknown as EvaluationProtocol;
    expect(() => assertSameFixtures({ premium: protocol("a"), cheap: protocol("a") })).not.toThrow();
    expect(() => assertSameFixtures({ premium: protocol("a"), cheap: protocol("b") })).toThrow("P20_LINEUP_FIXTURES_DIFFER:cheap");
  });
});
