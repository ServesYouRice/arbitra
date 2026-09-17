import { describe, expect, it, vi } from "vitest";
import { ContinuationStateStore, type PersistedContinuation } from "../src/continuation/store.js";
import { ModelPool, type PoolModel } from "../src/model-pool.js";
import { ProviderRegistry } from "../src/registry.js";
import { RateLimitScheduler } from "../src/scheduler.js";
import type { InvocationTrace } from "../src/runtime.js";
import type { HttpRequest } from "../src/transport-contract.js";

function fixture() {
  const requests: HttpRequest[] = [];
  const traces: InvocationTrace[] = [];
  const records = new Map<string, PersistedContinuation>();
  const registry = new ProviderRegistry([
    { id: "first", providerId: "one", transport: "openai-responses", endpoint: "https://one.example/v1", apiKeyEnvVar: "ONE_KEY" },
    { id: "second", providerId: "two", transport: "openai-responses", endpoint: "https://two.example/v1", apiKeyEnvVar: "TWO_KEY" },
  ], { credential: (name) => name, client: { async send(request) {
    requests.push(request);
    return { status: 200, headers: {}, body: { id: "response-1", output_text: "ok", usage: { input_tokens: 11, output_tokens: 3 } } };
  } } });
  const profile: PoolModel["profile"] = {
    provider: "one", transport: "openai-responses", modelId: "same-model-name",
    limits: { contextTokens: 1_000, maxOutputTokens: 100 },
    effort: { supported: ["high"], collapse: { xhigh: "high" }, params: { high: { effort: "high" } } },
    supports: { tools: false, parallelToolCalls: false, structuredOutput: true, reasoning: true, promptCaching: false, batch: false, vision: false },
  };
  const models: PoolModel[] = [
    { id: "auditor-a", endpointId: "first", profile },
    { id: "auditor-b", endpointId: "second", profile: { ...profile, provider: "two" } },
  ];
  const reserve = vi.fn(() => ({ allowed: true }));
  const actual = vi.fn();
  const pool = new ModelPool(registry, models, {
    scheduler: new RateLimitScheduler(Object.fromEntries(["one", "two"].map((id) => [id, { rpm: 100, tpm: 100_000, maxConcurrent: 2 }]))),
    budget: { reserve, recordActual: actual },
    continuation: new ContinuationStateStore({ async save(id, value) { records.set(id, value); }, async load(id) { return records.get(id) ?? null; } }, { enabled: true, now: () => 0 }),
    traces: { record(trace) { traces.push(trace); } },
  });
  return { pool, requests, traces, records, reserve, actual, profile };
}

const request = { messages: [{ role: "user" as const, content: "hello" }], maximumOutputTokens: 50 };
const invocation = { activityId: "run/auditor-a/turn-0", modelProfileId: "auditor-a", estimatedTokens: 100, maximumRetries: 0, timeoutMs: 1_000, signal: new AbortController().signal };

describe("configured model pool", () => {
  it("runs models on different services together with real usage and explicit effort collapse", async () => {
    const { pool, requests, traces, actual } = fixture();
    const results = await Promise.all([
      pool.invoke(request, { ...invocation, effort: "xhigh" }),
      pool.invoke(request, { ...invocation, activityId: "run/auditor-b/turn-0", modelProfileId: "auditor-b" }),
    ]);
    expect(results[0]).toMatchObject({ providerId: "one", transport: "openai-responses", modelId: "same-model-name", effort: { applied: "high", collapsedFrom: "xhigh" } });
    expect(results[1]).toMatchObject({ providerId: "two", effort: null });
    expect(requests.map(({ url }) => url).sort()).toEqual(["https://one.example/v1/responses", "https://two.example/v1/responses"]);
    expect(traces.map(({ providerId }) => providerId).sort()).toEqual(["one", "two"]);
    expect(actual).toHaveBeenCalledWith(invocation.activityId, expect.objectContaining({ inputTokens: 11, outputTokens: 3 }), undefined);
  });

  it("does not restore a continuation into a different endpoint with the same model name", async () => {
    const { pool, requests, reserve } = fixture();
    await pool.invoke(request, invocation);
    await expect(pool.invoke(request, { ...invocation, modelProfileId: "auditor-b" })).rejects.toThrow("CONTINUATION_TRANSPORT_BOUNDARY_CROSSING");
    expect(requests).toHaveLength(1);
    expect(reserve).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported capabilities and invalid token bounds before spend", async () => {
    const { pool, reserve } = fixture();
    await expect(pool.invoke({ ...request, maximumOutputTokens: 101 }, invocation)).rejects.toThrow("MODEL_OUTPUT_LIMIT_EXCEEDED");
    await expect(pool.invoke(request, { ...invocation, estimatedTokens: 1_001 })).rejects.toThrow("MODEL_CONTEXT_LIMIT_EXCEEDED");
    await expect(pool.invoke(request, { ...invocation, estimatedTokens: 1 })).rejects.toThrow("OUTPUT_RESERVE_MISSING");
    await expect(pool.invoke({ ...request, tools: [{ name: "tool", description: "", inputSchema: {} }] }, invocation)).rejects.toThrow("MODEL_TOOLS_NOT_SUPPORTED");
    await expect(pool.invoke(request, { ...invocation, effort: "low" })).rejects.toThrow("UNSUPPORTED_EFFORT");
    await expect(pool.invoke(request, { ...invocation, modelProfileId: "toString" })).rejects.toThrow("UNKNOWN_MODEL_PROFILE");
    expect(reserve).not.toHaveBeenCalled();
  });
});
