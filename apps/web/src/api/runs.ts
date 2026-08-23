export interface CheckpointResource { readonly id: string; readonly stage: string; readonly status: "pending"; readonly prompt: string }
export interface RunResource { readonly runId: string; readonly state: string; readonly resumable: boolean; readonly checkpoints: readonly CheckpointResource[]; readonly eventsCursor?: string; readonly preservedArtifacts?: number }
export interface EstimateResource { readonly estimate: unknown; readonly gate: string }
export class RunApi {
  constructor(private readonly baseUrl = "") {}
  selectRepository(path: string): Promise<unknown> { return this.request("/repositories/select", { method: "POST", body: JSON.stringify({ path }) }); }
  estimate(configurationId: string, repository: string): Promise<EstimateResource> { return this.request("/estimate", { method: "POST", body: JSON.stringify({ configurationId, repository }) }); }
  start(configurationId: string, repository: string): Promise<RunResource> { return this.request("/runs", { method: "POST", body: JSON.stringify({ configurationId, repository }) }); }
  status(runId: string): Promise<RunResource> { return this.request(`/runs/${encodeURIComponent(runId)}`); }
  resume(runId: string): Promise<RunResource> { return this.request(`/runs/${encodeURIComponent(runId)}/resume`, { method: "POST" }); }
  cancel(runId: string): Promise<RunResource> { return this.request(`/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" }); }
  respondCheckpoint(runId: string, checkpointId: string, decision: string): Promise<{ readonly accepted: true }> { return this.request(`/runs/${encodeURIComponent(runId)}/checkpoints/${encodeURIComponent(checkpointId)}`, { method: "POST", body: JSON.stringify({ decision }) }); }
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> { const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", ...init.headers } }); if (!response.ok) throw new Error(`RUN_API_${response.status}`); return await response.json() as T; }
}
export function useRehydratedRun(api: RunApi, runId: string | null): { readonly resource: RunResource | null; readonly events: readonly RunEvent[]; readonly error: string | null } { const [resource, setResource] = useState<RunResource | null>(null); const [events, setEvents] = useState<readonly RunEvent[]>([]); const [error, setError] = useState<string | null>(null); useEffect(() => { if (runId === null) { setResource(null); setEvents([]); return; } let active = true; let source: EventSource | null = null; void api.status(runId).then((initial) => { if (!active) return; setResource(initial); source = new EventSource(`/runs/${encodeURIComponent(runId)}/events`); source.onmessage = ({ data }) => { const event = JSON.parse(data as string) as RunEvent; setEvents((current) => Object.freeze([...current, event])); if (event.t === "run_transition" && event.state !== undefined) setResource((current) => current === null ? current : { ...current, state: event.state! }); }; }, (cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); }); return () => { active = false; source?.close(); }; }, [api, runId]); return { resource, events, error }; }
import { useEffect, useState } from "react";
import type { RunEvent } from "./sse.js";
