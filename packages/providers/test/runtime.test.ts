import { describe, expect, it, vi } from "vitest";

import { ContinuationStateStore } from "../src/continuation/store.js";
import { ProviderInvocationFailure, ProviderInvocationRuntime, type RuntimeTimer } from "../src/runtime.js";
import { RateLimitScheduler } from "../src/scheduler.js";
import { DurableTokenBudget } from "../src/token-budget.js";
import { noUsage, TransportError, type ProviderTransport, type TransportResponse } from "../src/transport-contract.js";

describe("provider invocation runtime", () => {
  it("suspends a retry before dispatch when the preceding attempt consumed the remaining budget", async () => {
    const send = vi.fn(async () => { throw new TransportError("TIMEOUT", "unknown billed usage", true); });
    const traces = vi.fn();
    const runtime = new ProviderInvocationRuntime({
      transports: { fixture: { id: "fixture", send } }, scheduler: scheduler(),
      budget: new DurableTokenBudget(10, { async load() { return null; }, async save() {} }),
      continuation: new ContinuationStateStore({ async load() { return null; }, async save() {} }, { enabled: false, now: () => 0 }),
      traces: { record: traces }, timer: { timeout: () => () => {}, sleep: async () => {} },
    });
    await expect(runtime.invoke(request(), context({ maximumRetries: 2 }))).rejects.toMatchObject({ state: "SUSPENDED_BUDGET" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(traces).toHaveBeenCalledWith(expect.objectContaining({ outcome: "retry", usage: null }));
  });

  it("releases an attempt that provably consumed nothing, so its retry still fits the budget", async () => {
    // Observed live: refused attempts kept their full estimate charged and suspended the run on budget.
    let calls = 0;
    const send = vi.fn(async () => { calls += 1; if (calls === 1) throw new TransportError("RATE_LIMIT", "throttled before processing", true, 0, noUsage("http_429_rate_limited")); return successfulResponse(); });
    const traces = vi.fn();
    const runtime = new ProviderInvocationRuntime({
      transports: { fixture: { id: "fixture", send } }, scheduler: scheduler(),
      budget: new DurableTokenBudget(10, { async load() { return null; }, async save() {} }),
      continuation: new ContinuationStateStore({ async load() { return null; }, async save() {} }, { enabled: false, now: () => 0 }),
      traces: { record: traces }, timer: { timeout: () => () => {}, sleep: async () => {} },
    });
    await expect(runtime.invoke(request(), context({ maximumRetries: 1 }))).resolves.toBeDefined();
    expect(traces).toHaveBeenCalledWith(expect.objectContaining({ outcome: "retry", released: "http_429_rate_limited" }));
  });

  it("does not dispatch when cancelled during asynchronous budget persistence", async () => {
    const controller = new AbortController();
    const send = vi.fn(async () => successfulResponse());
    const runtime = new ProviderInvocationRuntime({
      transports: { fixture: { id: "fixture", send } }, scheduler: scheduler(),
      budget: { async reserve() { controller.abort(); return { allowed: true }; }, recordActual() {} },
      continuation: new ContinuationStateStore({ async load() { return null; }, async save() {} }, { enabled: false, now: () => 0 }),
      traces: { record() {} },
    });
    await expect(runtime.invoke(request(), context({ signal: controller.signal }))).rejects.toMatchObject({ causeCode: "CANCELLED", attempts: 0 });
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects mismatched model identity and inherited transport names before reserving budget", async () => {
    const reserve = vi.fn(() => ({ allowed: true }));
    const transport: ProviderTransport = { id: "fixture", async send() { return successfulResponse(); } };
    const runtime = createRuntime(transport, scheduler(), undefined, reserve);
    await expect(runtime.invoke(request(), context({ modelId: "different-model" }))).rejects.toThrow("INVOCATION_MODEL_MISMATCH");
    await expect(runtime.invoke(request(), context({ transportId: "toString" }))).rejects.toThrow("UNKNOWN_TRANSPORT");
    await expect(scheduler().acquire("toString", 1)).rejects.toThrow("UNKNOWN_PROVIDER_POLICY");
    expect(reserve).not.toHaveBeenCalled();
  });
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

  it("waits for a timed-out send to stop before its retry starts or its slot is freed", async () => {
    // A CLI takes time to end its process tree once aborted; the stage timeout retried at once, beside it.
    const limits = scheduler(); const events: string[] = []; let calls = 0;
    const transport: ProviderTransport = { id: "fixture", send: (_request, signal) => new Promise<TransportResponse>((resolve, reject) => {
      calls += 1; const call = calls; events.push(`start ${call}`);
      if (call === 2) { resolve(successfulResponse()); return; }
      signal.addEventListener("abort", () => setTimeout(() => { events.push(`stopped ${call} with ${limits.snapshot("provider").active} active`); reject(new TransportError("CANCELLED", "Provider request cancelled", false)); }, 50));
    }) };
    const traces = vi.fn();
    const runtime = new ProviderInvocationRuntime({ transports: { fixture: transport }, scheduler: limits, budget: { reserve: () => ({ allowed: true }), recordActual() {} },
      continuation: new ContinuationStateStore({ async save() {}, async load() { return null; } }, { enabled: false, now: () => 0 }), traces: { record: traces }, timer: stageTimer() });
    await expect(runtime.invoke(request(), context({ maximumRetries: 1, timeoutMs: 20 }))).resolves.toMatchObject({ text: "ok" });
    expect(events).toEqual(["start 1", "stopped 1 with 1 active", "start 2"]);
    expect(traces).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, outcome: "retry", errorCode: "TIMEOUT" }));
  });

  it("does not send a call that ran past its time limit again when its caller sends less work instead", async () => {
    // Observed live (veritra, October 25): a discovery unit past the 15-minute limit was sent again whole, from nothing.
    const send = vi.fn((_request: unknown, signal: AbortSignal) => new Promise<TransportResponse>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new TransportError("CANCELLED", "Provider request cancelled", false)), { once: true });
    }));
    const traces = vi.fn();
    const runtime = new ProviderInvocationRuntime({ transports: { fixture: { id: "fixture", send } }, scheduler: scheduler(), budget: { reserve: () => ({ allowed: true }), recordActual() {} },
      continuation: new ContinuationStateStore({ async save() {}, async load() { return null; } }, { enabled: false, now: () => 0 }), traces: { record: traces }, timer: stageTimer() });
    await expect(runtime.invoke(request(), context({ maximumRetries: 2, timeoutMs: 20, retryTimeouts: false }))).rejects.toMatchObject({
      name: "ProviderTimeLimitError", causeCode: "TIMEOUT", attempts: 1, message: expect.stringContaining("ran past its time limit of 20 ms") as unknown,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(traces).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, outcome: "failed", errorCode: "TIMEOUT" }));
    // Every other call is sent again as before.
    send.mockClear();
    await expect(runtime.invoke(request(), context({ maximumRetries: 2, timeoutMs: 20 }))).rejects.toMatchObject({ name: "ProviderInvocationFailure", causeCode: "TIMEOUT", attempts: 3 });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("fails a timed-out call without a retry when its CLI left processes running", async () => {
    const send = vi.fn((_request: unknown, signal: AbortSignal) => new Promise<TransportResponse>((_resolve, reject) => {
      signal.addEventListener("abort", () => setTimeout(() => reject(new TransportError("HTTP", "CLI_PROCESS_TREE_NOT_TERMINATED: Claude Code left processes running (process 4242 and its descendants)", false)), 10));
    }));
    await expect(createRuntime({ id: "fixture", send }, scheduler(), stageTimer()).invoke(request(), context({ maximumRetries: 1, timeoutMs: 20 }))).rejects.toMatchObject({
      causeCode: "HTTP", attempts: 1, message: expect.stringContaining("CLI_PROCESS_TREE_NOT_TERMINATED: Claude Code left processes running") as unknown,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("stops waiting for a timed-out send that never stops, and starts no retry beside it", async () => {
    const send = vi.fn(() => new Promise<TransportResponse>(() => {}));
    let graceRequested = 0;
    const timer: RuntimeTimer = { sleep: async () => {}, timeout: (milliseconds, callback) => {
      if (milliseconds !== 20) graceRequested = milliseconds;
      const handle = setTimeout(callback, milliseconds === 20 ? 0 : 10); return () => clearTimeout(handle);
    } };
    await expect(createRuntime({ id: "fixture", send }, scheduler(), timer).invoke(request(), context({ maximumRetries: 1, timeoutMs: 20 }))).rejects.toMatchObject({
      causeCode: "TIMEOUT", attempts: 1, message: expect.stringContaining("had not stopped") as unknown,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(graceRequested).toBe(30_000);
  });

  it("pauses the run as rate limited, not failed, when a usage allowance is used up", async () => {
    // Observed live: the Codex five-hour window ran out at the critic and failed a run whose earlier stages were done.
    const transport: ProviderTransport = { id: "fixture", async send() { throw new TransportError("QUOTA", "CLI_USAGE_LIMIT_REACHED: the Codex CLI subscription's usage allowance is exhausted until 2026-10-21T19:33:00.000Z", false, 1_000); } };
    await expect(createRuntime(transport, scheduler()).invoke(request(), context({ maximumRetries: 3 }))).rejects.toMatchObject({
      name: "ProviderUsageLimitError", state: "SUSPENDED_RATE_LIMIT", causeCode: "QUOTA", attempts: 1, message: expect.stringContaining("until 2026-10-21T19:33:00.000Z") as unknown,
    });
  });

  it("names the transport's own code of the last failure beside its shared class", async () => {
    // Observed live (October 27, 2026, agy 1.4.7): Gemini ran agy's run_command on all three attempts, and discovery could
    // tell that MALFORMED_RESPONSE from any other only by reading the message.
    const failing = (error: TransportError) => createRuntime({ id: "fixture", async send() { throw error; } }, scheduler()).invoke(request(), context({ maximumRetries: 2 }));
    await expect(failing(new TransportError("MALFORMED_RESPONSE", "CLI_AGENT_TOOL_USE_FORBIDDEN: Antigravity CLI attempted a tool step (run_command); the CLI's own agent tools are disabled", true)))
      .rejects.toMatchObject({ name: "ProviderInvocationFailure", causeCode: "MALFORMED_RESPONSE", transportCode: "CLI_AGENT_TOOL_USE_FORBIDDEN", attempts: 3 });
    await expect(failing(new TransportError("HTTP", "Provider HTTP 404: model not found", false))).rejects.toMatchObject({ causeCode: "HTTP", transportCode: "HTTP_404" });
    await expect(failing(new TransportError("INVALID_REQUEST", "TOOL_CALL_ID_REQUIRED", false))).rejects.toMatchObject({ transportCode: "TOOL_CALL_ID_REQUIRED" });
    await expect(failing(new TransportError("AUTH", "Credential environment variable KEY is not set", false))).rejects.toMatchObject({ causeCode: "AUTH", transportCode: null });
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
/** The stage timeout (20 ms) fires at once; the wait for a timed-out send to stop never runs out. */
function stageTimer(): RuntimeTimer {
  return { sleep: async () => {}, timeout: (milliseconds, callback) => {
    if (milliseconds !== 20) return () => {};
    const handle = setTimeout(callback, 0); return () => clearTimeout(handle);
  } };
}
function request() { return { modelId: "model", messages: [{ role: "user" as const, content: "hello" }], maximumOutputTokens: 10 }; }
function context(overrides: Partial<Parameters<ProviderInvocationRuntime["invoke"]>[1]> = {}) { return { activityId: "activity", providerId: "provider", transportId: "fixture", modelId: "model", estimatedTokens: 10, maximumRetries: 0, timeoutMs: 1_000, signal: new AbortController().signal, ...overrides }; }
function successfulResponse(): TransportResponse { return { text: "ok", structured: null, toolCalls: [], refusal: null, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, continuation: null, structuredOutputTier: "prompt_json", providerRequestId: null }; }
