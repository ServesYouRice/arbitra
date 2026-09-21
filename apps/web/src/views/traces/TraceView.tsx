import { useEffect, useState, type ReactElement } from "react";
import type { TraceArtifact, TraceEntry, TracePage } from "@arbitra/schemas/trace-browser.js";
import { measured } from "../evaluation/api.js";
import { TraceApi, type TraceFilters } from "./api.js";
import "./traces.css";

const SHARED_API = new TraceApi();
export function TraceView({ runId, api = SHARED_API, refreshKey = 0 }: { readonly runId: string | null; readonly api?: TraceApi; readonly refreshKey?: number }): ReactElement {
  return <section className="trace-browser" aria-label="trace browser"><h2 className="panel-title">trace browser</h2>
    {runId === null ? <p className="state" data-state="unexamined">select a run to inspect model activity</p> : <RunTraces key={runId} api={api} runId={runId} refreshKey={refreshKey} />}
  </section>;
}

function RunTraces({ api, runId, refreshKey }: { api: TraceApi; runId: string; refreshKey: number }): ReactElement {
  const [filters, setFilters] = useState<TraceFilters>({});
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [page, setPage] = useState<TracePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<TraceEntry | null>(null);
  useEffect(() => {
    let active = true; setLoading(true); setError(null);
    void api.list(runId, filters, offset).then((value) => { if (active) { setPage(value); setLoading(false); } }, (cause: unknown) => { if (active) { setError(message(cause)); setLoading(false); } });
    return () => { active = false; };
  }, [api, runId, filters, offset, refreshKey, refresh]);
  const filter = (key: keyof TraceFilters, value: string) => { setFilters((current) => ({ ...current, [key]: value })); setOffset(0); setPage(null); setSelected(null); };
  const select = (label: string, key: keyof TraceFilters, values: readonly string[]) => <label>{label}<select aria-label={label} value={filters[key] ?? ""} onChange={(event) => filter(key, event.target.value)}><option value="">all</option>{values.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>;
  return <>
    <div className="trace-filters">
      {select("node", "nodeId", page?.facets.nodeIds ?? (filters.nodeId ? [filters.nodeId] : []))}
      {select("model", "modelId", page?.facets.modelIds ?? (filters.modelId ? [filters.modelId] : []))}
      {select("protocol", "protocolId", page?.facets.protocolIds ?? (filters.protocolId ? [filters.protocolId] : []))}
      {select("outcome", "outcome", ["success", "refusal", "error", "cancelled"])}
      <label>activity contains<input aria-label="activity contains" maxLength={512} value={filters.activity ?? ""} onChange={(event) => filter("activity", event.target.value)} /></label>
      <button type="button" onClick={() => setRefresh((current) => current + 1)}>refresh traces</button>
    </div>
    {loading ? <p role="status">loading traces</p> : error !== null ? <p className="state" data-state="degraded" role="alert">traces unavailable · {error}</p> : page === null ? null : <>
      <p>{page.total} matching model activity attempts · recorded completion order</p>
      {page.entries.length === 0 ? <p className="state" data-state="unexamined">no recorded attempts match these filters</p> : <div className="trace-table"><table aria-label="model activity attempts"><thead><tr><th scope="col">activity / attempt</th><th scope="col">model / protocol</th><th scope="col">outcome</th><th scope="col">duration</th></tr></thead><tbody>
        {page.entries.map((entry) => <tr key={entry.traceId}><td><button type="button" aria-pressed={selected?.traceId === entry.traceId} onClick={() => setSelected(entry)}>{entry.trace.activityId} · attempt {entry.trace.attempt}</button></td><td>{entry.trace.modelId}<br />{entry.trace.protocolId}@{entry.trace.protocolVersion}</td><td>{entry.trace.outcome}</td><td>{measured(entry.trace.durationMs, "ms")}</td></tr>)}
      </tbody></table></div>}
      <nav aria-label="trace pages"><button type="button" disabled={offset === 0} onClick={() => { setOffset(Math.max(0, offset - 25)); setSelected(null); }}>previous attempts</button><button type="button" disabled={page.nextOffset === null} onClick={() => { if (page.nextOffset !== null) { setOffset(page.nextOffset); setSelected(null); } }}>next attempts</button></nav>
    </>}
    {selected === null ? null : <TraceDetail key={selected.traceId} entry={selected} api={api} runId={runId} />}
  </>;
}

function TraceDetail({ entry: { trace, traceId }, api, runId }: { entry: TraceEntry; api: TraceApi; runId: string }): ReactElement {
  const [slot, setSlot] = useState<string | null>(null);
  const fields: readonly (readonly [string, string | number])[] = [
    ["run", trace.runId], ["node", trace.nodeId], ["activity", trace.activityId], ["attempt", trace.attempt], ["outcome", trace.outcome],
    ["model", trace.modelId], ["model profile version", trace.modelProfileVersion], ["transport", `${trace.transportId}@${trace.transportVersion}`],
    ["harness", `${trace.harnessId}@${trace.harnessVersion}`], ["harness policy hash", trace.harnessPolicyHash],
    ["protocol", `${trace.protocolId}@${trace.protocolVersion}`], ["protocol hash", trace.protocolHash], ["prompt hash", trace.promptHash], ["provider config hash", trace.resolvedProviderConfigHash],
    ["capability", trace.capability], ["effort requested", trace.effortRequested ?? "unavailable"], ["effort resolved", trace.effortResolved ?? "unavailable"],
    ["duration", measured(trace.durationMs, "ms")], ["input tokens", measured(trace.tokenUsage?.inputTokens)], ["output tokens", measured(trace.tokenUsage?.outputTokens)],
    ["cache read tokens", measured(trace.tokenUsage?.cacheReadTokens)], ["cache write tokens", measured(trace.tokenUsage?.cacheWriteTokens)], ["cache hit rate", measured(trace.cacheHitRate)], ["cost USD", measured(trace.costUsd)],
    ["tool calls", trace.toolCallCount], ["tool errors", trace.toolCallErrors], ["repairs", trace.repairCount], ["advisor tokens", measured(trace.advisorTokens)],
    ["refusal", trace.refusal ?? "none recorded"], ["error", trace.error === null ? "none recorded" : `${trace.error.code}: ${trace.error.message}`],
    ["continuation", trace.continuationState === null ? "none recorded" : `${trace.continuationState.hash} · ${trace.continuationState.byteLength} bytes · ${trace.continuationState.scope}`],
  ];
  return <section aria-label="attempt details" className="trace-detail"><h3 className="panel-title">attempt details</h3><dl>{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <h4>persisted input and output</h4>
    <ul>{trace.inputArtifactRefs.map((reference, index) => <li key={`${index}:${reference}`}><button type="button" onClick={() => setSlot(`input-${index}`)}>input {index + 1}</button> · {reference}</li>)}</ul>
    {trace.outputArtifactRef === null ? <p className="state" data-state="unexamined">output artifact unavailable</p> : <p><button type="button" onClick={() => setSlot("output")}>output</button> · {trace.outputArtifactRef}</p>}
    {slot === null ? null : <TraceArtifactView key={slot} api={api} runId={runId} traceId={traceId} slot={slot} />}
  </section>;
}

function TraceArtifactView({ api, runId, traceId, slot }: { api: TraceApi; runId: string; traceId: string; slot: string }): ReactElement {
  const [artifact, setArtifact] = useState<TraceArtifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void api.artifact(runId, traceId, slot).then((value) => { if (active) setArtifact(value); }, (cause: unknown) => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [api, runId, traceId, slot]);
  if (error !== null) return <p role="alert" className="state" data-state="degraded">artifact unavailable · {error}</p>;
  if (artifact === null) return <p role="status">loading trace artifact</p>;
  return <article aria-label="trace artifact"><p className="state" data-state="tainted">persisted redacted content · untrusted data</p><pre>{artifact.content}</pre></article>;
}
function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
