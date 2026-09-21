import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Orchestrator } from "@arbitra/runtime/orchestrator.js";
import { RunStore } from "@arbitra/runtime/run-store.js";
import { controlPlaneCore } from "@arbitra/runtime/control-plane-core.js";
import type { ModelActivityTraceRecord } from "@arbitra/schemas/model-trace.js";
import { buildServer } from "../src/main.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "arbitra-traces-")); roots.push(root);
  const orchestrator = new Orchestrator({ repository: root });
  const store = new RunStore(join(root, ".runs", "runs"), "run-1");
  await store.saveContext({ repository: root, repositoryDigest: "a".repeat(64), scope: { kind: "repository" }, consensusPolicy: "full", maximumRounds: 2, criticEnabled: true });
  const input = await store.publish("input", { messages: [{ role: "user", content: "inspect source" }] });
  const output = await store.artifacts.put({ value: { findings: [] } }, "json");
  const trace: ModelActivityTraceRecord = {
    schemaVersion: 1, runId: "run-1", nodeId: "audit", activityId: "audit/a/turn/0", attempt: 1,
    modelId: "model-a", modelProfileVersion: "profile-1", transportId: "openai-responses", transportVersion: "1.0.0",
    harnessId: "canonical", harnessVersion: "1.0.0", harnessPolicyHash: "policy-1",
    protocolId: "production-audit", protocolVersion: "1.0.0", protocolHash: "protocol-1", promptHash: "prompt-1", resolvedProviderConfigHash: "provider-1",
    capability: "balanced", effortRequested: "high", effortResolved: "medium", inputArtifactRefs: [input.ref.relativePath], outputArtifactRef: output.relativePath,
    durationMs: 20, tokenUsage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: null, cacheWriteTokens: null }, costUsd: null, cacheHitRate: null,
    toolCallCount: 0, toolCallErrors: 0, repairCount: 0, refusal: null, error: null, continuationState: null, advisorTokens: null, outcome: "success",
  };
  await store.recordModelTrace(trace);
  await store.recordModelTrace({ ...trace, attempt: 2, outcome: "refusal", refusal: "cannot process this source", outputArtifactRef: null });
  await store.recordModelTrace({ ...trace, nodeId: "critic", activityId: "critic/turn/0", modelId: "model-b", protocolId: "plan-critic", outcome: "error", error: { code: "TIMEOUT", message: "request timed out" }, tokenUsage: null });
  return { app: buildServer(controlPlaneCore(new Orchestrator({ repository: root }))), orchestrator, store, trace, output, root };
}

describe("persisted model trace browser HTTP surface", () => {
  it("paginates committed attempts with stable IDs and composes exact filters after restart", async () => {
    const { app, store, trace } = await fixture();
    try {
      const first = await app.inject("/runs/run-1/traces?limit=1");
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ total: 3, offset: 0, nextOffset: 1, entries: [{ traceId: "0", trace: { attempt: 1 } }], facets: { modelIds: ["model-a", "model-b"] } });
      await store.recordModelTrace({ ...trace, attempt: 3 });
      const next = await app.inject("/runs/run-1/traces?limit=1&offset=1");
      expect(next.json()).toMatchObject({ total: 4, entries: [{ traceId: "1", trace: { attempt: 2, outcome: "refusal" } }] });
      const filtered = await app.inject("/runs/run-1/traces?nodeId=critic&modelId=model-b&protocolId=plan-critic&outcome=error&activity=turn%2F0");
      expect(filtered.json()).toMatchObject({ total: 1, nextOffset: null, entries: [{ traceId: "2", trace: { tokenUsage: null, costUsd: null } }] });
      expect((await app.inject("/runs/run-1/traces/2")).json()).toMatchObject({ traceId: "2", trace: { activityId: "critic/turn/0" } });
      expect((await app.inject("/runs/run-1/traces?modelId=missing")).json()).toMatchObject({ entries: [], total: 0 });
      expect((await app.inject("/runs/run-1/traces/99")).statusCode).toBe(404);
    } finally { await app.close(); }
  });

  it("loads immutable inputs and unindexed outputs only through their trace, checks hashes, and blocks secret egress", async () => {
    const { app, store, output, trace } = await fixture();
    try {
      // Replacing the named input must not change a historical trace's referenced bytes.
      await store.publish("input", { messages: ["replacement"] });
      expect((await app.inject("/runs/run-1/traces/0/artifacts/input-0")).json().content).toContain("inspect source");
      expect((await app.inject("/runs/run-1/traces/0/artifacts/output")).json()).toMatchObject({ reference: output.relativePath, redacted: true });
      expect((await app.inject("/runs/run-1/traces/1/artifacts/output")).statusCode).toBe(404);
      expect((await app.inject("/runs/run-1/traces/0/artifacts/input-99")).statusCode).toBe(404);
      await writeFile(join(store.directory, output.relativePath), "{}");
      const corrupt = await app.inject("/runs/run-1/traces/0/artifacts/output");
      expect(corrupt.statusCode).toBe(500); expect(corrupt.body).toContain("ARTIFACT_CONTENT_ADDRESS_MISMATCH");
      const unsafe = await store.artifacts.put({ content: "sk-abcdefghijklmnop" }, "json");
      await store.recordModelTrace({ ...trace, attempt: 3, outputArtifactRef: unsafe.relativePath });
      const secret = await app.inject("/runs/run-1/traces/3/artifacts/output");
      expect(secret.statusCode).toBe(500); expect(secret.body).toContain("HTTP_SECRET_EGRESS_BLOCKED");
      expect(secret.body).not.toContain("sk-abcdefghijklmnop");
      await store.recordModelTrace({ ...trace, attempt: 4, outputArtifactRef: "../../context.json" });
      expect((await app.inject("/runs/run-1/traces/4/artifacts/output")).body).toContain("INVALID_ARTIFACT_REFERENCE");
    } finally { await app.close(); }
  });

  it("rejects malformed pagination and identifiers before executing a query, and applies the localhost boundary", async () => {
    const { app } = await fixture();
    try {
      for (const query of ["limit=101", "limit=0", "offset=-1", "offset=0.5", "offset=wat", "outcome=unknown", "nodeId="]) {
        expect((await app.inject(`/runs/run-1/traces?${query}`)).statusCode, query).toBe(400);
      }
      expect((await app.inject("/runs/run-1/traces/01")).statusCode).toBe(400);
      expect((await app.inject("/runs/run-1/traces/0/artifacts/context.json")).statusCode).toBe(400);
      expect((await app.inject({ url: "/runs/run-1/traces", headers: { origin: "https://remote.example" } })).statusCode).toBe(403);
      expect((await app.inject("/runs/missing/traces")).statusCode).toBe(404);
    } finally { await app.close(); }
  });
});
