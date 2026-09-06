import { useEffect, useState } from "react";
export interface ArtifactDescriptor { readonly artifactId: string; readonly kind: string; readonly mediaType: string; readonly bytes: number; readonly redacted: true; readonly nodeId?: string | null }
export interface ArtifactResource extends ArtifactDescriptor { readonly content: string; readonly truncated: boolean; readonly continuationArtifactId: string | null }
export class ArtifactApi { constructor(private readonly baseUrl = "") {} async list(runId: string): Promise<readonly ArtifactDescriptor[]> { return this.request(`/runs/${encodeURIComponent(runId)}/artifacts`); } async load(runId: string, artifactId: string): Promise<ArtifactResource> { return this.request(`/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`); } private async request<T>(path: string): Promise<T> { const response = await fetch(`${this.baseUrl}${path}`); if (!response.ok) throw new Error(`ARTIFACT_API_${response.status}`); return await response.json() as T; } }

export function useArtifacts(api: ArtifactApi, runId: string | null, refreshKey: unknown = null): readonly ArtifactDescriptor[] {
  const [result, setResult] = useState<{ runId: string | null; artifacts: readonly ArtifactDescriptor[] }>({ runId: null, artifacts: [] });
  useEffect(() => {
    if (runId === null) return;
    let active = true;
    void api.list(runId).then((artifacts) => { if (active) setResult({ runId, artifacts }); }, () => { if (active) setResult({ runId, artifacts: [] }); });
    return () => { active = false; };
  }, [api, runId, refreshKey]);
  return result.runId === runId ? result.artifacts : [];
}
