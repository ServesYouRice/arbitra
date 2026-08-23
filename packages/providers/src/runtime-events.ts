import { createHash } from "node:crypto";

import { ProviderInvocationFailure, ProviderInvocationRuntime, type ProviderInvocationContext } from "./runtime.js";
import type { TransportRequest, TransportResponse, TransportUsage } from "./transport-contract.js";

export type ModelActivityOutcome = "success" | "refusal" | "error" | "cancelled";
export interface ModelActivityIdentity {
  readonly runId: string;
  readonly nodeId: string;
  readonly activityId: string;
  readonly attempt: number;
  readonly modelId: string;
  readonly modelProfileVersion: string;
  readonly transportId: string;
  readonly transportVersion: string;
  readonly harnessId: string;
  readonly harnessVersion: string;
  readonly harnessPolicyHash: string;
  readonly protocolId: string;
  readonly protocolVersion: string;
  readonly protocolHash: string;
  readonly promptHash: string;
  readonly resolvedProviderConfigHash: string;
  readonly capability: "frontier" | "balanced" | "fast";
  readonly effortRequested: "low" | "medium" | "high" | "xhigh";
  readonly effortResolved: "low" | "medium" | "high" | "xhigh";
  readonly inputArtifactRefs: readonly string[];
  readonly outputArtifactRef: string | null;
}
export interface ActivityMetricInputs {
  readonly inputUsdPerMillionTokens: number | null;
  readonly outputUsdPerMillionTokens: number | null;
  readonly toolCallErrors: number;
  readonly repairCount: number;
  readonly advisorTokens: number | null;
}
export interface ModelActivityTrace extends ModelActivityIdentity {
  readonly schemaVersion: 1;
  readonly durationMs: number;
  readonly tokenUsage: TransportUsage | null;
  readonly costUsd: number | null;
  readonly cacheHitRate: number | null;
  readonly toolCallCount: number;
  readonly toolCallErrors: number;
  readonly repairCount: number;
  readonly refusal: string | null;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly continuationState: { readonly hash: string; readonly byteLength: number; readonly scope: "session" } | null;
  readonly advisorTokens: number | null;
  readonly outcome: ModelActivityOutcome;
}
export interface ModelActivityTerminalEvent { readonly type: "model_activity_terminal"; readonly trace: ModelActivityTrace; }
export interface EventClock { now(): number; }

export class EventEmittingProviderRuntime {
  readonly events: AsyncIterable<ModelActivityTerminalEvent>;
  private readonly stream = new EventStream<ModelActivityTerminalEvent>();
  constructor(private readonly runtime: ProviderInvocationRuntime, private readonly clock: EventClock) { this.events = this.stream; }

  async invoke(
    request: TransportRequest,
    context: ProviderInvocationContext,
    identity: ModelActivityIdentity,
    metrics: ActivityMetricInputs,
  ): Promise<TransportResponse> {
    assertIdentity(context, identity);
    const startedAt = this.clock.now();
    try {
      const result = await this.runtime.invoke(request, context);
      const outcome: ModelActivityOutcome = result.refusal === null ? "success" : "refusal";
      this.emit(terminal(identity, metrics, this.clock.now() - startedAt, outcome, result, null));
      return result;
    } catch (error) {
      const cancelled = context.signal.aborted
        || (error instanceof ProviderInvocationFailure && error.causeCode === "CANCELLED");
      this.emit(terminal(identity, metrics, this.clock.now() - startedAt, cancelled ? "cancelled" : "error", null, error));
      throw error;
    }
  }

  private emit(trace: ModelActivityTrace): void { this.stream.emit(Object.freeze({ type: "model_activity_terminal", trace })); }
}

function terminal(identity: ModelActivityIdentity, metrics: ActivityMetricInputs, durationMs: number,
  outcome: ModelActivityOutcome, response: TransportResponse | null, error: unknown): ModelActivityTrace {
  const usage = response?.usage ?? null;
  return Object.freeze({
    schemaVersion: 1, ...identity, inputArtifactRefs: Object.freeze([...identity.inputArtifactRefs]),
    durationMs: Math.max(0, durationMs), tokenUsage: usage, costUsd: cost(usage, metrics),
    cacheHitRate: cacheHitRate(usage), toolCallCount: response?.toolCalls.length ?? 0,
    toolCallErrors: metrics.toolCallErrors, repairCount: metrics.repairCount,
    refusal: response?.refusal ?? null,
    error: error === null ? null : Object.freeze({ code: errorCode(error), message: error instanceof Error ? error.message : String(error) }),
    continuationState: continuationMetadata(response?.continuation ?? null), advisorTokens: metrics.advisorTokens, outcome,
  });
}
function continuationMetadata(value: string | null): ModelActivityTrace["continuationState"] {
  if (value === null) return null;
  const bytes = new TextEncoder().encode(value);
  return Object.freeze({ hash: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength, scope: "session" });
}
function cacheHitRate(usage: TransportUsage | null): number | null {
  if (usage?.inputTokens === null || usage?.inputTokens === undefined || usage.inputTokens === 0 || usage.cacheReadTokens === null) return null;
  return Math.min(1, usage.cacheReadTokens / usage.inputTokens);
}
function cost(usage: TransportUsage | null, metrics: ActivityMetricInputs): number | null {
  if (usage?.inputTokens === null || usage?.inputTokens === undefined || usage.outputTokens === null
    || metrics.inputUsdPerMillionTokens === null || metrics.outputUsdPerMillionTokens === null) return null;
  return Math.round(((usage.inputTokens * metrics.inputUsdPerMillionTokens
    + usage.outputTokens * metrics.outputUsdPerMillionTokens) / 1_000_000) * 1_000_000) / 1_000_000;
}
function errorCode(error: unknown): string {
  if (error instanceof ProviderInvocationFailure) return error.causeCode;
  return error instanceof Error ? error.name : "UNKNOWN";
}
function assertIdentity(context: ProviderInvocationContext, identity: ModelActivityIdentity): void {
  if (context.activityId !== identity.activityId) throw new Error("TRACE_ACTIVITY_ID_MISMATCH");
  if (context.modelId !== identity.modelId) throw new Error("TRACE_MODEL_ID_MISMATCH");
  if (context.transportId !== identity.transportId) throw new Error("TRACE_TRANSPORT_ID_MISMATCH");
}

class EventStream<T> implements AsyncIterable<T> {
  private readonly queue: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  emit(value: T): void { const waiter = this.waiters.shift(); if (waiter === undefined) this.queue.push(value); else waiter({ value, done: false }); }
  [Symbol.asyncIterator](): AsyncIterator<T> { return { next: async () => {
    const value = this.queue.shift();
    return value === undefined ? new Promise((resolve) => this.waiters.push(resolve)) : { value, done: false };
  } }; }
}
