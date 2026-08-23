import { useMemo, useState, type ReactElement } from "react";
import { ConfigurationApi } from "../api/configurations.js";
import { JSON_FALLBACK_FIELDS, configurationCoverage } from "./coverage.js";

type JsonObject = Record<string, unknown>;
export interface ConfigurationEditorProps { readonly api: ConfigurationApi; readonly initialName: string; readonly initialValue: JsonObject; readonly configurationId?: string; readonly onChange?: (value: JsonObject) => void }
export function ConfigurationEditor({ api, initialName, initialValue, configurationId, onChange }: ConfigurationEditorProps): ReactElement {
  const [name, setName] = useState(initialName); const [value, setValue] = useState<JsonObject>(initialValue); const [fallback, setFallback] = useState(() => JSON.stringify(fallbackValue(initialValue), null, 2)); const [status, setStatus] = useState("unvalidated");
  const coverage = useMemo(configurationCoverage, []);
  const update = (field: string, next: unknown): void => { const changed = { ...value, [field]: next }; setValue(changed); onChange?.(changed); setStatus("unvalidated"); };
  const applyFallback = (): void => { const parsed = JSON.parse(fallback) as JsonObject; const changed = { ...value, ...parsed }; setValue(changed); onChange?.(changed); setStatus("unvalidated"); };
  const validate = async (): Promise<void> => { const result = await api.validate(value); setStatus(result.valid ? "valid" : `invalid: ${(result.errors ?? []).join(", ")}`); };
  const save = async (): Promise<void> => { await validate(); if (configurationId === undefined) await api.save(name, value); else await api.update(configurationId, name, value); setStatus("saved"); };
  return <section aria-labelledby="configuration-title"><h2 className="panel-title" id="configuration-title">configuration</h2>
    <label>name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
    <label>mode<select value={String(value.mode ?? "audit")} onChange={(event) => update("mode", event.target.value)}><option value="audit">audit</option><option value="feature">feature</option><option value="testing">testing</option></select></label>
    <label>scope kind<select value={String((value.scope as JsonObject | undefined)?.kind ?? "repository")} onChange={(event) => update("scope", { ...(value.scope as JsonObject | undefined), kind: event.target.value })}><option value="repository">repository</option><option value="module">module</option><option value="diff">diff</option></select></label>
    <label>audit depth<select value={String(value.auditDepth ?? "balanced")} onChange={(event) => update("auditDepth", event.target.value)}><option value="fast">fast</option><option value="balanced">balanced</option><option value="deep">deep</option></select></label>
    <label>consensus<select value={String(value.consensusPolicy ?? "risk_weighted")} onChange={(event) => update("consensusPolicy", event.target.value)}><option value="full">full</option><option value="risk_weighted">risk weighted</option><option value="minimal">minimal</option></select></label>
    <label>maximum rounds<input min="0" max="3" type="number" value={Number(value.maxConsensusRounds ?? 0)} onChange={(event) => update("maxConsensusRounds", Number(event.target.value))} /></label>
    <label>harness mode<select value={String((value.harness as JsonObject | undefined)?.mode ?? "canonical")} onChange={(event) => update("harness", { ...(value.harness as JsonObject | undefined), mode: event.target.value })}><option value="canonical">canonical</option><option value="native">native</option></select></label>
    <label>models JSON<textarea value={JSON.stringify(value.models ?? {}, null, 2)} onChange={(event) => { try { update("models", JSON.parse(event.target.value) as unknown); } catch { setStatus("invalid models JSON"); } }} /></label>
    <label>validated JSON fallback ({JSON_FALLBACK_FIELDS.join(", ")})<textarea aria-label="validated JSON fallback" value={fallback} onChange={(event) => setFallback(event.target.value)} onBlur={applyFallback} /></label>
    <p className="state" data-state={coverage.missing.length === 0 ? "verified" : "degraded"}>schema coverage: {coverage.missing.length === 0 ? "complete" : `missing ${coverage.missing.join(", ")}`}</p>
    <p role="status">{status}</p><div className="configuration-actions"><button type="button" onClick={validate}>validate</button><button type="button" onClick={save}>save</button>{configurationId === undefined ? null : <><button type="button" onClick={() => api.duplicate(configurationId, `${name} copy`)}>duplicate</button><button type="button" onClick={() => api.export(configurationId)}>export</button></>}</div>
  </section>;
}
function fallbackValue(value: JsonObject): JsonObject { return Object.fromEntries(JSON_FALLBACK_FIELDS.map((field) => [field, value[field] ?? {}])); }

