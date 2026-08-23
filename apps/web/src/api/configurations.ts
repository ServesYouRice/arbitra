export interface ConfigurationSummary { readonly id: string; readonly name: string }
export interface StoredConfiguration<T> { readonly id: string; readonly name: string; readonly config: T }
export class ConfigurationApi {
  constructor(private readonly baseUrl = "") {}
  list(): Promise<readonly ConfigurationSummary[]> { return this.request("/configurations"); }
  load<T>(id: string): Promise<StoredConfiguration<T>> { return this.request(`/configurations/${encodeURIComponent(id)}`); }
  save<T>(name: string, config: T): Promise<StoredConfiguration<T>> { return this.request("/configurations", { method: "POST", body: JSON.stringify({ name, config }) }); }
  update<T>(id: string, name: string, config: T): Promise<StoredConfiguration<T>> { return this.request(`/configurations/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ name, config }) }); }
  duplicate<T>(id: string, name: string): Promise<StoredConfiguration<T>> { return this.request(`/configurations/${encodeURIComponent(id)}/duplicate`, { method: "POST", body: JSON.stringify({ name }) }); }
  validate<T>(config: T): Promise<{ readonly valid: boolean; readonly errors?: readonly string[] }> { return this.request("/configurations/validate", { method: "POST", body: JSON.stringify(config) }); }
  export<T>(id: string): Promise<T> { return this.request(`/configurations/${encodeURIComponent(id)}/export`); }
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> { const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", ...init.headers } }); if (!response.ok) throw new Error(`CONFIGURATION_API_${response.status}`); return await response.json() as T; }
}
export function useConfigurations(api: ConfigurationApi): { readonly configurations: readonly ConfigurationSummary[]; readonly loading: boolean; readonly error: string | null; readonly reload: () => Promise<void> } { const [configurations, setConfigurations] = useState<readonly ConfigurationSummary[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState<string | null>(null); const reload = useCallback(async () => { setLoading(true); try { setConfigurations(await api.list()); setError(null); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setLoading(false); } }, [api]); useEffect(() => { void reload(); }, [reload]); return { configurations, loading, error, reload }; }
import { useCallback, useEffect, useState } from "react";
