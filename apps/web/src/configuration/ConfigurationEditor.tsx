import { useMemo, useState, type ReactElement } from "react";
import { ConfigurationApi, type StoredConfiguration } from "../api/configurations.js";
import { JSON_FALLBACK_FIELDS, configurationCoverage } from "./coverage.js";

type JsonObject = Record<string, unknown>;
export interface ConfigurationEditorProps { readonly api: ConfigurationApi; readonly initialName: string; readonly initialValue: JsonObject; readonly configurationId?: string; readonly onChange?: (value: JsonObject) => void; readonly onSaved?: (value: StoredConfiguration<JsonObject>) => void }
export function ConfigurationEditor({ api, initialName, initialValue, configurationId, onChange, onSaved }: ConfigurationEditorProps): ReactElement {
  const [name, setName] = useState(initialName); const [value, setValue] = useState<JsonObject>(initialValue); const [fallback, setFallback] = useState(() => JSON.stringify(fallbackValue(initialValue), null, 2)); const [status, setStatus] = useState("unvalidated");
  const [models, setModels] = useState(() => JSON.stringify(initialValue.models ?? {}, null, 2));
  const coverage = useMemo(configurationCoverage, []);
  const scope = (value.scope as JsonObject | undefined) ?? { kind: "repository" };
  const updateScope = (field: string, next: unknown): void => update("scope", { ...scope, [field]: next });
  const update = (field: string, next: unknown): void => { const changed = { ...value, [field]: next }; setValue(changed); onChange?.(changed); setStatus("unvalidated"); };
  const draft = (): JsonObject => {
    const parsedFallback: unknown = JSON.parse(fallback);
    const parsedModels: unknown = JSON.parse(models);
    if (typeof parsedFallback !== "object" || parsedFallback === null || Array.isArray(parsedFallback)) throw new Error("fallback must be a JSON object");
    if (typeof parsedModels !== "object" || parsedModels === null || Array.isArray(parsedModels)) throw new Error("models must be a JSON object");
    const allowed: readonly string[] = JSON_FALLBACK_FIELDS;
    if (Object.keys(parsedFallback).some((key) => !allowed.includes(key))) throw new Error("fallback contains a field with a dedicated control");
    return { ...value, ...parsedFallback, models: parsedModels };
  };
  const applyFallback = (): boolean => {
    try {
      const changed = draft(); setValue(changed); onChange?.(changed); setStatus("unvalidated"); return true;
    } catch (cause) { setStatus(`invalid JSON fallback: ${cause instanceof Error ? cause.message : String(cause)}`); return false; }
  };
  const validate = async (): Promise<JsonObject | null> => { try { const candidate = draft(); const result = await api.validate(candidate); setStatus(result.valid ? "valid" : `invalid: ${(result.errors ?? []).join(", ")}`); return result.valid ? candidate : null; } catch (cause) { setStatus(cause instanceof Error ? cause.message : String(cause)); return null; } };
  const save = async (): Promise<void> => {
    const candidate = await validate();
    if (candidate === null) return;
    try { const saved = configurationId === undefined ? await api.save(name, candidate) : await api.update(configurationId, name, candidate); setStatus("saved"); onSaved?.(saved); }
    catch (cause) { setStatus(cause instanceof Error ? cause.message : String(cause)); }
  };
  const duplicate = async (): Promise<void> => {
    if (configurationId === undefined) return;
    try { const saved = await api.duplicate<JsonObject>(configurationId, `${name} copy`); setStatus("duplicated"); onSaved?.(saved); }
    catch (cause) { setStatus(cause instanceof Error ? cause.message : String(cause)); }
  };
  const exportConfiguration = async (): Promise<void> => {
    if (configurationId === undefined) return;
    try { setStatus(JSON.stringify(await api.export(configurationId), null, 2)); }
    catch (cause) { setStatus(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <section aria-labelledby="configuration-title"><h2 className="panel-title" id="configuration-title">configuration</h2>
    <label>name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
    <label>mode<select value={String(value.mode ?? "audit")} onChange={(event) => update("mode", event.target.value)}><option value="audit">audit</option><option value="feature">feature</option><option value="testing">testing</option></select></label>
    <label>scope kind<select value={String(scope.kind ?? "repository")} onChange={(event) => update("scope", { kind: event.target.value })}><option value="repository">repository</option><option value="module">module</option><option value="diff">diff</option></select></label>
    {scope.kind !== "module" ? null : <label>modules (one path per line)<textarea value={Array.isArray(scope.modules) ? scope.modules.join("\n") : ""} onChange={(event) => updateScope("modules", event.target.value.split("\n"))} /></label>}
    {scope.kind !== "diff" ? null : <>
      <label>diff mode<select value={String(scope.diffMode ?? "range")} onChange={(event) => update("scope", { kind: "diff", diffMode: event.target.value })}><option value="range">revision range</option><option value="staged">staged</option><option value="working_tree">working tree</option></select></label>
      {(scope.diffMode ?? "range") !== "range" ? null : <>
        <label>base revision<input value={String(scope.base ?? "")} onChange={(event) => update("scope", { kind: "diff", diffMode: "range", head: scope.head ?? "HEAD", base: event.target.value })} /></label>
        <label>head revision<input value={String(scope.head ?? "HEAD")} onChange={(event) => update("scope", { kind: "diff", diffMode: "range", base: scope.base ?? "", head: event.target.value })} /></label>
        <label>revision range (overrides base/head)<input value={String(scope.revisionRange ?? "")} onChange={(event) => updateScope("revisionRange", event.target.value || undefined)} /></label>
      </>}
    </>}
    <label>audit depth<select value={String(value.auditDepth ?? "balanced")} onChange={(event) => update("auditDepth", event.target.value)}><option value="fast">fast</option><option value="balanced">balanced</option><option value="deep">deep</option></select></label>
    <label>consensus<select value={String(value.consensusPolicy ?? "risk_weighted")} onChange={(event) => update("consensusPolicy", event.target.value)}><option value="full">full</option><option value="risk_weighted">risk weighted</option><option value="minimal">minimal</option></select></label>
    <label>maximum rounds<input min="0" max="3" type="number" value={Number(value.maxConsensusRounds ?? 1)} onChange={(event) => update("maxConsensusRounds", Number(event.target.value))} /></label>
    <label>harness mode<select value={String((value.harness as JsonObject | undefined)?.mode ?? "canonical")} onChange={(event) => update("harness", { ...(value.harness as JsonObject | undefined), mode: event.target.value })}><option value="canonical">canonical</option><option value="native">native</option></select></label>
    <label>models JSON<textarea value={models} onChange={(event) => { setModels(event.target.value); setStatus("unvalidated"); }} onBlur={applyFallback} /></label>
    <label>validated JSON fallback ({JSON_FALLBACK_FIELDS.join(", ")})<textarea aria-label="validated JSON fallback" value={fallback} onChange={(event) => setFallback(event.target.value)} onBlur={applyFallback} /></label>
    <p className="state" data-state={coverage.missing.length === 0 ? "verified" : "degraded"}>schema coverage: {coverage.missing.length === 0 ? "complete" : `missing ${coverage.missing.join(", ")}`}</p>
    <p role="status">{status}</p><div className="configuration-actions"><button type="button" onClick={() => { void validate(); }}>validate</button><button type="button" onClick={() => { void save(); }}>save</button>{configurationId === undefined ? null : <><button type="button" onClick={() => { void duplicate(); }}>duplicate</button><button type="button" onClick={() => { void exportConfiguration(); }}>export</button></>}</div>
  </section>;
}
function fallbackValue(value: JsonObject): JsonObject { return Object.fromEntries(JSON_FALLBACK_FIELDS.map((field) => [field, value[field] ?? {}])); }
