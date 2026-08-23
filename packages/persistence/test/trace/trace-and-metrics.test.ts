import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { rebuildIndex } from "../../src/index-db/rebuild.js";
import { IncomparableIdentityError, MetricStore } from "../../src/metrics/query.js";
import { loadActivityTraces, TraceRecorder, type ModelActivityTraceRecord, type TraceOutcome } from "../../src/trace.js";

const temporaryRoots: string[] = [];
afterEach(async () => {
  for (const path of temporaryRoots.splice(0)) {
    const resolvedPath = resolve(path); const resolvedTemp = resolve(tmpdir());
    if (!resolvedPath.startsWith(`${resolvedTemp}${sep}`)) throw new Error("UNSAFE_TEST_CLEANUP_PATH");
    await rm(resolvedPath, { recursive: true, force: true });
  }
});

describe("model activity traces and derived metrics", () => {
  it("records one exhaustive terminal trace for each outcome and keeps refusals separate", async () => {
    const root = await temporaryRoot(); const recorder = new TraceRecorder(root);
    for (const [index, outcome] of (["success", "refusal", "error", "cancelled"] as const).entries()) {
      await recorder.recordEvent({ type: "model_activity_terminal", trace: trace(`activity-${index}`, outcome) });
    }
    const traces = await loadActivityTraces(root, "run-1");
    expect(traces).toHaveLength(4);
    expect(traces.map(({ outcome }) => outcome)).toEqual(["success", "refusal", "error", "cancelled"]);
    expect(traces.find(({ outcome }) => outcome === "refusal")).toMatchObject({ refusal: "policy refusal", error: null });
    expect(traces.find(({ outcome }) => outcome === "error")).toMatchObject({ refusal: null, error: { code: "HTTP" } });
    expect(Object.keys(traces[0] ?? {})).toHaveLength(34);
  });

  it("rebuilds an identical query index after index.db is deleted", async () => {
    const root = await temporaryRoot(); const recorder = new TraceRecorder(root);
    await recorder.record(trace("a", "success"));
    await recorder.record(trace("b", "refusal"));
    expect(await rebuildIndex(root)).toMatchObject({ traceCount: 2, runCount: 1 });
    const before = new MetricStore(root).query({ groupBy: [] });
    await rm(join(root, "index.db"), { force: true });
    expect(await loadActivityTraces(root, "run-1")).toHaveLength(2);
    await rebuildIndex(root);
    const after = new MetricStore(root).query({ groupBy: [] });
    expect(after).toEqual(before);
    expect(after[0]).toMatchObject({ activityCount: 2, successCount: 1, refusalCount: 1,
      errorCount: 0, repairCount: 2, toolCallCount: 4, toolCallErrors: 2, cacheHitRate: 0.25 });
  });

  it("refuses aggregation across protocol hashes unless protocol is a grouping key", async () => {
    const root = await temporaryRoot(); const recorder = new TraceRecorder(root);
    await recorder.record(trace("a", "success"));
    await recorder.record({ ...trace("b", "success"), protocolHash: "protocol-hash-b" });
    await rebuildIndex(root);
    expect(() => new MetricStore(root).query({ groupBy: [] })).toThrowError(IncomparableIdentityError);
    expect(() => new MetricStore(root).query({ groupBy: [] })).toThrow("INCOMPARABLE_IDENTITY_MIX:protocol");
    expect(new MetricStore(root).query({ groupBy: ["protocol"] })).toHaveLength(2);
  });

  it("queries refusals independently from errors", async () => {
    const root = await temporaryRoot(); const recorder = new TraceRecorder(root);
    await recorder.record(trace("refusal", "refusal"));
    await recorder.record(trace("error", "error"));
    await rebuildIndex(root);
    expect(new MetricStore(root).query({ outcomes: ["refusal"], groupBy: [] })[0]).toMatchObject({
      activityCount: 1, refusalCount: 1, errorCount: 0,
    });
  });
});

async function temporaryRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "arbitra-traces-")); temporaryRoots.push(path); return path;
}

function trace(activityId: string, outcome: TraceOutcome): ModelActivityTraceRecord {
  return {
    schemaVersion: 1, runId: "run-1", nodeId: `node-${activityId}`, activityId, attempt: 1,
    modelId: "model-a", modelProfileVersion: "1", transportId: "fake", transportVersion: "1",
    harnessId: "canonical", harnessVersion: "1", harnessPolicyHash: "harness-policy",
    protocolId: "audit", protocolVersion: "1.0.0", protocolHash: "protocol-hash-a",
    promptHash: "prompt-hash", resolvedProviderConfigHash: "provider-config-hash",
    capability: "balanced", effortRequested: "high", effortResolved: "high",
    inputArtifactRefs: ["artifacts/input.json"], outputArtifactRef: outcome === "success" ? "artifacts/output.json" : null,
    durationMs: 100, tokenUsage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 25, cacheWriteTokens: 0 },
    costUsd: 0.01, cacheHitRate: 0.25, toolCallCount: 2, toolCallErrors: 1, repairCount: 1,
    refusal: outcome === "refusal" ? "policy refusal" : null,
    error: outcome === "error" || outcome === "cancelled" ? { code: outcome === "error" ? "HTTP" : "CANCELLED", message: outcome } : null,
    continuationState: { hash: "continuation-hash", byteLength: 16, scope: "session" },
    advisorTokens: null, outcome,
  };
}
