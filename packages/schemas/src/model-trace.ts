export type TraceOutcome = "success" | "refusal" | "error" | "cancelled";
export interface ModelActivityTraceRecord {
  readonly schemaVersion: 1;
  readonly runId: string; readonly nodeId: string; readonly activityId: string; readonly attempt: number;
  readonly modelId: string; readonly modelProfileVersion: string;
  readonly transportId: string; readonly transportVersion: string;
  readonly harnessId: string; readonly harnessVersion: string; readonly harnessPolicyHash: string;
  readonly protocolId: string; readonly protocolVersion: string; readonly protocolHash: string;
  readonly promptHash: string; readonly resolvedProviderConfigHash: string;
  readonly capability: "frontier" | "balanced" | "fast";
  readonly effortRequested: "low" | "medium" | "high" | "xhigh" | null;
  readonly effortResolved: "low" | "medium" | "high" | "xhigh" | null;
  readonly inputArtifactRefs: readonly string[]; readonly outputArtifactRef: string | null;
  readonly durationMs: number;
  readonly tokenUsage: { readonly inputTokens: number | null; readonly outputTokens: number | null;
    readonly cacheReadTokens: number | null; readonly cacheWriteTokens: number | null } | null;
  readonly costUsd: number | null; readonly cacheHitRate: number | null;
  readonly toolCallCount: number; readonly toolCallErrors: number; readonly repairCount: number;
  readonly refusal: string | null; readonly error: { readonly code: string; readonly message: string } | null;
  readonly continuationState: { readonly hash: string; readonly byteLength: number; readonly scope: "session" } | null;
  readonly advisorTokens: number | null; readonly outcome: TraceOutcome;
}
