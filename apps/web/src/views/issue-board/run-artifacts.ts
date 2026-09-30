import { useEffect, useState } from "react";
import type { ArtifactApi } from "../../api/artifacts.js";
export const RUN_ARTIFACT_KINDS = Object.freeze({ canonicalIssues: "canonical-issues", sourceFindings: "source-findings", issueOperations: "issue-operations", verificationResults: "verification-results", plan: "plan-ir", criticFeedback: "critic-feedback" });
export type RunArtifactState = "loading" | "loaded" | "absent" | "error";
export interface RunArtifact<T> { readonly value: T | null; readonly state: RunArtifactState; readonly error: string | null }

/**
 * The latest artifact of one kind in a run. A refresh (a new run event) re-reads it but
 * keeps showing what was loaded until the new read answers, so a live run's views do not
 * flash empty on every event; a different run or kind starts from loading.
 */
export function useRunArtifact<T>(api: ArtifactApi, runId: string | null, kind: string, refreshKey: unknown = null): RunArtifact<T> {
  const key = runId === null ? null : `${runId}\u0000${kind}`;
  const [artifact, setArtifact] = useState<RunArtifact<T> & { readonly key: string | null }>({ key: null, value: null, state: "loading", error: null });
  useEffect(() => {
    if (runId === null) { setArtifact({ key, value: null, state: "absent", error: null }); return; }
    let active = true;
    setArtifact((current) => current.key === key ? current : { key, value: null, state: "loading", error: null });
    void api.list(runId, refreshKey).then(async (descriptors) => {
      const descriptor = descriptors.find((item) => item.kind === kind);
      if (descriptor === undefined) return { key, value: null, state: "absent" as const, error: null };
      const resource = await api.load(runId, descriptor.artifactId);
      return { key, value: JSON.parse(resource.content) as T, state: "loaded" as const, error: null };
    }).then((next) => { if (active) setArtifact(next); }, (cause: unknown) => { if (active) setArtifact({ key, value: null, state: "error", error: cause instanceof Error ? cause.message : String(cause) }); });
    return () => { active = false; };
  }, [api, runId, kind, key, refreshKey]);
  return artifact.key === key ? artifact : { value: null, state: runId === null ? "absent" : "loading", error: null };
}
