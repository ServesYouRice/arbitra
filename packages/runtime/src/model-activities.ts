import { createHash } from "node:crypto";
import { canonicalJson } from "@arbitra/core/config/config-store.js";
import { ModelPool, type ModelInvocationResult } from "@arbitra/providers/model-pool.js";
import { ProviderRegistry, type TransportFactoryOptions } from "@arbitra/providers/registry.js";
import { RateLimitScheduler } from "@arbitra/providers/scheduler.js";
import { DurableTokenBudget } from "@arbitra/providers/token-budget.js";
import { ContinuationStateStore } from "@arbitra/providers/continuation/store.js";
import type { InvocationTrace } from "@arbitra/providers/runtime.js";
import type { TransportMessage, TransportTool } from "@arbitra/providers/transport-contract.js";
import { runConfigSchema, type RunConfig } from "@arbitra/schemas/config.js";
import { providerExecutionSchema } from "@arbitra/schemas/provider-execution.js";
import { redactSecrets } from "@arbitra/security/redaction";
import type { RunStore } from "./run-store.js";
import type { ProtocolIdentity } from "@arbitra/protocols/versioning.js";
import type { PinnedProtocol } from "@arbitra/protocols/registry.js";
import type { ModelActivityTraceRecord } from "@arbitra/persistence/trace.js";

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
}

/** Durable, stateless JSON model calls shared by workflow stages. No tool execution. */
export class ModelActivities {
  readonly #pool: ModelPool;
  readonly #config: RunConfig;
  readonly #execution;
  readonly #traces = new Map<string, InvocationTrace[]>();
  readonly #inflight = new Map<string, { fingerprint: string; promise: Promise<unknown> }>();

  constructor(private readonly store: RunStore, config: RunConfig, options: TransportFactoryOptions = {}) {
    this.#config = runConfigSchema.parse(config);
    this.#execution = providerExecutionSchema.parse(this.#config.workflow["modelExecution"]);
    const execution = this.#execution;
    const registry = new ProviderRegistry(execution.endpoints, options);
    this.#pool = new ModelPool(registry, Object.entries(this.#config.models).map(([id, profile]) => {
      const endpointId = execution.modelEndpoints[id];
      if (endpointId === undefined) throw new Error(`MODEL_ENDPOINT_ABSENT:${id}`);
      return { id, profile, endpointId };
    }), {
      scheduler: new RateLimitScheduler(execution.rateLimits),
      budget: new DurableTokenBudget(execution.maximumTokens, {
        load: () => this.read("model-token-budget"),
        save: async (state) => { await store.publish("model-token-budget", state); },
      }),
      // Each protocol call sends its entire explicit input. Replaying an interrupted
      // call must not silently append it to a provider-side conversation.
      continuation: new ContinuationStateStore({ async load() { return null; }, async save() {} }, { enabled: false, now: () => 0 }),
      traces: { record: (trace) => {
        const traces = this.#traces.get(trace.activityId) ?? [];
        traces.push(trace);
        this.#traces.set(trace.activityId, traces);
      } },
    });
  }

  async invoke<T>(input: ModelActivityRequest<T>): Promise<T> {
    if (!input.activityId.trim() || !input.protocol.trim()) throw new Error("INVALID_MODEL_ACTIVITY_IDENTITY");
    if (input.signal.aborted) throw new Error("MODEL_ACTIVITY_CANCELLED");
    const profile = Object.hasOwn(this.#config.models, input.modelProfileId) ? this.#config.models[input.modelProfileId] : undefined;
    if (profile === undefined) throw new Error(`UNKNOWN_MODEL_PROFILE:${input.modelProfileId}`);
    const redacted = structuredClone(input.messages).map((message) => ({ ...message, content: redactSecrets(message.content).text }));
    const messages = profile.quirks.systemPromptSupport === "full" ? redacted : redacted.map((message) => message.role === "system" ? { ...message, role: "user" as const } : message);
    const fingerprint = hash({ protocol: input.protocol, protocolIdentity: input.protocolIdentity ?? null, modelProfileId: input.modelProfileId, profile, execution: this.#execution, messages, effort: input.effort ?? null, responseMode: input.responseMode ?? "json", tools: input.tools ?? [], harnessIdentity: input.harnessIdentity ?? null, sourcePaths: input.sourcePaths === undefined ? null : [...input.sourcePaths].sort() });
    const key = `model-activity-${hash(input.activityId)}`;
    const inflight = this.#inflight.get(key);
    if (inflight !== undefined) {
      if (inflight.fingerprint !== fingerprint) throw new Error("MODEL_ACTIVITY_INPUT_CHANGED");
      return input.schema.parse(await inflight.promise);
    }
    const promise = this.execute(input, messages, fingerprint, key);
    this.#inflight.set(key, { fingerprint, promise });
    try { return await promise; }
    finally { this.#inflight.delete(key); }
  }

  private async execute<T>(input: ModelActivityRequest<T>, messages: readonly TransportMessage[], fingerprint: string, key: string): Promise<T> {
    const profile = this.#config.models[input.modelProfileId];
    if (profile === undefined) throw new Error("TRACE_PROFILE_ABSENT");
    const existing = await this.read(key) as { fingerprint?: unknown; value?: unknown } | null;
    if (existing !== null) {
      if (existing.fingerprint !== fingerprint) throw new Error("MODEL_ACTIVITY_INPUT_CHANGED");
      return input.schema.parse(existing.value);
    }
    // Record identity before spend so a failed or interrupted activity cannot be
    // resumed with a different prompt/profile under the same durable activity ID.
    const identity = await this.read(`${key}-input`) as { fingerprint?: unknown } | null;
    if (identity !== null && identity.fingerprint !== fingerprint) throw new Error("MODEL_ACTIVITY_INPUT_CHANGED");
    const requestArtifact = await this.store.publish(`${key}-input`, { activityId: input.activityId, fingerprint, protocol: input.protocol, modelProfileId: input.modelProfileId, messages, tools: input.tools ?? [] });
    const maximumOutputTokens = this.#execution.maximumOutputTokens;
    // UTF-8 bytes provide a conservative admission estimate, not actual token usage.
    const estimatedTokens = Buffer.byteLength(JSON.stringify({ messages, tools: input.tools ?? [] }), "utf8") + maximumOutputTokens;
    let result: ModelInvocationResult | undefined;
    let value: T;
    let outputValidated = false;
    let failure: unknown = null;
    let outputArtifactRef: string | null = null;
    const startedAt = Date.now();
    try {
      result = await this.#pool.invoke({ messages, maximumOutputTokens, ...(input.tools === undefined ? {} : { tools: input.tools }) }, {
        activityId: input.activityId, modelProfileId: input.modelProfileId, estimatedTokens,
        maximumRetries: this.#execution.maximumRetries, timeoutMs: this.#execution.timeoutMs,
        signal: input.signal, ...(input.effort === undefined ? {} : { effort: input.effort }),
      });
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
        harnessId: input.harnessIdentity?.id ?? "direct-json", harnessVersion: input.harnessIdentity?.version ?? "1.0.0", harnessPolicyHash: input.harnessIdentity?.policyHash ?? hash({ tools: input.tools ?? [] }),
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
        continuationState: null, advisorTokens: null, outcome,
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
        },
      }, input.activityId);
    }
    await this.store.publish(key, { fingerprint, value }, input.activityId);
    return value;
  }

  private async read(kind: string): Promise<unknown> {
    const artifact = (await this.store.listArtifacts()).find((item) => item.kind === kind);
    return artifact === undefined ? null : JSON.parse((await this.store.readArtifact(artifact.artifactId)).content) as unknown;
  }
}

function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
