import { createHash } from "node:crypto";
import { canonicalJson } from "@arbitra/core/config/config-store.js";
import { ModelPool, type ModelInvocationResult } from "@arbitra/providers/model-pool.js";
import { ProviderRegistry, type TransportFactoryOptions } from "@arbitra/providers/registry.js";
import { RateLimitScheduler } from "@arbitra/providers/scheduler.js";
import { DurableTokenBudget } from "@arbitra/providers/token-budget.js";
import { ContinuationStateStore } from "@arbitra/providers/continuation/store.js";
import { ProviderBudgetSuspendedError, ProviderInvocationFailure, type InvocationTrace, type TraceSink } from "@arbitra/providers/runtime.js";
import { BatchItemFailedError, BatchLane, type BatchSubmissionRecord } from "@arbitra/providers/batch/lane.js";
import { ModelOutputLimitError } from "./context-budget.js";
import type { TransportMessage, TransportTool } from "@arbitra/providers/transport-contract.js";
import { runConfigSchema, type RunConfig } from "@arbitra/schemas/config.js";
import { providerExecutionSchema } from "@arbitra/schemas/provider-execution.js";
import { redactSecrets } from "@arbitra/security/redaction";
import type { RunStore } from "./run-store.js";
import type { ProtocolIdentity } from "@arbitra/protocols/versioning.js";
import type { PinnedProtocol } from "@arbitra/protocols/registry.js";
import type { ModelActivityTraceRecord } from "@arbitra/persistence/trace.js";
import { batchLaneFor, runStoreBatchBackend, validateBatchLanes } from "./model-batch-lane.js";

export interface ModelActivityRequest<T> {
  readonly activityId: string;
  readonly modelProfileId: string;
  readonly messages: readonly TransportMessage[];
  readonly signal: AbortSignal;
  readonly effort?: "low" | "medium" | "high" | "xhigh";
  /** Protocol/schema version is part of the durable request identity. */
  readonly protocol: string;
  readonly protocolIdentity?: ProtocolIdentity;
  readonly schema: { parse(value: unknown): T };
  readonly responseMode?: "json" | "harness_turn";
  readonly tools?: readonly TransportTool[];
  readonly protocolAsset?: PinnedProtocol;
  readonly outputSchema?: unknown;
  readonly sourcePaths?: readonly string[];
  readonly harnessIdentity?: { readonly id: string; readonly version: string; readonly policyHash: string };
  /** Per-request output reserve; defaults to the run's configured reserve. Part of the identity. */
  readonly maximumOutputTokens?: number;
  /** Marks a bounded advisor call. It is traced under the advisor's own identity. */
  readonly advisor?: AdvisorActivityIdentity;
  /** Return a completed durable result or fail; never dispatch a provider request. */
  readonly replayOnly?: boolean;
}

export interface AdvisorActivityIdentity {
  readonly executorActivityId: string;
  readonly taskId: string;
  readonly useOrdinal: number;
}

export const ADVISOR_HARNESS_ID = "advisor-direct";

/**
 * A replay run's view of its immutable source run. It answers whether one activity may
 * reuse the source output: only when the activity's stage is compatible under the mode's
 * replay contract and the saved output was produced under the same replay identity.
 */
export interface ActivityReplaySource {
  lookup(request: { readonly activityId: string; readonly key: string; readonly replayIdentity: string }): Promise<{ readonly value: unknown; readonly sourceRunId: string; readonly sourceArtifactId: string } | null>;
  /** Record that a looked-up output could not be used after all, e.g. it fails its schema. */
  reject(request: { readonly activityId: string; readonly key: string }, reason: string): Promise<void>;
}

/** Durable, stateless JSON model calls shared by workflow stages. No tool execution. */
export class ModelActivities {
  readonly #pool: ModelPool;
  readonly #config: RunConfig;
  readonly #execution;
  readonly #traces = new Map<string, InvocationTrace[]>();
  readonly #inflight = new Map<string, { fingerprint: string; promise: Promise<unknown> }>();
  /** Present only when `workflow.modelExecution.batch` explicitly configures a lane. */
  readonly #batch: BatchLane | null;
  readonly #replay: ActivityReplaySource | undefined;
  readonly #budget: DurableTokenBudget;

  constructor(private readonly store: RunStore, config: RunConfig, options: TransportFactoryOptions = {}, replay?: ActivityReplaySource) {
    this.#replay = replay;
    this.#config = runConfigSchema.parse(config);
    this.#execution = providerExecutionSchema.parse(this.#config.workflow["modelExecution"]);
    const execution = this.#execution;
    const registry = new ProviderRegistry(execution.endpoints, options);
    const budget = new DurableTokenBudget(execution.maximumTokens, {
      load: () => this.read("model-token-budget"),
      save: async (state) => { await store.publish("model-token-budget", state); },
    });
    this.#budget = budget;
    const traces: TraceSink = { record: (trace) => {
      const traces = this.#traces.get(trace.activityId) ?? [];
      traces.push(trace);
      this.#traces.set(trace.activityId, traces);
    } };
    this.#pool = new ModelPool(registry, Object.entries(this.#config.models).map(([id, profile]) => {
      const endpointId = execution.modelEndpoints[id];
      if (endpointId === undefined) throw new Error(`MODEL_ENDPOINT_ABSENT:${id}`);
      return { id, profile, endpointId };
    }), {
      scheduler: new RateLimitScheduler(execution.rateLimits),
      budget,
      // Each protocol call sends its entire explicit input. Replaying an interrupted
      // call must not silently append it to a provider-side conversation.
      continuation: new ContinuationStateStore({ async load() { return null; }, async save() {} }, { enabled: false, now: () => 0 }),
      traces,
    });
    if (execution.batch === undefined) this.#batch = null;
    else {
      validateBatchLanes(this.#config);
      for (const lane of execution.batch.lanes) this.#pool.assertBatchLane(lane.modelProfileId);
      this.#batch = new BatchLane({ namespace: store.runId, driver: (endpointId) => registry.batchDriver(endpointId), budget,
        backend: runStoreBatchBackend(store), traces, requestTimeoutMs: execution.timeoutMs });
    }
  }

  /** Collects late results and retries reconciliation of uncertain submissions. Never resubmits. */
  async reconcileBatches() { return this.#batchLane().reconcile(); }
  async batchSubmissions(): Promise<readonly BatchSubmissionRecord[]> { return this.#batchLane().submissions(); }
  /** Operator decision after checking the provider console for an uncertain submission. */
  async resolveBatchSubmission(submissionId: string, resolution: { readonly providerJobId: string } | { readonly notSubmitted: true }, by: string) {
    return this.#batchLane().resolveUncertain(submissionId, resolution, by);
  }
  #batchLane(): BatchLane {
    if (this.#batch === null) throw new Error("BATCH_LANE_NOT_CONFIGURED");
    return this.#batch;
  }

  async invoke<T>(input: ModelActivityRequest<T>): Promise<T> {
    if (!input.activityId.trim() || !input.protocol.trim()) throw new Error("INVALID_MODEL_ACTIVITY_IDENTITY");
    if (input.signal.aborted) throw new Error("MODEL_ACTIVITY_CANCELLED");
    if (input.maximumOutputTokens !== undefined && (!Number.isSafeInteger(input.maximumOutputTokens) || input.maximumOutputTokens < 1)) throw new Error("INVALID_MAXIMUM_OUTPUT_TOKENS");
    if (input.advisor !== undefined) {
      // Round-zero discovery is independent: an advisor is structurally unavailable there.
      if (isDiscoveryActivity(input.activityId) || isDiscoveryActivity(input.advisor.executorActivityId)) throw new Error("ADVISOR_DISABLED_IN_DISCOVERY");
      if ((input.tools?.length ?? 0) > 0 || input.responseMode === "harness_turn") throw new Error("ADVISOR_TOOLS_FORBIDDEN");
    }
    const profile = Object.hasOwn(this.#config.models, input.modelProfileId) ? this.#config.models[input.modelProfileId] : undefined;
    if (profile === undefined) throw new Error(`UNKNOWN_MODEL_PROFILE:${input.modelProfileId}`);
    const redacted = structuredClone(input.messages).map((message) => ({ ...message, content: redactSecrets(message.content).text }));
    const messages = profile.quirks.systemPromptSupport === "full" ? redacted : redacted.map((message) => message.role === "system" ? { ...message, role: "user" as const } : message);
    const fingerprint = hash({ protocol: input.protocol, protocolIdentity: input.protocolIdentity ?? null, modelProfileId: input.modelProfileId, profile, execution: this.#execution, messages, effort: input.effort ?? null, responseMode: input.responseMode ?? "json", tools: input.tools ?? [], harnessIdentity: input.harnessIdentity ?? null, sourcePaths: input.sourcePaths === undefined ? null : [...input.sourcePaths].sort(),
      ...(input.maximumOutputTokens === undefined ? {} : { maximumOutputTokens: input.maximumOutputTokens }), ...(input.advisor === undefined ? {} : { advisor: input.advisor }) });
    const replayIdentity = this.#replayIdentity(input, profile, messages);
    const key = `model-activity-${hash(input.activityId)}`;
    const inflight = this.#inflight.get(key);
    if (inflight !== undefined) {
      if (inflight.fingerprint !== fingerprint) throw new Error("MODEL_ACTIVITY_INPUT_CHANGED");
      return input.schema.parse(await inflight.promise);
    }
    const promise = this.execute(input, messages, fingerprint, key, replayIdentity);
    this.#inflight.set(key, { fingerprint, promise });
    try { return await promise; }
    finally { this.#inflight.delete(key); }
  }

  /**
   * The identity a replay compares: the complete request and the model/endpoint that
   * answers it, but not run-local budget, retry, rate or lane settings, which cannot change
   * the meaning of a saved output.
   */
  #replayIdentity(input: ModelActivityRequest<unknown>, profile: unknown, messages: readonly TransportMessage[]): string {
    const endpointId = this.#execution.modelEndpoints[input.modelProfileId];
    return hash({ protocol: input.protocol, protocolIdentity: input.protocolIdentity ?? null, modelProfileId: input.modelProfileId, profile,
      endpoint: this.#execution.endpoints.find(({ id }) => id === endpointId) ?? null, maximumOutputTokens: input.maximumOutputTokens ?? this.#execution.maximumOutputTokens,
      messages, effort: input.effort ?? null, responseMode: input.responseMode ?? "json", tools: input.tools ?? [], harnessIdentity: input.harnessIdentity ?? null,
      sourcePaths: input.sourcePaths === undefined ? null : [...input.sourcePaths].sort() });
  }

  private async execute<T>(input: ModelActivityRequest<T>, messages: readonly TransportMessage[], fingerprint: string, key: string, replayIdentity: string): Promise<T> {
    const profile = this.#config.models[input.modelProfileId];
    if (profile === undefined) throw new Error("TRACE_PROFILE_ABSENT");
    const existing = await this.read(key) as { fingerprint?: unknown; value?: unknown } | null;
    if (existing !== null) {
      if (existing.fingerprint !== fingerprint) throw new Error("MODEL_ACTIVITY_INPUT_CHANGED");
      return input.schema.parse(existing.value);
    }
    if (input.replayOnly === true) throw new Error("MODEL_ACTIVITY_NOT_COMPLETED");
    // A replay run consults its source only for activities it has not started itself.
    if (this.#replay !== undefined && await this.read(`${key}-input`) === null) {
      const reused = await this.#replay.lookup({ activityId: input.activityId, key, replayIdentity });
      if (reused !== null) {
        let value: T | undefined;
        try { value = input.schema.parse(reused.value); }
        catch { await this.#replay.reject({ activityId: input.activityId, key }, "source_output_invalid"); }
        if (value !== undefined) {
          // Reuse makes no provider call and charges no budget in this run. Provenance names
          // the immutable source artifact the output came from.
          await this.store.publish(key, { fingerprint, value, replayIdentity, replayedFrom: { runId: reused.sourceRunId, artifactId: reused.sourceArtifactId } }, input.activityId);
          return value;
        }
      }
    }
    // Record identity before spend so a failed or interrupted activity cannot be
    // resumed with a different prompt/profile under the same durable activity ID.
    const identity = await this.read(`${key}-input`) as { fingerprint?: unknown } | null;
    if (identity !== null && identity.fingerprint !== fingerprint) throw new Error("MODEL_ACTIVITY_INPUT_CHANGED");
    const requestArtifact = await this.store.publish(`${key}-input`, { activityId: input.activityId, fingerprint, protocol: input.protocol, modelProfileId: input.modelProfileId, messages, tools: input.tools ?? [] });
    const maximumOutputTokens = input.maximumOutputTokens ?? this.#execution.maximumOutputTokens;
    // UTF-8 bytes provide a conservative admission estimate, not actual token usage.
    const estimatedTokens = Buffer.byteLength(JSON.stringify({ messages, tools: input.tools ?? [] }), "utf8") + maximumOutputTokens;
    let result: ModelInvocationResult | undefined;
    let value: T;
    let outputValidated = false;
    let failure: unknown = null;
    let outputArtifactRef: string | null = null;
    const startedAt = Date.now();
    try {
      const invocation = {
        activityId: input.activityId, modelProfileId: input.modelProfileId, estimatedTokens,
        maximumRetries: this.#execution.maximumRetries, timeoutMs: this.#execution.timeoutMs,
        signal: input.signal, ...(input.effort === undefined ? {} : { effort: input.effort }),
      };
      const request = { messages, maximumOutputTokens, ...(input.tools === undefined ? {} : { tools: input.tools }) };
      // Only explicitly configured (model, node) pairs use the batch lane; tool-bearing
      // requests are interactive by definition and never move onto it.
      const lane = this.#batch === null || (input.tools?.length ?? 0) > 0 || input.advisor !== undefined ? undefined : batchLaneFor(this.#execution, input.modelProfileId, input.activityId);
      result = this.#batch === null || lane === undefined ? await this.#pool.invoke(request, invocation)
        : await this.#pool.invokeBatch(request, { ...invocation, lane: this.#batch, settings: lane, fingerprint, traceId: key });
      const harnessTurn = input.responseMode === "harness_turn";
      if (!harnessTurn && result.response.refusal !== null) throw new Error("MODEL_ACTIVITY_REFUSED");
      if (!harnessTurn && result.response.toolCalls.length > 0) throw new Error("MODEL_ACTIVITY_UNEXPECTED_TOOL_CALLS");
      let parsed: unknown = harnessTurn ? { text: result.response.text, toolCalls: result.response.toolCalls, refusal: result.response.refusal, usage: result.response.usage } : result.response.structured;
      if (!harnessTurn && parsed === null) {
        try { parsed = JSON.parse(result.response.text ?? ""); }
        catch { throw new Error("MODEL_ACTIVITY_INVALID_JSON"); }
      }
      // Always return the same redacted payload that a resumed call will receive.
      const safe = JSON.parse(JSON.stringify(parsed, (_key, value: unknown) => typeof value === "string" ? redactSecrets(value).text : value)) as unknown;
      // Nested tool arguments are schema-opaque. Canonicalize them before first use
      // so artifact serialization cannot change later model-history fingerprints.
      value = input.schema.parse(JSON.parse(canonicalJson(safe)));
      outputValidated = true;
      outputArtifactRef = (await this.store.artifacts.put({ fingerprint, value }, "json", { durability: "expensive" })).relativePath;
    } catch (error) {
      failure = error;
      // A response cut at the output ceiling is incomplete, not merely malformed.
      if (error instanceof ProviderInvocationFailure && error.causeCode === "OUTPUT_LIMIT" || error instanceof BatchItemFailedError && error.code === "OUTPUT_LIMIT") throw new ModelOutputLimitError(input.activityId);
      throw error;
    } finally {
      const traces = this.#traces.get(input.activityId) ?? [];
      this.#traces.delete(input.activityId);
      const prior = await this.read(`${key}-trace`) as { attempts?: InvocationTrace[]; executions?: number } | null;
      const executions = await this.store.nextModelTraceAttempt(input.activityId);
      const endpointId = this.#execution.modelEndpoints[input.modelProfileId];
      const endpoint = this.#execution.endpoints.find(({ id }) => id === endpointId);
      const refusal = result?.response.refusal ?? null;
      const outcome = input.signal.aborted ? "cancelled" : refusal !== null ? "refusal" : failure !== null ? "error" : "success";
      const usage = traces.length > 1 ? null : result?.response.usage ?? null;
      const fullTrace: ModelActivityTraceRecord = {
        schemaVersion: 1, runId: this.store.runId, nodeId: input.activityId.split("/")[0] ?? input.activityId, activityId: input.activityId, attempt: executions,
        modelId: profile.modelId, modelProfileVersion: hash(profile), transportId: profile.transport, transportVersion: "1.0.0",
        harnessId: input.advisor !== undefined ? ADVISOR_HARNESS_ID : input.harnessIdentity?.id ?? "direct-json", harnessVersion: input.harnessIdentity?.version ?? "1.0.0", harnessPolicyHash: input.harnessIdentity?.policyHash ?? hash({ tools: input.tools ?? [] }),
        protocolId: input.protocolIdentity?.protocolId ?? input.protocol.split("@")[0] ?? input.protocol,
        protocolVersion: input.protocolIdentity?.protocolVersion ?? input.protocol.split("@")[1] ?? "unversioned",
        protocolHash: input.protocolIdentity?.protocolHash ?? hash(input.protocol), promptHash: hash({ messages, tools: input.tools ?? [] }), resolvedProviderConfigHash: hash({ endpoint, modelId: profile.modelId, effort: result?.effort ?? null }),
        capability: profile.capabilityTier, effortRequested: input.effort ?? null, effortResolved: result?.effort?.applied ?? null,
        inputArtifactRefs: [requestArtifact.ref.relativePath], outputArtifactRef,
        durationMs: Math.max(0, Date.now() - startedAt), tokenUsage: usage, costUsd: null,
        cacheHitRate: usage?.inputTokens != null && usage.inputTokens > 0 && usage.cacheReadTokens !== null ? Math.min(1, usage.cacheReadTokens / usage.inputTokens) : null,
        toolCallCount: result?.response.toolCalls.length ?? 0, toolCallErrors: 0, repairCount: 0,
        refusal: outcome === "refusal" ? refusal : null,
        error: outcome === "error" || outcome === "cancelled" ? { code: outcome === "cancelled" ? "CANCELLED" : failure instanceof Error ? failure.name : "UNKNOWN", message: failure instanceof Error ? failure.message : outcome } : null,
        continuationState: null, outcome,
        // Advisor calls are separate traces; their total is null whenever either side is unreported.
        advisorTokens: input.advisor === undefined || usage?.inputTokens == null || usage.outputTokens == null ? null : usage.inputTokens + usage.outputTokens,
      };
      await this.store.recordModelTrace(fullTrace);
      await this.store.publish(`${key}-trace`, {
        activityId: input.activityId, protocol: input.protocol, fingerprint,
        protocolIdentity: input.protocolIdentity ?? null,
        modelProfileId: input.modelProfileId,
        outputValidated,
        executions, terminal: fullTrace,
        attempts: [...(prior?.attempts ?? []), ...traces],
        provenance: result === undefined ? null : {
          endpointId: result.endpointId, providerId: result.providerId, transport: result.transport,
          modelId: result.modelId, effort: result.effort, usage: result.response.usage,
          structuredOutputTier: result.response.structuredOutputTier, providerRequestId: result.response.providerRequestId,
          lane: result.batch === undefined ? "interactive" : "batch", ...(result.batch === undefined ? {} : { batch: result.batch }),
        },
      }, input.activityId);
    }
    await this.store.publish(key, { fingerprint, value, replayIdentity }, input.activityId);
    return value;
  }

  /**
   * Charge an activity that runs outside the provider pool (a native harness process)
   * to the same durable run budget. The reservation is committed before launch and
   * stays charged at its full estimate until measured usage replaces it.
   */
  async reserveExternal(activityId: string, estimatedTokens: number): Promise<string> {
    const reservation = await this.#budget.reserve(activityId, estimatedTokens);
    if (!reservation.allowed || reservation.reservationId === undefined) throw new ProviderBudgetSuspendedError(reservation.reason ?? "Run token budget exhausted");
    return reservation.reservationId;
  }

  /** Record harness-reported usage for an external reservation. Partial usage never lowers the charge below the estimate. */
  async recordExternalUsage(activityId: string, reservationId: string, usage: NonNullable<InvocationTrace["usage"]>): Promise<void> {
    await this.#budget.recordActual(activityId, usage, reservationId);
  }

  /** Measured usage of a finished activity: null means unknown, never zero. Absent trace → undefined. */
  async activityUsage(activityId: string): Promise<{ readonly usage: InvocationTrace["usage"] | null; readonly outcome: string } | undefined> {
    const trace = await this.read(`model-activity-${hash(activityId)}-trace`) as { terminal?: ModelActivityTraceRecord } | null;
    if (trace?.terminal === undefined) return undefined;
    return { usage: trace.terminal.tokenUsage, outcome: trace.terminal.outcome };
  }

  private async read(kind: string): Promise<unknown> {
    const artifact = (await this.store.listArtifacts()).find((item) => item.kind === kind);
    return artifact === undefined ? null : JSON.parse((await this.store.readArtifact(artifact.artifactId)).content) as unknown;
  }
}

function isDiscoveryActivity(activityId: string): boolean { return activityId.endsWith("/discovery") || activityId.split("/").includes("discovery"); }
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
