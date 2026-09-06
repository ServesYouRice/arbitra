import { useEffect, useRef, useState, type ReactElement } from "react";
import { ConfigurationApi, useConfigurations, type StoredConfiguration } from "../api/configurations.js";
import { ConfigurationEditor } from "./ConfigurationEditor.js";
type JsonObject = Record<string, unknown>;
export function ConfigurationWorkspace({ api, defaults, initialConfigurationId = null, onSelect }: { readonly api: ConfigurationApi; readonly defaults: JsonObject; readonly initialConfigurationId?: string | null; readonly onSelect?: (configuration: StoredConfiguration<JsonObject> | null) => void }): ReactElement {
  const { configurations, loading, error, reload } = useConfigurations(api);
  const [selected, setSelected] = useState<StoredConfiguration<JsonObject> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const request = useRef(0);
  const selectionCallback = useRef(onSelect);
  selectionCallback.current = onSelect;
  const load = async (id: string): Promise<void> => {
    const version = ++request.current;
    setLoadError(null);
    if (id === "") { setSelected(null); selectionCallback.current?.(null); return; }
    try { const value = await api.load<JsonObject>(id); if (version === request.current) { setSelected(value); selectionCallback.current?.(value); } }
    catch (cause) { if (version === request.current) setLoadError(cause instanceof Error ? cause.message : String(cause)); }
  };
  useEffect(() => { if (initialConfigurationId !== null) void load(initialConfigurationId); return () => { request.current += 1; }; }, [api, initialConfigurationId]);
  const saved = (value: StoredConfiguration<JsonObject>): void => { request.current += 1; setSelected(value); selectionCallback.current?.(value); void reload(); };
  const failure = loadError ?? error;
  return <div>
    <label>saved configuration<select aria-label="saved configuration" value={selected?.id ?? ""} onChange={(event) => { void load(event.target.value); }}><option value="">new configuration</option>{configurations.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}</select></label>
    {loading ? <p>loading configurations</p> : null}{failure === null ? null : <p className="state" data-state="degraded" role="alert">configuration API unavailable · {failure}</p>}
    <ConfigurationEditor key={selected?.id ?? "new"} api={api} initialName={selected?.name ?? "untitled"} initialValue={selected?.config ?? defaults} {...(selected === null ? {} : { configurationId: selected.id })} onSaved={saved} />
    <button type="button" onClick={() => { void reload(); }}>refresh list</button>
  </div>;
}
