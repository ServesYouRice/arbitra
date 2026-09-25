import { useEffect, useState } from "react";
import type { RunEvent } from "./sse.js";
import type { WorkflowJson } from "../columns/graph/layout.js";

/** A generic human checkpoint; answer its current `version`, then resume the run. */
export interface HumanCheckpointResource { readonly kind: "human"; readonly checkpointId: string; readonly version: string; readonly mode: "interactive" | "automatic"; readonly status: "pending" | "approved" | "rejected"; readonly prompt: string; readonly decisions: readonly ("approve" | "reject")[] }
export interface RequirementsCheckpointResource { readonly kind: "requirements"; readonly artifactId: string; readonly pendingAmbiguityIds: readonly string[] }
export type CheckpointResource = HumanCheckpointResource | RequirementsCheckpointResource;
export interface RunResource { readonly runId: string; readonly state: string; readonly resumable: boolean; readonly checkpoints: readonly CheckpointResource[]; readonly eventsCursor?: string; readonly preservedArtifacts?: number; readonly workflow?: WorkflowJson; /** Present when the run executes a saved operator-authored graph. */ readonly workflowGraph?: { readonly id: string; readonly version: string; readonly executedVersion: string } }
export interface EstimateResource { readonly estimate: unknown; readonly gate: string }
export class RunApi {
  constructor(private readonly baseUrl = "") {}
  selectRepository(path: string): Promise<unknown> { return this.request("/repositories/select", { method: "POST", body: JSON.stringify({ path }) }); }
  estimate(configurationId: string, repository = ""): Promise<EstimateResource> { return this.request("/estimate", { method: "POST", body: JSON.stringify(runBody(configurationId, repository)) }); }
  start(configurationId: string, repository = ""): Promise<RunResource> { return this.request("/runs", { method: "POST", body: JSON.stringify(runBody(configurationId, repository)) }); }
  status(runId: string): Promise<RunResource> { return this.request(`/runs/${encodeURIComponent(runId)}`); }
  resume(runId: string): Promise<RunResource> { return this.request(`/runs/${encodeURIComponent(runId)}/resume`, { method: "POST" }); }
  cancel(runId: string): Promise<RunResource> { return this.request(`/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" }); }
  respondCheckpoint(runId: string, checkpointId: string, version: string, decision: "approve" | "reject"): Promise<{ readonly accepted: true }> { return this.request(`/runs/${encodeURIComponent(runId)}/checkpoints/${encodeURIComponent(checkpointId)}`, { method: "POST", body: JSON.stringify({ version, decision }) }); }
  eventsUrl(runId: string): string { return `${this.baseUrl}/runs/${encodeURIComponent(runId)}/events`; }
  // Bodiless POSTs (resume, cancel) must not declare a JSON body: the server rejects an empty
  // `application/json` body with 400, which the browser QA found silently broke both controls.
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> { const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers: { ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers } }); if (!response.ok) throw new Error(`RUN_API_${response.status}`); return await response.json() as T; }
}
export function useRehydratedRun(api: RunApi, runId: string | null, refreshKey: unknown = null): { readonly resource: RunResource | null; readonly events: readonly RunEvent[]; readonly error: string | null } {
  const [resource, setResource] = useState<RunResource | null>(null);
  const [events, setEvents] = useState<readonly RunEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setResource(null); setEvents([]); setError(null);
    if (runId === null) return;
    let active = true;
    let source: EventSource | null = null;
    let ended = false;
    void api.status(runId).then((initial) => {
      if (!active) return;
      setResource(initial);
      try { source = new EventSource(api.eventsUrl(runId)); }
      catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return; }
      source.onmessage = ({ data }) => {
        if (!active) return;
        try {
          const event: unknown = JSON.parse(data as string);
          if (!isRunEvent(event) || event.runId !== runId) throw new Error("INVALID_RUN_EVENT");
          setError(null);
          setEvents((current) => Object.freeze([...current, event]));
          if (event.t === "run_transition" && event.state !== undefined) {
            const state = event.state;
            setResource((current) => current === null ? current : { ...current, state, resumable: state !== "COMPLETED" });
            // A run that stops (blocked on a checkpoint, finished, failed) has new durable
            // state the event does not carry: its checkpoints and its executed graph.
            if (state !== "CREATED" && state !== "RUNNING") void api.status(runId).then((latest) => { if (active) setResource(latest); }, () => undefined);
          }
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); source?.close(); }
      };
      source.addEventListener?.("end", () => { ended = true; source?.close(); });
      source.onerror = () => { if (active && !ended) { setError("RUN_EVENT_STREAM_UNAVAILABLE"); source?.close(); } };
    }, (cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; source?.close(); };
  }, [api, runId, refreshKey]);
  return { resource, events, error };
}

function runBody(configurationId: string, repository: string): { configurationId: string; repository?: string } {
  return repository.trim() === "" ? { configurationId } : { configurationId, repository };
}
function isRunEvent(value: unknown): value is RunEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (typeof event["t"] !== "string" || typeof event["runId"] !== "string") return false;
  if (event["t"] === "run_transition" && typeof event["state"] !== "string") return false;
  return true;
}
