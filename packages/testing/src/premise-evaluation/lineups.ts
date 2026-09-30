import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PremiseGroundTruth } from "../metrics/premise.js";
import { pairedComparison, verdict, type AnalysisCondition, type AnalysisReport, type Comparison, type ConditionSummary, type Decision } from "./analysis.js";
import type { EvaluationProtocol } from "./protocol.js";

/**
 * Lineups (P20): a single strong model run repeatedly, and panels of three models, each run as its
 * own prespecified P06-style protocol over the same fixtures. Their analyses are combined here. A
 * comparison pairs the ground-truth defects of fixtures both sides observed, exactly as within one
 * protocol, and gets the same prespecified verdict.
 */
export interface LineupSide { readonly lineup: string; readonly condition: AnalysisCondition }
export interface LineupComparisonSpec { readonly name: string; readonly left: LineupSide; readonly right: LineupSide }
export interface LineupComparison extends LineupComparisonSpec, Pick<Comparison, "recallDifference" | "precisionDifference" | "knownTokenRatio"> {
  readonly verdict: Decision["heterogeneousOverRepeated"];
}

export interface LineupPlan {
  readonly schemaVersion: 1;
  readonly comparisonId: string;
  readonly version: string;
  /** Repository-relative protocol and evidence directory of each lineup. */
  readonly lineups: Readonly<Record<string, { readonly protocol: string; readonly evidence: string }>>;
  readonly comparisons: readonly LineupComparisonSpec[];
  readonly analysis: EvaluationProtocol["analysis"];
  /** Repository-relative path the combined report is written to. */
  readonly output: string;
}

export interface LineupReport {
  readonly schemaVersion: 1;
  readonly comparisonIdentity: string;
  readonly lineups: Readonly<Record<string, { readonly protocolIdentity: string; readonly conditions: readonly ConditionSummary[]; readonly missingRuns: readonly string[] }>>;
  readonly comparisons: readonly LineupComparison[];
}

export function loadLineupPlan(root: string, path: string): LineupPlan {
  const plan = JSON.parse(readFileSync(resolve(root, path), "utf8")) as LineupPlan;
  const fail = (detail: string): never => { throw new Error(`INVALID_LINEUP_PLAN:${detail}`); };
  if (plan.schemaVersion !== 1 || typeof plan.comparisonId !== "string" || typeof plan.version !== "string" || typeof plan.output !== "string") fail("identity");
  const ids = Object.keys(plan.lineups ?? {});
  if (ids.length < 2) fail("lineups");
  for (const { name, left, right } of plan.comparisons ?? []) if (typeof name !== "string" || ![left, right].every((side) => ids.includes(side?.lineup))) fail(`comparisons.${String(name)}`);
  return plan;
}

/** Every lineup must run the same fixtures, ground truth and rubric, or no comparison pairs its units. */
export function assertSameFixtures(protocols: Readonly<Record<string, EvaluationProtocol>>): void {
  const [first, ...rest] = Object.entries(protocols);
  if (first === undefined) throw new Error("P20_LINEUPS_ABSENT");
  const fixtures = JSON.stringify(first[1].fixtures);
  for (const [lineup, protocol] of rest) if (JSON.stringify(protocol.fixtures) !== fixtures) throw new Error(`P20_LINEUP_FIXTURES_DIFFER:${lineup}`);
}

export function compareLineups(plan: Pick<LineupPlan, "comparisonId" | "version" | "comparisons" | "analysis">, reports: Readonly<Record<string, AnalysisReport>>, truths: ReadonlyMap<string, PremiseGroundTruth>): LineupReport {
  const instancesOf = ({ lineup, condition }: LineupSide) => {
    const report = reports[lineup];
    if (report === undefined) throw new Error(`P20_LINEUP_REPORT_ABSENT:${lineup}`);
    return report.instances.filter((instance) => instance.condition === condition);
  };
  const comparisons = plan.comparisons.flatMap((spec) => {
    const result = pairedComparison(instancesOf(spec.left), instancesOf(spec.right), truths, plan.analysis);
    return result === null ? [] : [Object.freeze({ ...spec, ...result, verdict: verdict(result) })];
  });
  return Object.freeze({
    schemaVersion: 1, comparisonIdentity: `${plan.comparisonId}@${plan.version}`,
    lineups: Object.freeze(Object.fromEntries(Object.entries(reports).map(([lineup, report]) => [lineup, Object.freeze({ protocolIdentity: report.protocolIdentity, conditions: report.conditions, missingRuns: report.missingRuns })]))),
    comparisons: Object.freeze(comparisons),
  });
}
