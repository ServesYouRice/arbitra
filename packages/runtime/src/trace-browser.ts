import { traceQuerySchema, type TracePage, type TraceEntry } from "@arbitra/schemas/trace-browser.js";
import type { ModelActivityTraceRecord } from "@arbitra/schemas/model-trace.js";

/** IDs are positions in the committed append-only trace log, never filtered row indices. */
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
  if (!/^(0|[1-9][0-9]*)$/u.test(traceId) || !Number.isSafeInteger(Number(traceId))) throw Object.assign(new Error("INVALID_TRACE_ID"), { statusCode: 400 });
  const trace = traces[Number(traceId)];
  if (trace === undefined) throw Object.assign(new Error("TRACE_ABSENT"), { statusCode: 404 });
  return { traceId, trace };
}
