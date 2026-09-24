import {
  CORPUS_IDENTITY_DIMENSIONS,
  OUTCOME_STATES,
  type CorpusIdentityDimension,
  type EvaluationRunProvenance,
  type IndependenceObservation,
  type OutcomeState,
  type RealWorldOutcomeObservation,
} from "@arbitra/schemas/evaluation-corpus.js";

import { canonicalJson } from "../canonical-json.js";
import type { CorpusEntryView, CorpusView } from "./state.js";

export interface CorpusAggregateQuery {
  readonly runIds: readonly string[] | null;
  readonly groupBy: readonly CorpusIdentityDimension[];
}

/**
 * Raised instead of aggregating observations whose model, harness, protocol, ground-truth
 * or execution-mode identity differs, unless that dimension is an explicit grouping key.
 * The message format matches `IncomparableIdentityError` in `metrics/query.ts`.
 */
export class IncomparableCorpusAggregationError extends Error {
  constructor(readonly dimension: CorpusIdentityDimension, readonly identities: readonly string[]) {
    super(`INCOMPARABLE_IDENTITY_MIX:${dimension}: group by ${dimension} or narrow the filter`);
    this.name = "IncomparableCorpusAggregationError";
  }
}

export interface CorpusDenominator {
  /** Runs contributing at least one observation. */
  readonly runCount: number;
  readonly observationCount: number;
  readonly runsWithGroundTruth: number;
  readonly adjudicatedCount: number;
  /** Requested run ids that contributed no observation to this corpus. */
  readonly unmatchedRunIds: readonly string[];
}

export interface OutcomeSummaryRow {
  readonly group: Readonly<Partial<Record<CorpusIdentityDimension, string>>>;
  readonly runCount: number;
  readonly observationCount: number;
  readonly adjudicatedCount: number;
  readonly outcomes: Readonly<Record<OutcomeState, number>>;
  /** `total` is null when any contributing cost is unknown; it is never a partial sum. */
  readonly costUsd: { readonly total: number | null; readonly knownCount: number; readonly unknownCount: number };
  /** `mean` covers known values only and is null when none are known. */
  readonly latencyMs: { readonly mean: number | null; readonly knownCount: number; readonly unknownCount: number };
}

export interface OutcomeSummary {
  readonly corpus: "real_world_outcomes";
  readonly groupBy: readonly CorpusIdentityDimension[];
  readonly denominator: CorpusDenominator;
  readonly rows: readonly OutcomeSummaryRow[];
}

export interface IndependenceSummaryRow {
  readonly group: Readonly<Partial<Record<CorpusIdentityDimension, string>>>;
  readonly runCount: number;
  readonly findingCount: number;
  readonly adjudicatedCount: number;
  readonly acceptedCount: number;
  readonly acceptedRate: number | null;
  /** Findings at least one auditor found independently, and at least two did. */
  readonly independentlyFoundCount: number;
  readonly multiplyFoundCount: number;
  /** Sum over findings of the number of auditors that were in a position to find each one. */
  readonly auditorSlotCount: number;
}

export interface IndependenceSummary {
  readonly corpus: "independence";
  readonly groupBy: readonly CorpusIdentityDimension[];
  readonly applicable: boolean;
  readonly reason: "no_independence_observations" | null;
  readonly denominator: CorpusDenominator;
  readonly rows: readonly IndependenceSummaryRow[];
}

export function summarizeOutcomes(view: CorpusView, query: CorpusAggregateQuery): OutcomeSummary {
  const selected = select(view, "real_world_outcomes", query);
  const rows = grouped(selected, query.groupBy, (group, entries) => {
    const observations = entries.map(({ entry }) => entry.effective as RealWorldOutcomeObservation);
    const costs = observations.map(({ costUsd }) => costUsd);
    const latencies = observations.flatMap(({ latencyMs }) => latencyMs === null ? [] : [latencyMs]);
    const knownCosts = costs.flatMap((cost) => cost === null ? [] : [cost]);
    return Object.freeze({
      group, runCount: runCount(entries), observationCount: entries.length,
      adjudicatedCount: entries.filter(({ entry }) => entry.judgmentVersion > 0).length,
      outcomes: Object.freeze(Object.fromEntries(OUTCOME_STATES.map((state) => [state, observations.filter(({ outcome }) => outcome === state).length])) as Record<OutcomeState, number>),
      costUsd: Object.freeze({ total: knownCosts.length === costs.length ? round(sum(knownCosts)) : null, knownCount: knownCosts.length, unknownCount: costs.length - knownCosts.length }),
      latencyMs: Object.freeze({ mean: latencies.length === 0 ? null : round(sum(latencies) / latencies.length), knownCount: latencies.length, unknownCount: observations.length - latencies.length }),
    });
  });
  return Object.freeze({ corpus: "real_world_outcomes", groupBy: Object.freeze([...query.groupBy]), denominator: denominator(selected, query), rows });
}

export function summarizeIndependence(view: CorpusView, query: CorpusAggregateQuery): IndependenceSummary {
  const selected = select(view, "independence", query);
  const rows = grouped(selected, query.groupBy, (group, entries) => {
    const observations = entries.map(({ entry }) => entry.effective as IndependenceObservation);
    const acceptedCount = observations.filter(({ accepted }) => accepted).length;
    return Object.freeze({
      group, runCount: runCount(entries), findingCount: entries.length,
      adjudicatedCount: entries.filter(({ entry }) => entry.judgmentVersion > 0).length,
      acceptedCount, acceptedRate: entries.length === 0 ? null : round(acceptedCount / entries.length),
      independentlyFoundCount: observations.filter(({ independentlyFoundBy }) => independentlyFoundBy.length >= 1).length,
      multiplyFoundCount: observations.filter(({ independentlyFoundBy }) => independentlyFoundBy.length >= 2).length,
      auditorSlotCount: sum(observations.map(({ auditorIds }) => auditorIds.length)),
    });
  });
  return Object.freeze({
    corpus: "independence", groupBy: Object.freeze([...query.groupBy]),
    applicable: selected.length > 0, reason: selected.length > 0 ? null : "no_independence_observations",
    denominator: denominator(selected, query), rows,
  });
}

/** The identity string for one aggregation dimension of a run. */
export function corpusIdentity(dimension: CorpusIdentityDimension, run: EvaluationRunProvenance): string {
  switch (dimension) {
    case "model":
      return canonicalJson(run.models.map((model) => [model.modelId, model.modelProfileVersion, model.transportId, model.transportVersion])
        .map((parts) => canonicalJson(parts)).sort());
    case "harness":
      return canonicalJson([run.harness.id, run.harness.version, run.harness.policyHash]);
    case "protocol":
      return canonicalJson([run.protocol.id, run.protocol.version, run.protocol.hash]);
    case "groundTruth":
      return run.groundTruth === null ? "null" : canonicalJson([run.groundTruth.groundTruthId, run.groundTruth.version]);
    case "mode":
      return run.mode;
  }
}

interface SelectedEntry { readonly entry: CorpusEntryView; readonly run: EvaluationRunProvenance }

function select(view: CorpusView, corpus: "real_world_outcomes" | "independence", query: CorpusAggregateQuery): readonly SelectedEntry[] {
  const selected = view.entries(corpus, query.runIds).map((entry) => {
    const run = view.run(entry.original.runId);
    if (run === null) throw new Error(`CORPUS_RUN_PROVENANCE_MISSING:${entry.original.runId}`);
    return { entry, run };
  });
  for (const dimension of CORPUS_IDENTITY_DIMENSIONS) {
    if (query.groupBy.includes(dimension)) continue;
    const identities = [...new Set(selected.map(({ run }) => corpusIdentity(dimension, run)))].sort();
    if (identities.length > 1) throw new IncomparableCorpusAggregationError(dimension, Object.freeze(identities));
  }
  return selected;
}

function grouped<Row>(selected: readonly SelectedEntry[], groupBy: readonly CorpusIdentityDimension[],
  build: (group: Readonly<Partial<Record<CorpusIdentityDimension, string>>>, entries: readonly SelectedEntry[]) => Row): readonly Row[] {
  const groups = new Map<string, SelectedEntry[]>();
  for (const selectedEntry of selected) {
    const key = canonicalJson(groupBy.map((dimension) => corpusIdentity(dimension, selectedEntry.run)));
    const members = groups.get(key) ?? []; members.push(selectedEntry); groups.set(key, members);
  }
  return Object.freeze([...groups.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, entries]) => {
    const first = entries[0];
    if (first === undefined) throw new Error("CORPUS_EMPTY_GROUP");
    const group = Object.freeze(Object.fromEntries(groupBy.map((dimension) => [dimension, corpusIdentity(dimension, first.run)])));
    return build(group, entries);
  }));
}

function denominator(selected: readonly SelectedEntry[], query: CorpusAggregateQuery): CorpusDenominator {
  const runs = new Map(selected.map(({ run }) => [run.runId, run]));
  return Object.freeze({
    runCount: runs.size,
    observationCount: selected.length,
    runsWithGroundTruth: [...runs.values()].filter(({ groundTruth }) => groundTruth !== null).length,
    adjudicatedCount: selected.filter(({ entry }) => entry.judgmentVersion > 0).length,
    unmatchedRunIds: Object.freeze((query.runIds ?? []).filter((runId) => !runs.has(runId))),
  });
}

function runCount(entries: readonly SelectedEntry[]): number { return new Set(entries.map(({ run }) => run.runId)).size; }
function sum(values: readonly number[]): number { return values.reduce((total, value) => total + value, 0); }
function round(value: number): number { return Math.round(value * 1_000_000) / 1_000_000; }
