import { queryTraceIndex, readIndexedTrace, type TraceIndexOptions } from "@arbitra/persistence/trace-index.js";
import { traceQuerySchema, type TracePage, type TraceEntry } from "@arbitra/schemas/trace-browser.js";
import type { ModelActivityTraceRecord } from "@arbitra/schemas/model-trace.js";

/**
 * Full-scan reference implementation over an already-loaded log. The HTTP routes use the
 * indexed variants below; this stays as the oracle the differential tests compare against.
 * IDs are positions in the committed append-only trace log, never filtered row indices.
 */
export function tracePage(traces: readonly ModelActivityTraceRecord[], query: unknown): TracePage {
  const filter = traceQuerySchema.parse(query);
  const entries = traces.map((trace, index) => ({ traceId: String(index), trace })).filter(({ trace }) =>
    (filter.nodeId === undefined || trace.nodeId === filter.nodeId)
    && (filter.modelId === undefined || trace.modelId === filter.modelId)
    && (filter.protocolId === undefined || trace.protocolId === filter.protocolId)
    && (filter.outcome === undefined || trace.outcome === filter.outcome)
    && (filter.activity === undefined || trace.activityId.includes(filter.activity)));
  const end = filter.offset + filter.limit;
  const values = (key: "nodeId" | "modelId" | "protocolId") => [...new Set(traces.map((trace) => trace[key]))].sort();
  return { entries: entries.slice(filter.offset, end), total: entries.length, offset: filter.offset,
    nextOffset: end < entries.length ? end : null,
    facets: { nodeIds: values("nodeId"), modelIds: values("modelId"), protocolIds: values("protocolId") } };
}

export function traceEntry(traces: readonly ModelActivityTraceRecord[], traceId: string): TraceEntry {
  const trace = traces[parseTraceId(traceId)];
  if (trace === undefined) throw absent();
  return { traceId, trace };
}

/** Same response as `tracePage`, served from the persistent per-run index instead of a full log read. */
export async function indexedTracePage(runsDirectory: string, runId: string, query: unknown, options?: TraceIndexOptions): Promise<TracePage> {
  const { offset, limit, ...filter } = traceQuerySchema.parse(query);
  const page = await queryTraceIndex(runsDirectory, runId, filter, offset, limit, options);
  const end = offset + limit;
  return { entries: page.entries.map(({ traceId, trace }) => ({ traceId: String(traceId), trace })), total: page.total, offset,
    nextOffset: end < page.total ? end : null, facets: page.facets };
}

export async function indexedTraceEntry(runsDirectory: string, runId: string, traceId: string, options?: TraceIndexOptions): Promise<TraceEntry> {
  const entry = await readIndexedTrace(runsDirectory, runId, parseTraceId(traceId), options);
  if (entry === undefined) throw absent();
  return { traceId, trace: entry.trace };
}

function parseTraceId(traceId: string): number {
  if (!/^(0|[1-9][0-9]*)$/u.test(traceId) || !Number.isSafeInteger(Number(traceId))) throw Object.assign(new Error("INVALID_TRACE_ID"), { statusCode: 400 });
  return Number(traceId);
}
function absent(): Error { return Object.assign(new Error("TRACE_ABSENT"), { statusCode: 404 }); }
