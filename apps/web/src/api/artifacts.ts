import { useEffect, useState } from "react";
import { failureText } from "./runs.js";

export interface ArtifactDescriptor { readonly artifactId: string; readonly kind: string; readonly mediaType: string; readonly bytes: number; readonly redacted: true; readonly nodeId?: string | null }
export interface ArtifactResource extends ArtifactDescriptor { readonly content: string; readonly truncated: boolean; readonly continuationArtifactId: string | null }

/**
 * Persisted run artifacts. An artifact ID ends in its content hash, so a loaded artifact
 * never changes and views that read the same one share a single request; the most recently
 * read artifacts are kept, up to a bound. The list is read fresh, since a running run keeps
 * adding to it; views that ask for it for the same run event (the same `refreshKey`) share
 * one request, and a later event always starts a new one.
 */
export const ARTIFACT_CACHE_LIMIT = 200;
export class ArtifactApi {
  readonly #loads = new Map<string, Promise<ArtifactResource>>();
  readonly #lists = new Map<string, Promise<readonly ArtifactDescriptor[]>>();
  constructor(private readonly baseUrl = "") {}
  list(runId: string, refreshKey: unknown = null): Promise<readonly ArtifactDescriptor[]> {
    const key = `${runId}\u0000${String(refreshKey)}`;
    const pending = this.#lists.get(key);
    if (pending !== undefined) return pending;
    const request = this.request<readonly ArtifactDescriptor[]>(`/runs/${encodeURIComponent(runId)}/artifacts`);
    this.#lists.set(key, request);
    void request.then(() => this.#lists.delete(key), () => this.#lists.delete(key));
    return request;
  }
  load(runId: string, artifactId: string): Promise<ArtifactResource> {
    const key = `${runId}\u0000${artifactId}`;
    const cached = this.#loads.get(key);
    if (cached !== undefined) { this.#loads.delete(key); this.#loads.set(key, cached); return cached; }
    const pending = this.request<ArtifactResource>(`/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`);
    this.#loads.set(key, pending);
    for (const oldest of this.#loads.keys()) { if (this.#loads.size <= ARTIFACT_CACHE_LIMIT) break; this.#loads.delete(oldest); }
    pending.catch(() => this.#loads.delete(key));
    return pending;
  }
  private async request<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`);
    if (!response.ok) throw new Error(await failureText(response, `ARTIFACT_API_${response.status}`));
    return await response.json() as T;
  }
}

export function useArtifacts(api: ArtifactApi, runId: string | null, refreshKey: unknown = null): readonly ArtifactDescriptor[] {
  const [result, setResult] = useState<{ runId: string | null; artifacts: readonly ArtifactDescriptor[] }>({ runId: null, artifacts: [] });
  useEffect(() => {
    if (runId === null) return;
    let active = true;
    void api.list(runId, refreshKey).then((artifacts) => { if (active) setResult({ runId, artifacts }); }, () => { if (active) setResult({ runId, artifacts: [] }); });
    return () => { active = false; };
  }, [api, runId, refreshKey]);
  return result.runId === runId ? result.artifacts : [];
}
