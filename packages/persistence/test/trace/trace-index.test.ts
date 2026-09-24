import { appendFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "../../src/canonical-json.js";
import { queryTraceIndex, readIndexedTrace, rebuildTraceIndex, traceIndexPath } from "../../src/trace-index.js";
import { loadActivityTraces, TraceRecorder, type ModelActivityTraceRecord } from "../../src/trace.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("persistent trace query index", () => {
  it("indexes only committed lines, keeps journal positions and reads a page without rescanning the log", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbitra-trace-index-")); roots.push(root);
    // The recorder creates the log; bulk history is appended directly to avoid 400 fsyncs.
    await new TraceRecorder(root).record(trace(0));
    const log = join(root, "run-1", "metrics", "model-activity.jsonl");
    await appendFile(log, Array.from({ length: 399 }, (_, index) => `${canonicalJson(trace(index + 1))}\n`).join(""));
    await appendFile(log, '{"schemaVersion":1,"torn');

    let bytes = 0; const observer = { logBytesRead: (count: number) => { bytes += count; } };
    const page = await queryTraceIndex(root, "run-1", { nodeId: "node-b" }, 10, 3, { observer });
    const journal = await loadActivityTraces(root, "run-1");
    const expected = journal.map((value, traceId) => ({ traceId, trace: value })).filter(({ trace: value }) => value.nodeId === "node-b");
    expect(page).toEqual({ entries: expected.slice(10, 13), total: expected.length, facets: { nodeIds: ["node-a", "node-b"], modelIds: ["model-a"], protocolIds: ["audit"] } });
    expect(await readIndexedTrace(root, "run-1", 400)).toBeUndefined();
    expect(await readIndexedTrace(root, "run-1", 399)).toEqual({ traceId: 399, trace: journal[399] });

    bytes = 0;
    await queryTraceIndex(root, "run-1", {}, 200, 3, { observer });
    // Two prefix anchors plus three served lines, independent of history length.
    const lineBytes = (await stat(log)).size / 400;
    expect(bytes).toBeLessThan(lineBytes * 8);

    expect(await rebuildTraceIndex(root, "run-1")).toMatchObject({ traceCount: 400 });
    expect((await stat(traceIndexPath(root, "run-1"))).size).toBeGreaterThan(0);
  });
});

function trace(index: number): ModelActivityTraceRecord {
  return {
    schemaVersion: 1, runId: "run-1", nodeId: index % 2 === 0 ? "node-a" : "node-b", activityId: `activity-${index}`, attempt: 1,
    modelId: "model-a", modelProfileVersion: "1", transportId: "fake", transportVersion: "1",
    harnessId: "canonical", harnessVersion: "1", harnessPolicyHash: "harness-policy",
    protocolId: "audit", protocolVersion: "1.0.0", protocolHash: "protocol-hash-a",
    promptHash: "prompt-hash", resolvedProviderConfigHash: "provider-config-hash",
    capability: "balanced", effortRequested: "high", effortResolved: "high",
    inputArtifactRefs: ["artifacts/input.json"], outputArtifactRef: "artifacts/output.json",
    durationMs: 100, tokenUsage: null, costUsd: null, cacheHitRate: null, toolCallCount: 0, toolCallErrors: 0, repairCount: 0,
    refusal: null, error: null, continuationState: null, advisorTokens: null, outcome: "success",
  };
}
