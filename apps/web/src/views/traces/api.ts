import type { TraceArtifact, TraceEntry, TracePage } from "@arbitra/schemas/trace-browser.js";
export type TraceFilters = Partial<Record<"nodeId" | "modelId" | "protocolId" | "outcome" | "activity", string>>;
export class TraceApi {
  constructor(private readonly baseUrl = "") {}
  async list(runId: string, filters: TraceFilters, offset = 0): Promise<TracePage> {
    const query = new URLSearchParams({ offset: String(offset), limit: "25" });
    for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
    return this.request(`/runs/${encodeURIComponent(runId)}/traces?${query.toString()}`);
  }
  async detail(runId: string, traceId: string): Promise<TraceEntry> {
    return this.request(`/runs/${encodeURIComponent(runId)}/traces/${encodeURIComponent(traceId)}`);
  }
  async artifact(runId: string, traceId: string, slot: string): Promise<TraceArtifact> {
    return this.request(`/runs/${encodeURIComponent(runId)}/traces/${encodeURIComponent(traceId)}/artifacts/${encodeURIComponent(slot)}`);
  }
  private async request<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`);
    if (!response.ok) throw new Error(`TRACE_API_${response.status}`);
    return await response.json() as T;
  }
}
