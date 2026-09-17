import { TransportError, type ProviderTransport, type TransportRequest, type TransportResponse } from "./transport-contract.js";
import { setTimeout as delay } from "node:timers/promises";
import { RateLimitScheduler, type SchedulerLease } from "./scheduler.js";
import { ContinuationStateStore } from "./continuation/store.js";
import { sessionContinuationState } from "./continuation/types.js";

export interface InvocationBudget {
  reserve(activityId: string, estimatedTokens: number): BudgetReservation | Promise<BudgetReservation>;
  recordActual(activityId: string, usage: TransportResponse["usage"], reservationId?: string): void | Promise<void>;
}
export interface BudgetReservation { readonly allowed: boolean; readonly reason?: string; readonly reservationId?: string; }
export interface InvocationTrace {
  readonly activityId: string; readonly providerId: string; readonly modelId: string; readonly transportId: string;
  readonly attempt: number; readonly outcome: "completed" | "retry" | "failed"; readonly errorCode: string | null;
  readonly usage: TransportResponse["usage"] | null;
}
export interface TraceSink { record(trace: InvocationTrace): void; }
export interface RuntimeTimer {
  timeout(milliseconds: number, callback: () => void): () => void;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const systemSetTimeout = setTimeout;
const systemTimer: RuntimeTimer = {
  timeout(milliseconds, callback) { const handle = systemSetTimeout(callback, boundedTimerDelay(milliseconds)); return () => clearTimeout(handle); },
  sleep: async (milliseconds, signal) => delay(boundedTimerDelay(milliseconds), undefined, { signal }),
};
export interface ProviderInvocationContext {
  readonly activityId: string; readonly providerId: string; readonly transportId: string; readonly modelId: string;
  readonly estimatedTokens: number; readonly maximumRetries: number; readonly timeoutMs: number; readonly signal: AbortSignal;
}
export interface ProviderRuntimeOptions {
  readonly transports: Readonly<Record<string, ProviderTransport>>;
  readonly scheduler: RateLimitScheduler;
  readonly budget: InvocationBudget;
  readonly continuation: ContinuationStateStore;
  readonly traces: TraceSink;
  readonly timer?: RuntimeTimer;
  readonly maximumBackoffMs?: number;
}

export class ProviderBudgetSuspendedError extends Error {
  readonly state = "SUSPENDED_BUDGET" as const;
  constructor(readonly reason: string) { super(reason); this.name = "ProviderBudgetSuspendedError"; }
}
export class ProviderInvocationFailure extends Error {
  readonly degradedCompleteness = true;
  readonly resumable = true;
  constructor(message: string, readonly attempts: number, readonly causeCode: string) { super(message); this.name = "ProviderInvocationFailure"; }
}

/** Sole production entrypoint to low-level provider transports. */
export class ProviderInvocationRuntime {
  private readonly timer: RuntimeTimer;
  private readonly maximumBackoffMs: number;
  constructor(private readonly options: ProviderRuntimeOptions) {
    this.timer = options.timer ?? systemTimer;
    this.maximumBackoffMs = boundedTimerDelay(options.maximumBackoffMs ?? 30_000);
    if (this.maximumBackoffMs < 1) throw new Error("INVALID_MAXIMUM_BACKOFF");
  }

  async invoke(request: TransportRequest, context: ProviderInvocationContext): Promise<TransportResponse> {
    validateContext(context);
    if (request.modelId !== context.modelId) throw new Error("INVOCATION_MODEL_MISMATCH");
    if (context.signal.aborted) throw new ProviderInvocationFailure("Provider request cancelled before dispatch", 0, "CANCELLED");
    const transport = Object.hasOwn(this.options.transports, context.transportId) ? this.options.transports[context.transportId] : undefined;
    if (transport === undefined) throw new Error(`UNKNOWN_TRANSPORT:${context.transportId}`);
    const restored = await this.options.continuation.load(context.activityId, { transport: context.transportId, modelId: context.modelId });
    const continuation = restored?.opaque;
    const effectiveRequest: TransportRequest = { ...request,
      ...(continuation === undefined ? {} : { continuation: typeof continuation === "string" ? continuation : Buffer.from(continuation).toString("base64") }) };

    let lastError: unknown;
    let attempts = 0;
    for (let attempt = 1; attempt <= context.maximumRetries + 1; attempt += 1) {
      if (context.signal.aborted) throw new ProviderInvocationFailure("Provider request cancelled before dispatch", attempts, "CANCELLED");
      const reservation = await this.options.budget.reserve(context.activityId, context.estimatedTokens);
      if (!reservation.allowed) throw new ProviderBudgetSuspendedError(reservation.reason ?? "Provider budget preflight refused dispatch");
      let lease: SchedulerLease | undefined;
      let retryDelay: number | null = null;
      try {
        lease = await this.options.scheduler.acquire(context.providerId, context.estimatedTokens, context.signal);
        if (context.signal.aborted) throw new TransportError("CANCELLED", "Provider request cancelled before dispatch", false);
        attempts = attempt;
        const result = await sendWithTimeout(transport, effectiveRequest, context.signal, context.timeoutMs, this.timer);
        await this.options.budget.recordActual(context.activityId, result.usage, reservation.reservationId);
        if (result.continuation !== null) await this.options.continuation.save(context.activityId, sessionContinuationState({
          transport: context.transportId, modelId: context.modelId, activityId: context.activityId,
          opaque: result.continuation, expiresAt: null,
        }));
        this.options.traces.record(trace(context, attempt, "completed", null, result.usage));
        return result;
      } catch (error) {
        lastError = error;
        const retryable = error instanceof TransportError && error.retryable && attempt <= context.maximumRetries;
        this.options.traces.record(trace(context, attempt, retryable ? "retry" : "failed",
          error instanceof TransportError ? error.code : "UNKNOWN", null));
        if (!retryable) break;
        const retryAfter = boundedTimerDelay(error.retryAfterMs ?? Math.min(this.maximumBackoffMs, 1_000 * (2 ** (attempt - 1))));
        if (error.code === "RATE_LIMIT") this.options.scheduler.respectRetryAfter(context.providerId, retryAfter);
        retryDelay = retryAfter;
      } finally { lease?.release(); }
      if (retryDelay !== null) {
        try { await sleepUnlessAborted(this.timer, retryDelay, context.signal); }
        catch (error) { lastError = error; break; }
      }
    }
    const code = lastError instanceof TransportError ? lastError.code : "UNKNOWN";
    throw new ProviderInvocationFailure(`Provider ${context.providerId} failed after ${attempts} attempt${attempts === 1 ? "" : "s"} (${code}); completed artifacts are preserved and the run may resume with degraded completeness.`, attempts, code);
  }
}

function boundedTimerDelay(milliseconds: number): number {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error("INVALID_TIMER_DELAY");
  return Math.min(MAX_TIMER_DELAY_MS, Math.ceil(milliseconds));
}

async function sendWithTimeout(transport: ProviderTransport, request: TransportRequest, outer: AbortSignal, milliseconds: number, timer: RuntimeTimer): Promise<TransportResponse> {
  if (outer.aborted) throw new TransportError("CANCELLED", "Provider request cancelled before dispatch", false);
  const controller = new AbortController();
  let rejectAbort: (error: TransportError) => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = () => { controller.abort(outer.reason); rejectAbort(new TransportError("CANCELLED", "Provider request cancelled", false)); };
  outer.addEventListener("abort", abort, { once: true });
  if (outer.aborted) abort();
  let timedOut = false;
  let rejectTimeout: (error: TransportError) => void = () => {};
  const timeout = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
  const cancelTimeout = timer.timeout(milliseconds, () => {
    timedOut = true;
    controller.abort("timeout");
    rejectTimeout(new TransportError("TIMEOUT", `Provider stage timed out after ${milliseconds}ms`, true));
  });
  try {
    return await Promise.race([transport.send(request, controller.signal), timeout, cancelled]);
  } catch (error) {
    if (timedOut) throw new TransportError("TIMEOUT", `Provider stage timed out after ${milliseconds}ms`, true);
    throw error;
  } finally { cancelTimeout(); outer.removeEventListener("abort", abort); }
}
function validateContext(value: ProviderInvocationContext): void {
  for (const [name, identifier] of [["ACTIVITY", value.activityId], ["PROVIDER", value.providerId], ["TRANSPORT", value.transportId], ["MODEL", value.modelId]] as const) {
    if (identifier.trim() === "") throw new Error(`INVALID_${name}_ID`);
  }
  if (!Number.isSafeInteger(value.estimatedTokens) || value.estimatedTokens < 0) throw new Error("INVALID_ESTIMATED_TOKENS");
  if (!Number.isSafeInteger(value.maximumRetries) || value.maximumRetries < 0 || value.maximumRetries >= Number.MAX_SAFE_INTEGER) throw new Error("INVALID_MAXIMUM_RETRIES");
  if (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1) throw new Error("INVALID_STAGE_TIMEOUT");
}

async function sleepUnlessAborted(timer: RuntimeTimer, milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new TransportError("CANCELLED", "Provider request cancelled", false);
  let rejectAbort: (error: TransportError) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = (): void => rejectAbort(new TransportError("CANCELLED", "Provider request cancelled", false));
  signal.addEventListener("abort", abort, { once: true });
  try { await Promise.race([timer.sleep(milliseconds, signal), aborted]); }
  finally { signal.removeEventListener("abort", abort); }
}
function trace(context: ProviderInvocationContext, attempt: number, outcome: InvocationTrace["outcome"], errorCode: string | null,
  usage: TransportResponse["usage"] | null): InvocationTrace {
  return Object.freeze({ activityId: context.activityId, providerId: context.providerId, modelId: context.modelId,
    transportId: context.transportId, attempt, outcome, errorCode, usage });
}
