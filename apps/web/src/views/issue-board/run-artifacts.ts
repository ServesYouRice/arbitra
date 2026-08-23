import { useEffect, useState } from "react";
import type { ArtifactApi } from "../../api/artifacts.js";
export const RUN_ARTIFACT_KINDS = Object.freeze({ canonicalIssues: "canonical-issues", sourceFindings: "source-findings", issueOperations: "issue-operations", verificationResults: "verification-results", plan: "plan-ir", criticFeedback: "critic-feedback" });
export type RunArtifactState = "loading" | "loaded" | "absent" | "error";
export interface RunArtifact<T> { readonly value: T | null; readonly state: RunArtifactState; readonly error: string | null }
export function useRunArtifact<T>(api: ArtifactApi, runId: string | null, kind: string): RunArtifact<T> {
  const [artifact, setArtifact] = useState<RunArtifact<T>>({ value: null, state: "loading", error: null });
  useEffect(() => { if (runId === null) { setArtifact({ value: null, state: "absent", error: null }); return; } let active = true; setArtifact({ value: null, state: "loading", error: null });
    void api.list(runId).then(async (descriptors) => { const descriptor = descriptors.find((item) => item.kind === kind); if (descriptor === undefined) return { value: null, state: "absent" as const, error: null }; const resource = await api.load(runId, descriptor.artifactId); return { value: JSON.parse(resource.content) as T, state: "loaded" as const, error: null }; }).then((next) => { if (active) setArtifact(next); }, (cause: unknown) => { if (active) setArtifact({ value: null, state: "error", error: cause instanceof Error ? cause.message : String(cause) }); });
    return () => { active = false; }; }, [api, runId, kind]);
  return artifact;
}
