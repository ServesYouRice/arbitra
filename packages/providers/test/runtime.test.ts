import { describe, expect, it, vi } from "vitest";

import { ContinuationStateStore } from "../src/continuation/store.js";
import { ProviderInvocationFailure, ProviderInvocationRuntime, type RuntimeTimer } from "../src/runtime.js";
import { RateLimitScheduler } from "../src/scheduler.js";
import { TransportError, type ProviderTransport, type TransportResponse } from "../src/transport-contract.js";

describe("provider invocation runtime", () => {
  it("cancels queued admissions without consuming a concurrency slot", async () => {
    const limits = scheduler();
    const first = await limits.acquire("provider", 1);
    const controller = new AbortController();
    const pending = limits.acquire("provider", 1, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(limits.snapshot("provider").active).toBe(1);
    first.release();
    expect(limits.snapshot("provider").active).toBe(0);
  });
  it("releases the concurrency lease before retry backoff", async () => {
    let now = 0;
    const scheduler = new RateLimitScheduler({ provider: { rpm: 10, tpm: 10_000, maxConcurrent: 1 } }, { now: () => now, sleep: async (milliseconds) => { now += milliseconds; } });
    let calls = 0;
    const transport: ProviderTransport = { id: "fixture", async send() { calls += 1; if (calls === 1) throw new TransportError("RATE_LIMIT", "slow down", true, 10); return successfulResponse(); } };
    const timer: RuntimeTimer = { timeout: () => () => {}, sleep: async (milliseconds) => { expect(scheduler.snapshot("provider").active).toBe(0); now += milliseconds; } };
    const runtime = createRuntime(transport, scheduler, timer);
    await expect(runtime.invoke(request(), context({ maximumRetries: 1 }))).resolves.toMatchObject({ text: "ok" });
    expect(calls).toBe(2);
  });

  it("cancels even when a transport ignores its abort signal", async () => {
    let markSent: (() => void) | undefined;
    const sent = new Promise<void>((resolve) => { markSent = resolve; });
    const transport: ProviderTransport = { id: "fixture", send: async () => { markSent?.(); return new Promise<TransportResponse>(() => {}); } };
    const timer: RuntimeTimer = { timeout: () => () => {}, sleep: async () => {} };
    const controller = new AbortController();
    const pending = createRuntime(transport, scheduler(), timer).invoke(request(), context({ signal: controller.signal }));
    await sent;
    controller.abort("operator");
    await expect(pending).rejects.toMatchObject({ name: "ProviderInvocationFailure", attempts: 1, causeCode: "CANCELLED" });
  });

  it("reports actual attempts and validates before touching the budget", async () => {
    const reserve = vi.fn(() => ({ allowed: true }));
    const transport: ProviderTransport = { id: "fixture", async send() { throw new TransportError("AUTH", "bad key", false); } };
    const runtime = createRuntime(transport, scheduler(), undefined, reserve);
    await expect(runtime.invoke(request(), context({ maximumRetries: 3 }))).rejects.toEqual(expect.objectContaining<Partial<ProviderInvocationFailure>>({ attempts: 1, causeCode: "AUTH" }));
    await expect(runtime.invoke(request(), context({ estimatedTokens: -1 }))).rejects.toThrow("INVALID_ESTIMATED_TOKENS");
    expect(reserve).toHaveBeenCalledTimes(1);
  });
});

function createRuntime(transport: ProviderTransport, rateLimits: RateLimitScheduler, timer?: RuntimeTimer, reserve = vi.fn(() => ({ allowed: true }))) {
  return new ProviderInvocationRuntime({
    transports: { fixture: transport }, scheduler: rateLimits,
    budget: { reserve, recordActual() {} },
    continuation: new ContinuationStateStore({ async save() {}, async load() { return null; } }, { enabled: false, now: () => 0 }),
    traces: { record() {} }, ...(timer === undefined ? {} : { timer }),
  });
}
function scheduler() { return new RateLimitScheduler({ provider: { rpm: 10, tpm: 10_000, maxConcurrent: 1 } }); }
function request() { return { modelId: "model", messages: [{ role: "user" as const, content: "hello" }], maximumOutputTokens: 10 }; }
function context(overrides: Partial<Parameters<ProviderInvocationRuntime["invoke"]>[1]> = {}) { return { activityId: "activity", providerId: "provider", transportId: "fixture", modelId: "model", estimatedTokens: 10, maximumRetries: 0, timeoutMs: 1_000, signal: new AbortController().signal, ...overrides }; }
function successfulResponse(): TransportResponse { return { text: "ok", structured: null, toolCalls: [], refusal: null, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, continuation: null, structuredOutputTier: "prompt_json", providerRequestId: null }; }
