import { describe, expect, it, vi } from "vitest";
import { ContinuationStateStore } from "../src/continuation/store.js";
import { MAXIMUM_SUSPEND_RESENDS, ProviderInvocationRuntime, type InvocationTrace, type RuntimeTimer } from "../src/runtime.js";
import { RateLimitScheduler } from "../src/scheduler.js";
import type { HostSuspend, SuspendWatch } from "../src/suspend.js";
import { TransportError, withStreamTrace, type ProviderTransport, type TransportResponse } from "../src/transport-contract.js";

/**
 * A computer the test puts to sleep: `sleep` records a suspend from now and moves the clock past it, and leaves the
 * computer not yet awake long enough until `settle` (the gate a call waits at before it starts).
 */
function computer() {
  let now = Date.parse("2026-10-26T10:37:05Z"); const suspends: HostSuspend[] = [];
  let settled: Promise<void> = Promise.resolve(); let settle: () => void = () => {};
  const watch: SuspendWatch = { now: () => now, suspendsSince: (since) => suspends.filter(({ to }) => to > since), awake: () => settled };
  return {
    watch, suspends,
    sleep(milliseconds: number): void {
      suspends.push({ from: now, to: now + milliseconds }); now += milliseconds;
      settled = new Promise((resolve) => { settle = () => { settled = Promise.resolve(); resolve(); }; });
    },
    settle: () => settle(),
    unsettled(): void { settled = new Promise((resolve) => { settle = () => { settled = Promise.resolve(); resolve(); }; }); },
  };
}

/** A send that the stage timeout (20 ms) aborts, the computer having slept meanwhile when `sleeps` says so, and that stops at once. */
function timingOut(host: ReturnType<typeof computer>, sleeps: (call: number) => boolean, then: (call: number) => TransportResponse | null = () => null) {
  let calls = 0;
  return vi.fn((_request: unknown, signal: AbortSignal) => new Promise<TransportResponse>((resolve, reject) => {
    calls += 1; const call = calls;
    const answer = then(call); if (answer !== null) { resolve(answer); return; }
    signal.addEventListener("abort", () => { if (sleeps(call)) host.sleep(3_600_000); reject(new TransportError("CANCELLED", "Provider request cancelled", false)); }, { once: true });
  }));
}

describe("a call across the computer's sleep", () => {
  it("is sent again once the computer is awake, without counting an attempt, and not taken for a run past its time limit", async () => {
    // Observed live (October 26, 2026, macOS, pmset): calls in flight when the Mac went to idle sleep timed out in its
    // dark wakes, each retry was sent in another, and the run failed "after 3 attempts (TIMEOUT …)" naming a provider.
    for (const retryTimeouts of [true, false]) {
      const host = computer(); const traces: InvocationTrace[] = [];
      const send = timingOut(host, (call) => call === 1, (call) => call === 2 ? response() : null);
      const pending = runtime({ id: "fixture", send }, host.watch, traces).invoke(request(), context({ maximumRetries: 0, timeoutMs: 20, retryTimeouts }));
      // Nothing is sent again until the computer has been awake a while.
      await vi.waitFor(() => { expect(traces).toHaveLength(1); });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(send).toHaveBeenCalledTimes(1);
      host.settle();
      await expect(pending).resolves.toMatchObject({ text: "ok" });
      expect(send).toHaveBeenCalledTimes(2);
      expect(traces).toEqual([
        expect.objectContaining({ attempt: 1, outcome: "retry", errorCode: "TIMEOUT", suspended: { from: "2026-10-26T10:37:05.000Z", to: "2026-10-26T11:37:05.000Z" } }),
        expect.objectContaining({ attempt: 1, outcome: "completed" }),
      ]);
    }
  });

  it("names the sleep, not the provider, when the computer sleeps through every sending of the call", async () => {
    for (const retryTimeouts of [true, false]) {
      const host = computer();
      const send = timingOut(host, () => true);
      // Each wake is settled at once, so only the bound stops the resends.
      const watch: SuspendWatch = { ...host.watch, awake: () => Promise.resolve() };
      await expect(runtime({ id: "fixture", send }, watch).invoke(request(), context({ maximumRetries: 1, timeoutMs: 20, retryTimeouts }))).rejects.toMatchObject({
        name: "HostSuspendedError", causeCode: "TIMEOUT", attempts: 2,
        message: expect.stringMatching(/^The computer slept from 2026-10-26T10:37:05\.000Z to 2026-10-26T15:37:05\.000Z while a call to provider was in flight.*The sleep stopped it, not provider/u) as unknown,
      });
      expect(send).toHaveBeenCalledTimes(MAXIMUM_SUSPEND_RESENDS + 2);
    }
  });

  it("starts no call until the computer has been awake a while, and stops waiting when cancelled", async () => {
    const host = computer(); host.unsettled();
    const send = vi.fn(async () => response());
    const pending = runtime({ id: "fixture", send }, host.watch).invoke(request(), context());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(send).not.toHaveBeenCalled();
    host.settle();
    await expect(pending).resolves.toMatchObject({ text: "ok" });
    const controller = new AbortController(); host.unsettled();
    const watch: SuspendWatch = { ...host.watch, awake: (signal) => new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); }) };
    const cancelled = runtime({ id: "fixture", send }, watch).invoke(request(), context({ signal: controller.signal }));
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "ProviderInvocationFailure", causeCode: "CANCELLED", attempts: 0 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("still fails at once a call whose CLI left processes running, and still counts an ordinary timeout", async () => {
    const host = computer();
    const left = vi.fn((_request: unknown, signal: AbortSignal) => new Promise<TransportResponse>((_resolve, reject) => {
      signal.addEventListener("abort", () => { host.sleep(3_600_000); reject(new TransportError("HTTP", "CLI_PROCESS_TREE_NOT_TERMINATED: Claude Code left processes running", false)); }, { once: true });
    }));
    const watch: SuspendWatch = { ...host.watch, awake: () => Promise.resolve() };
    await expect(runtime({ id: "fixture", send: left }, watch).invoke(request(), context({ maximumRetries: 2, timeoutMs: 20 }))).rejects.toMatchObject({ name: "ProviderInvocationFailure", causeCode: "HTTP", attempts: 1 });
    expect(left).toHaveBeenCalledTimes(1);
    const awake = timingOut(computer(), () => false);
    await expect(runtime({ id: "fixture", send: awake }, computer().watch).invoke(request(), context({ maximumRetries: 1, timeoutMs: 20, retryTimeouts: false }))).rejects.toMatchObject({ name: "ProviderTimeLimitError", attempts: 1 });
  });

  it("says in a timed-out call's failure what its stream showed, and keeps the trace in the attempt's record", async () => {
    const stream = { startedAt: "2026-10-26T14:18:00.000Z", stoppedAt: "2026-10-26T14:33:00.000Z", events: 2, lastEventAt: "2026-10-26T14:18:40.000Z", lastEventType: "assistant", stderrTail: "warning: slow\nretrying request" };
    const send = vi.fn((_request: unknown, signal: AbortSignal) => new Promise<TransportResponse>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(withStreamTrace(new TransportError("CANCELLED", "Provider request cancelled", false), stream)), { once: true });
    }));
    const traces: InvocationTrace[] = [];
    await expect(runtime({ id: "fixture", send }, computer().watch, traces).invoke(request(), context({ timeoutMs: 20 }))).rejects.toMatchObject({
      causeCode: "TIMEOUT", message: expect.stringContaining("(TIMEOUT: Provider stage timed out after 20ms; stream: 2 events in 15.0 min, the last (assistant) 14.3 min before it stopped; stderr: warning: slow / retrying request)") as unknown,
    });
    expect(traces).toEqual([expect.objectContaining({ outcome: "failed", errorCode: "TIMEOUT", stream })]);
  });
});

function runtime(transport: ProviderTransport, suspends: SuspendWatch, traces: InvocationTrace[] = []) {
  return new ProviderInvocationRuntime({
    transports: { fixture: transport }, scheduler: new RateLimitScheduler({ provider: { rpm: 100, tpm: 100_000, maxConcurrent: 1 } }),
    budget: { reserve: () => ({ allowed: true }), recordActual() {} },
    continuation: new ContinuationStateStore({ async save() {}, async load() { return null; } }, { enabled: false, now: () => 0 }),
    traces: { record: (entry) => traces.push(entry) }, timer: stageTimer(), suspends,
  });
}
/** The stage timeout (20 ms) fires at once; the wait for a timed-out send to stop never runs out; backoff is instant. */
function stageTimer(): RuntimeTimer {
  return { sleep: async () => {}, timeout: (milliseconds, callback) => {
    if (milliseconds !== 20) return () => {};
    const handle = setTimeout(callback, 0); return () => clearTimeout(handle);
  } };
}
function request() { return { modelId: "model", messages: [{ role: "user" as const, content: "hello" }], maximumOutputTokens: 10 }; }
function context(overrides: Partial<Parameters<ProviderInvocationRuntime["invoke"]>[1]> = {}) { return { activityId: "activity", providerId: "provider", transportId: "fixture", modelId: "model", estimatedTokens: 10, maximumRetries: 0, timeoutMs: 1_000, signal: new AbortController().signal, ...overrides }; }
function response(): TransportResponse { return { text: "ok", structured: null, toolCalls: [], refusal: null, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, continuation: null, structuredOutputTier: "prompt_json", providerRequestId: null }; }
