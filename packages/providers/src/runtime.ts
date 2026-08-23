import { TransportError, type ProviderTransport, type TransportRequest, type TransportResponse } from "./transport-contract.js";
import { RateLimitScheduler } from "./scheduler.js";
import { ContinuationStateStore } from "./continuation/store.js";
import { sessionContinuationState } from "./continuation/types.js";

export interface InvocationBudget {
  reserve(activityId: string, estimatedTokens: number): { readonly allowed: boolean; readonly reason?: string };
  recordActual(activityId: string, usage: TransportResponse["usage"]): void;
}
export interface InvocationTrace {
  readonly activityId: string; readonly providerId: string; readonly modelId: string; readonly transportId: string;
  readonly attempt: number; readonly outcome: "completed" | "retry" | "failed"; readonly errorCode: string | null;
  readonly usage: TransportResponse["usage"] | null;
}
export interface TraceSink { record(trace: InvocationTrace): void; }
export interface RuntimeTimer {
  timeout(milliseconds: number, callback: () => void): () => void;
  sleep(milliseconds: number): Promise<void>;
}
const systemTimer: RuntimeTimer = {
  timeout(milliseconds, callback) { const handle = setTimeout(callback, milliseconds); return () => clearTimeout(handle); },
  sleep: async (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
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
    this.timer = options.timer ?? systemTimer; this.maximumBackoffMs = options.maximumBackoffMs ?? 30_000;
  }

  async invoke(request: TransportRequest, context: ProviderInvocationContext): Promise<TransportResponse> {
    validateContext(context);
    const reservation = this.options.budget.reserve(context.activityId, context.estimatedTokens);
    if (!reservation.allowed) throw new ProviderBudgetSuspendedError(reservation.reason ?? "Provider budget preflight refused dispatch");
    const transport = this.options.transports[context.transportId];
    if (transport === undefined) throw new Error(`UNKNOWN_TRANSPORT:${context.transportId}`);
    const restored = await this.options.continuation.load(context.activityId, { transport: context.transportId, modelId: context.modelId });
    const continuation = restored?.opaque;
    const effectiveRequest: TransportRequest = { ...request,
      ...(continuation === undefined ? {} : { continuation: typeof continuation === "string" ? continuation : Buffer.from(continuation).toString("base64") }) };

    let lastError: unknown;
    for (let attempt = 1; attempt <= context.maximumRetries + 1; attempt += 1) {
      const lease = await this.options.scheduler.acquire(context.providerId, context.estimatedTokens);
      try {
        const result = await sendWithTimeout(transport, effectiveRequest, context.signal, context.timeoutMs, this.timer);
        this.options.budget.recordActual(context.activityId, result.usage);
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
        const retryAfter = error.retryAfterMs ?? Math.min(this.maximumBackoffMs, 1_000 * (2 ** (attempt - 1)));
        if (error.code === "RATE_LIMIT") this.options.scheduler.respectRetryAfter(context.providerId, retryAfter);
        await this.timer.sleep(retryAfter);
      } finally { lease.release(); }
    }
    const code = lastError instanceof TransportError ? lastError.code : "UNKNOWN";
    throw new ProviderInvocationFailure(`Provider ${context.providerId} failed after ${context.maximumRetries + 1} attempts (${code}); completed artifacts are preserved and the run may resume with degraded completeness.`, context.maximumRetries + 1, code);
  }
}

async function sendWithTimeout(transport: ProviderTransport, request: TransportRequest, outer: AbortSignal, milliseconds: number, timer: RuntimeTimer): Promise<TransportResponse> {
  const controller = new AbortController();
  const abort = () => controller.abort(outer.reason);
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
    return await Promise.race([transport.send(request, controller.signal), timeout]);
  } catch (error) {
    if (timedOut) throw new TransportError("TIMEOUT", `Provider stage timed out after ${milliseconds}ms`, true);
    throw error;
  } finally { cancelTimeout(); outer.removeEventListener("abort", abort); }
}
function validateContext(value: ProviderInvocationContext): void {
  if (!Number.isSafeInteger(value.maximumRetries) || value.maximumRetries < 0) throw new Error("INVALID_MAXIMUM_RETRIES");
  if (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1) throw new Error("INVALID_STAGE_TIMEOUT");
}
function trace(context: ProviderInvocationContext, attempt: number, outcome: InvocationTrace["outcome"], errorCode: string | null,
  usage: TransportResponse["usage"] | null): InvocationTrace {
  return Object.freeze({ activityId: context.activityId, providerId: context.providerId, modelId: context.modelId,
    transportId: context.transportId, attempt, outcome, errorCode, usage });
}
