import type { ModelActivityTraceRecord, TraceOutcome } from "@arbitra/schemas/model-trace.js";

const OUTCOMES: readonly TraceOutcome[] = ["success", "success", "success", "refusal", "error", "cancelled"];

/** A deterministic, varied trace for position `index`; field spreads exercise every browser filter. */
export function syntheticTrace(runId: string, index: number): ModelActivityTraceRecord {
  const outcome = OUTCOMES[(index * 7) % OUTCOMES.length] ?? "success";
  const node = ["audit", "critic", "planner", "review/α", "tests"][index % 5] ?? "audit";
  return {
    schemaVersion: 1, runId, nodeId: node, activityId: `${node}/batch-${index % 37}/turn/${index % 4}`, attempt: 1 + (index % 3),
    modelId: ["model-a", "model-b", "model-c"][(index >> 1) % 3] ?? "model-a", modelProfileVersion: "profile-1",
    transportId: "openai-responses", transportVersion: "1.0.0", harnessId: "canonical", harnessVersion: "1.0.0", harnessPolicyHash: "policy-1",
    protocolId: ["production-audit", "plan-critic"][(index >> 2) % 2] ?? "production-audit", protocolVersion: "1.0.0",
    protocolHash: "protocol-1", promptHash: `prompt-${index % 11}`, resolvedProviderConfigHash: "provider-1",
    capability: "balanced", effortRequested: "high", effortResolved: index % 9 === 0 ? null : "medium",
    inputArtifactRefs: [`artifacts/input-${index % 13}.json`], outputArtifactRef: outcome === "success" ? `artifacts/output-${index}.json` : null,
    durationMs: 10 + (index % 50), tokenUsage: index % 10 === 0 ? null : { inputTokens: 100 + index % 17, outputTokens: 20, cacheReadTokens: null, cacheWriteTokens: 0 },
    costUsd: index % 4 === 0 ? null : 0.001, cacheHitRate: null, toolCallCount: index % 3, toolCallErrors: 0, repairCount: 0,
    refusal: outcome === "refusal" ? "policy refusal" : null,
    error: outcome === "error" || outcome === "cancelled" ? { code: outcome === "error" ? "TIMEOUT" : "CANCELLED", message: outcome } : null,
    continuationState: null, advisorTokens: null, outcome,
  };
}

/** Filter/pagination combinations covering each filter alone, composed filters, deep and out-of-range offsets. */
export function browserQueries(total: number): readonly Record<string, string | number>[] {
  const filters: Record<string, string>[] = [{}, { nodeId: "critic" }, { nodeId: "review/α" }, { modelId: "model-b" }, { protocolId: "plan-critic" },
    { outcome: "refusal" }, { outcome: "cancelled" }, { activity: "turn/2" }, { activity: "batch-3" }, { activity: "absent" },
    { nodeId: "audit", outcome: "success", modelId: "model-a" }, { protocolId: "production-audit", activity: "/turn/", outcome: "error" },
    { nodeId: "missing" }];
  const pages = [{}, { limit: 1 }, { limit: 7, offset: 3 }, { limit: 100 }, { offset: Math.max(0, total - 2), limit: 5 }, { offset: total + 10 }];
  return filters.flatMap((filter) => pages.map((page) => ({ ...filter, ...page })));
}
