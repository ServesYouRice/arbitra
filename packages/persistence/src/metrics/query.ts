import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { harnessIdentity, modelIdentity, protocolIdentity } from "../index-db/rebuild.js";
import type { ModelActivityTraceRecord, TraceOutcome } from "../trace.js";

export type IdentityDimension = "model" | "harness" | "protocol";
export interface MetricQuery {
  readonly runIds?: readonly string[];
  readonly outcomes?: readonly TraceOutcome[];
  readonly groupBy: readonly IdentityDimension[];
}
export interface MetricRow {
  readonly group: Readonly<Partial<Record<IdentityDimension, string>>>;
  readonly activityCount: number;
  readonly successCount: number;
  readonly refusalCount: number;
  readonly errorCount: number;
  readonly cancelledCount: number;
  readonly cacheHitRate: number | null;
  readonly repairCount: number;
  readonly toolCallCount: number;
  readonly toolCallErrors: number;
  readonly costUsd: number | null;
}

export class IncomparableIdentityError extends Error {
  constructor(readonly dimension: IdentityDimension, readonly identities: readonly string[]) {
    super(`INCOMPARABLE_IDENTITY_MIX:${dimension}: group by ${dimension} or narrow the filter`);
    this.name = "IncomparableIdentityError";
  }
}

export class MetricStore {
  constructor(private readonly runsDirectory: string) {}
  query(query: MetricQuery): readonly MetricRow[] {
    validateGroupBy(query.groupBy);
    const database = new DatabaseSync(join(this.runsDirectory, "index.db"), { readOnly: true });
    let traces: ModelActivityTraceRecord[];
    try {
      const rows = database.prepare("SELECT trace_json FROM model_activity_traces ORDER BY run_id, activity_id, attempt").all();
      traces = rows.map((row) => JSON.parse(String((row as { trace_json: unknown }).trace_json)) as ModelActivityTraceRecord);
    } finally { database.close(); }
    const selected = traces.filter((trace) => (query.runIds === undefined || query.runIds.includes(trace.runId))
      && (query.outcomes === undefined || query.outcomes.includes(trace.outcome)));
    guardAggregation(selected, query.groupBy);
    const groups = new Map<string, ModelActivityTraceRecord[]>();
    for (const trace of selected) {
      const key = query.groupBy.map((dimension) => identity(dimension, trace)).join("\u001f");
      const values = groups.get(key) ?? []; values.push(trace); groups.set(key, values);
    }
    return Object.freeze([...groups.entries()].map(([key, values]) => aggregate(query.groupBy, key, values))
      .sort((left, right) => JSON.stringify(left.group).localeCompare(JSON.stringify(right.group))));
  }
}

function guardAggregation(traces: readonly ModelActivityTraceRecord[], groupBy: readonly IdentityDimension[]): void {
  for (const dimension of ["model", "harness", "protocol"] as const) {
    if (groupBy.includes(dimension)) continue;
    const identities = [...new Set(traces.map((trace) => identity(dimension, trace)))];
    if (identities.length > 1) throw new IncomparableIdentityError(dimension, Object.freeze(identities.sort()));
  }
}
function aggregate(dimensions: readonly IdentityDimension[], key: string, traces: readonly ModelActivityTraceRecord[]): MetricRow {
  const keyParts = key.split("\u001f");
  const group = Object.fromEntries(dimensions.map((dimension, index) => [dimension, keyParts[index]]));
  const cacheValues = traces.flatMap(({ cacheHitRate }) => cacheHitRate === null ? [] : [cacheHitRate]);
  const allCostsKnown = traces.every(({ costUsd }) => costUsd !== null);
  return Object.freeze({
    group: Object.freeze(group), activityCount: traces.length,
    successCount: countOutcome(traces, "success"), refusalCount: countOutcome(traces, "refusal"),
    errorCount: countOutcome(traces, "error"), cancelledCount: countOutcome(traces, "cancelled"),
    cacheHitRate: cacheValues.length === 0 ? null : round(cacheValues.reduce((sum, value) => sum + value, 0) / cacheValues.length),
    repairCount: sum(traces.map(({ repairCount }) => repairCount)),
    toolCallCount: sum(traces.map(({ toolCallCount }) => toolCallCount)),
    toolCallErrors: sum(traces.map(({ toolCallErrors }) => toolCallErrors)),
    costUsd: allCostsKnown ? round(sum(traces.map(({ costUsd }) => costUsd ?? 0))) : null,
  });
}
function identity(dimension: IdentityDimension, trace: ModelActivityTraceRecord): string {
  if (dimension === "model") return modelIdentity(trace);
  if (dimension === "harness") return harnessIdentity(trace);
  return protocolIdentity(trace);
}
function validateGroupBy(values: readonly IdentityDimension[]): void {
  if (new Set(values).size !== values.length) throw new Error("DUPLICATE_METRIC_GROUP_DIMENSION");
}
function countOutcome(traces: readonly ModelActivityTraceRecord[], outcome: TraceOutcome): number { return traces.filter((trace) => trace.outcome === outcome).length; }
function sum(values: readonly number[]): number { return values.reduce((total, value) => total + value, 0); }
function round(value: number): number { return Math.round(value * 1_000_000) / 1_000_000; }
