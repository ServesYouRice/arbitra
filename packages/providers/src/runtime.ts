import { leftProcessesRunning, TransportError, type ProviderTransport, type TransportRequest, type TransportResponse } from "./transport-contract.js";
import { setTimeout as delay } from "node:timers/promises";
import { RateLimitScheduler, type SchedulerLease } from "./scheduler.js";
import { ContinuationStateStore } from "./continuation/store.js";
import { sessionContinuationState } from "./continuation/types.js";

export interface InvocationBudget {
  reserve(activityId: string, estimatedTokens: number): BudgetReservation | Promise<BudgetReservation>;
  recordActual(activityId: string, usage: TransportResponse["usage"], reservationId?: string): void | Promise<void>;
  /** Charge zero for an attempt that provably consumed nothing. Optional: without it every failure stays charged. */
  release?(activityId: string, reservationId: string, rule: string): void | Promise<void>;
}
export interface BudgetReservation { readonly allowed: boolean; readonly reason?: string; readonly reservationId?: string; }
export interface InvocationTrace {
  readonly activityId: string; readonly providerId: string; readonly modelId: string; readonly transportId: string;
  readonly attempt: number; readonly outcome: "completed" | "retry" | "failed"; readonly errorCode: string | null;
  readonly usage: TransportResponse["usage"] | null;
  /** Present on a failed attempt whose reservation was released: the rule that proved it consumed nothing. */
  readonly released?: string;
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
  /** False when the caller sends less work instead: a call that ran past `timeoutMs` and stopped is not sent again,
   * and fails with ProviderTimeLimitError. Every other failure is retried as usual. Default true. */
  readonly retryTimeouts?: boolean;
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
/**
 * `causeCode` is the shared class of the last attempt's failure (`MALFORMED_RESPONSE`, `INVALID_REQUEST`); `transportCode`
 * is the transport's own code that leads that failure (`CLI_AGENT_TOOL_USE_FORBIDDEN`, `CLI_MODEL_UNAVAILABLE`), or
 * `HTTP_<status>` for a provider's HTTP refusal, so a caller tells failures of one class apart without reading the text.
 */
export class ProviderInvocationFailure extends Error {
  readonly degradedCompleteness = true;
  readonly resumable = true;
  constructor(message: string, readonly attempts: number, readonly causeCode: string, readonly transportCode: string | null = null) { super(message); this.name = "ProviderInvocationFailure"; }
}
/** The code a transport leads its failure's message with (`CLI_MODEL_UNAVAILABLE: …`), or `HTTP_<status>` for `Provider HTTP <status>`. */
function transportCode(error: TransportError): string | null {
  const status = /^Provider HTTP (\d{3})\b/u.exec(error.message)?.[1];
  return status !== undefined ? `HTTP_${status}` : /^([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)(?::|$)/u.exec(error.message)?.[1] ?? null;
}
/**
 * A provider's usage allowance is used up (a subscription's window, an account's credit). Waiting is the only fix, so
 * the run pauses as rate limited, its completed work kept, rather than failing. Observed live (October 21, 2026): the
 * Codex five-hour window ran out at the critic and failed a run whose audit, verification and plan were done.
 */
export class ProviderUsageLimitError extends ProviderInvocationFailure {
  readonly state = "SUSPENDED_RATE_LIMIT" as const;
  constructor(message: string, attempts: number) { super(message, attempts, "QUOTA"); this.name = "ProviderUsageLimitError"; }
}
/**
 * A call ran past its time limit, stopped, and was not sent again, because its caller sends less work instead
 * (`retryTimeouts: false`). A retry sends the same work from nothing. Observed live (veritra, October 25, 2026): 8 of
 * 212 discovery calls ran past 15 minutes, and each was sent again whole.
 */
export class ProviderTimeLimitError extends ProviderInvocationFailure {
  constructor(message: string, attempts: number) { super(message, attempts, "TIMEOUT"); this.name = "ProviderTimeLimitError"; }
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
      let dispatched = false;
      try {
        lease = await this.options.scheduler.acquire(context.providerId, context.estimatedTokens, context.signal);
        if (context.signal.aborted) throw new TransportError("CANCELLED", "Provider request cancelled before dispatch", false);
        attempts = attempt;
        dispatched = true;
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
        const retryable = !timeLimited(error, context) && error instanceof TransportError && error.retryable && attempt <= context.maximumRetries;
        // Release the reservation only when the attempt provably consumed nothing; otherwise it stays charged.
        const evidence = !dispatched ? { consumption: "none" as const, rule: "not_dispatched" } : error instanceof TransportError ? error.evidence : null;
        let released: string | undefined;
        if (evidence?.consumption === "none" && reservation.reservationId !== undefined && this.options.budget.release !== undefined) {
          try { await this.options.budget.release(context.activityId, reservation.reservationId, evidence.rule); released = evidence.rule; } catch { released = undefined; }
        }
        this.options.traces.record({ ...trace(context, attempt, retryable ? "retry" : "failed",
          error instanceof TransportError ? error.code : "UNKNOWN", null), ...(released === undefined ? {} : { released }) });
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
    // Transport messages are bounded and redacted at the source (providerErrorDetail).
    const detail = lastError instanceof TransportError ? `: ${lastError.message.slice(0, 300)}` : "";
    if (code === "QUOTA") throw new ProviderUsageLimitError(`Provider ${context.providerId} reached its usage limit (${code}${detail}); the run pauses with its completed work kept and goes on when resumed after the reset.`, attempts);
    if (timeLimited(lastError, context)) throw new ProviderTimeLimitError(`Provider ${context.providerId}: the call ran past its time limit of ${context.timeoutMs} ms and stopped (${code}${detail}); it is not sent again, since its stage sends less work instead.`, attempts);
    throw new ProviderInvocationFailure(`Provider ${context.providerId} failed after ${attempts} attempt${attempts === 1 ? "" : "s"} (${code}${detail}); completed artifacts are preserved and the run may resume with degraded completeness.`, attempts, code, lastError instanceof TransportError ? transportCode(lastError) : null);
  }
}

/** A call that ran past its time limit and stopped, whose caller sends less work instead of sending it again. A send
 * still running after it was cancelled is not one: nothing starts beside it. */
function timeLimited(error: unknown, context: ProviderInvocationContext): boolean {
  return context.retryTimeouts === false && error instanceof TransportError && error.code === "TIMEOUT" && error.retryable;
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
  let sent: Promise<TransportResponse> | undefined;
  try {
    sent = transport.send(request, controller.signal);
    return await Promise.race([sent, timeout, cancelled]);
  } catch (error) {
    if (timedOut) throw sent === undefined ? error : await timedOutSend(sent, milliseconds, timer, cancelled);
    throw error;
  } finally { cancelTimeout(); outer.removeEventListener("abort", abort); }
}

/** How long an aborted CLI may take to end its process tree (taskkill is bounded at 10 s) and remove its directories. */
const STOP_AFTER_TIMEOUT_MS = 30_000;
const STILL_RUNNING = Symbol("still running");
/**
 * The failure of a send its stage timeout aborted, once the send has stopped. Until then its attempt holds its scheduler
 * slot and no retry starts: stage timeouts (600 s) end before a CLI's own (30 minutes), and a retry started at once
 * ran a second CLI beside the first while that one was still being killed, and never saw it report a process tree it
 * could not end. That report fails the call. A send still running after the bound fails it too, without a retry.
 */
async function timedOutSend(sent: Promise<TransportResponse>, milliseconds: number, timer: RuntimeTimer, cancelled: Promise<never>): Promise<TransportError> {
  let cancelWait: () => void = () => {};
  const waited = new Promise<typeof STILL_RUNNING>((resolve) => { cancelWait = timer.timeout(STOP_AFTER_TIMEOUT_MS, () => resolve(STILL_RUNNING)); });
  try {
    const outcome = await Promise.race([sent.then(() => null, (error: unknown) => error), waited, cancelled]);
    if (leftProcessesRunning(outcome)) return outcome;
    if (outcome === STILL_RUNNING) return new TransportError("TIMEOUT", `Provider stage timed out after ${milliseconds}ms, and the call had not stopped ${STOP_AFTER_TIMEOUT_MS}ms after it was cancelled`, false);
    return new TransportError("TIMEOUT", `Provider stage timed out after ${milliseconds}ms`, true);
  } finally { cancelWait(); }
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
