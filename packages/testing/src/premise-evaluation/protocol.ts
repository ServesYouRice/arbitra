import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import type { PremiseGroundTruth } from "../metrics/premise.js";

/**
 * A prespecified premise-evaluation protocol (completion plan P06). Everything that decides
 * what runs and how it is scored is fixed here before any run: fixtures, the answer rubric,
 * the run schedule, budgets and the analysis. The rubric and ground truth live outside every
 * audited checkout, so answers never enter model context.
 */
export type EvaluationCondition = "single" | "heterogeneous";
export const SEVERITY_ORDER = Object.freeze(["informational", "low", "medium", "high", "critical"] as const);
export type RubricSeverity = (typeof SEVERITY_ORDER)[number];

/** Where a ground-truth item lives in the checkout, and what prose identifies its defect. */
export interface RubricEntry {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  /** Case-insensitive pattern over a finding's title, problem and fix. Null for a decoy: location alone matches. */
  readonly keywords: string | null;
  /** The least severity a correct report of this defect carries. Null for a decoy. */
  readonly minimumSeverity: RubricSeverity | null;
}

export interface FixtureSpec {
  readonly id: string;
  /** Repository-relative source directory copied into each checkout. */
  readonly source: string;
  /** Repository-relative ground truth in the premise format; never copied. */
  readonly groundTruth: string;
  /** Source files left out of the checkout (paths relative to `source`). */
  readonly exclude: readonly string[];
  readonly rubric: Readonly<Record<string, RubricEntry>>;
}

export interface ScheduledRun { readonly fixtureId: string; readonly condition: EvaluationCondition; readonly repetition: number }

export interface EvaluationProtocol {
  readonly schemaVersion: 1;
  readonly protocolId: string;
  readonly version: string;
  /** Repository-relative materialized heterogeneous configuration; the single-auditor configuration is derived from it. */
  readonly configuration: string;
  readonly singleAuditor: { readonly auditorId: string; readonly preset: "diff-fast" };
  readonly fixtures: readonly FixtureSpec[];
  /** Executed in order. A run is not started once a budget is exhausted. */
  readonly schedule: readonly ScheduledRun[];
  readonly budget: { readonly maximumModelRequests: number; readonly maximumTokens: number; readonly maximumWallClockMs: number };
  readonly analysis: { readonly bootstrapIterations: number; readonly seed: number; readonly confidence: number };
}

export function loadProtocol(path: string): EvaluationProtocol { return validateProtocol(JSON.parse(readFileSync(path, "utf8")) as unknown); }

export function validateProtocol(value: unknown): EvaluationProtocol {
  const protocol = value as EvaluationProtocol;
  const fail = (detail: string): never => { throw new Error(`INVALID_PREMISE_PROTOCOL:${detail}`); };
  if (typeof value !== "object" || value === null || protocol.schemaVersion !== 1) fail("schemaVersion");
  for (const [name, text] of [["protocolId", protocol.protocolId], ["version", protocol.version], ["configuration", protocol.configuration]] as const) if (typeof text !== "string" || text.trim() === "") fail(name);
  if (protocol.singleAuditor?.preset !== "diff-fast" || typeof protocol.singleAuditor.auditorId !== "string") fail("singleAuditor");
  if (!Array.isArray(protocol.fixtures) || protocol.fixtures.length === 0) fail("fixtures");
  const fixtureIds = new Set<string>();
  for (const fixture of protocol.fixtures) {
    if (fixtureIds.has(fixture.id)) fail(`fixtures.${fixture.id}:duplicate`);
    fixtureIds.add(fixture.id);
    if (isAbsolute(fixture.source) || isAbsolute(fixture.groundTruth) || !Array.isArray(fixture.exclude)) fail(`fixtures.${fixture.id}:paths`);
    for (const [id, entry] of Object.entries(fixture.rubric)) {
      if (!Number.isSafeInteger(entry.startLine) || !Number.isSafeInteger(entry.endLine) || entry.startLine < 1 || entry.endLine < entry.startLine || entry.path.trim() === "") fail(`fixtures.${fixture.id}.rubric.${id}:span`);
      if (entry.keywords !== null) new RegExp(entry.keywords, "iu");
      if (entry.minimumSeverity !== null && !SEVERITY_ORDER.includes(entry.minimumSeverity)) fail(`fixtures.${fixture.id}.rubric.${id}:severity`);
    }
  }
  const keys = new Set<string>();
  for (const run of protocol.schedule) {
    if (!fixtureIds.has(run.fixtureId) || (run.condition !== "single" && run.condition !== "heterogeneous") || !Number.isSafeInteger(run.repetition) || run.repetition < 1) fail(`schedule.${run.fixtureId}`);
    const key = scheduledRunKey(run);
    if (keys.has(key)) fail(`schedule.${key}:duplicate`);
    keys.add(key);
  }
  const { budget, analysis } = protocol;
  if (![budget.maximumModelRequests, budget.maximumTokens, budget.maximumWallClockMs].every((limit) => Number.isSafeInteger(limit) && limit > 0)) fail("budget");
  if (!Number.isSafeInteger(analysis.bootstrapIterations) || analysis.bootstrapIterations < 100 || !Number.isSafeInteger(analysis.seed) || !(analysis.confidence > 0 && analysis.confidence < 1)) fail("analysis");
  return protocol;
}

/** Load a fixture's ground truth and check the rubric covers exactly its items. */
export function loadGroundTruth(root: string, fixture: FixtureSpec): PremiseGroundTruth {
  const truth = JSON.parse(readFileSync(resolve(root, fixture.groundTruth), "utf8")) as PremiseGroundTruth;
  if (truth.fixtureId !== fixture.id) throw new Error(`PREMISE_FIXTURE_ID_MISMATCH:${fixture.id}:${truth.fixtureId}`);
  const items = new Set(truth.items.map(({ id }) => id));
  const rubric = new Set(Object.keys(fixture.rubric));
  const missing = [...items].filter((id) => !rubric.has(id)); const extra = [...rubric].filter((id) => !items.has(id));
  if (missing.length > 0 || extra.length > 0) throw new Error(`PREMISE_RUBRIC_MISMATCH:${fixture.id}:missing=${missing.join(",")}:extra=${extra.join(",")}`);
  for (const item of truth.items) if ((item.kind === "decoy") !== (fixture.rubric[item.id]?.keywords === null)) throw new Error(`PREMISE_RUBRIC_KIND_MISMATCH:${fixture.id}:${item.id}`);
  return truth;
}

export function scheduledRunKey(run: ScheduledRun): string { return `${run.fixtureId}/${run.condition}/r${run.repetition}`; }
