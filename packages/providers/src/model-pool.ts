import { resolveEffort, type EffortLevel, type EffortResolution } from "./effort.js";
import type { ModelProfile } from "./profiles/model-profile.js";
import { ProviderRegistry } from "./registry.js";
import { ProviderInvocationRuntime, type ProviderRuntimeOptions } from "./runtime.js";
import type { TransportRequest, TransportResponse } from "./transport-contract.js";

export interface PoolModel {
  readonly id: string;
  readonly endpointId: string;
  readonly profile: Pick<ModelProfile, "provider" | "transport" | "modelId" | "effort" | "limits" | "supports">;
}

export interface ModelInvocation {
  readonly activityId: string;
  readonly modelProfileId: string;
  /** Estimated total admission, including the output reserve. Not reported as actual usage. */
  readonly estimatedTokens: number;
  readonly maximumRetries: number;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly effort?: EffortLevel;
}

export interface ModelInvocationResult {
  readonly response: TransportResponse;
  readonly modelProfileId: string;
  readonly endpointId: string;
  readonly providerId: string;
  readonly transport: string;
  readonly modelId: string;
  readonly effort: EffortResolution | null;
}

/** A single invocation path for heterogeneous models, including compatible endpoints. */
export class ModelPool {
  readonly #models = new Map<string, PoolModel>();
  readonly #runtime: ProviderInvocationRuntime;

  constructor(private readonly registry: ProviderRegistry, models: readonly PoolModel[], options: Omit<ProviderRuntimeOptions, "transports">) {
    for (const model of models) {
      if (model.id.trim() === "" || this.#models.has(model.id)) throw new Error(`INVALID_POOL_MODEL_ID:${model.id}`);
      registry.binding(model.endpointId, { providerId: model.profile.provider, transport: model.profile.transport });
      // Copy nested profile data so edits to an open configuration cannot change an in-flight run.
      this.#models.set(model.id, structuredClone(model));
    }
    this.#runtime = new ProviderInvocationRuntime({ ...options, transports: registry.transports });
  }

  async invoke(request: Omit<TransportRequest, "modelId" | "effortParams" | "continuation">, invocation: ModelInvocation): Promise<ModelInvocationResult> {
    const model = this.#models.get(invocation.modelProfileId);
    if (model === undefined) throw new Error(`UNKNOWN_MODEL_PROFILE:${invocation.modelProfileId}`);
    const profile = model.profile;
    if (!Number.isSafeInteger(request.maximumOutputTokens) || request.maximumOutputTokens < 1) throw new Error("INVALID_MAXIMUM_OUTPUT_TOKENS");
    if (profile.limits.maxOutputTokens !== null && request.maximumOutputTokens > profile.limits.maxOutputTokens) throw new Error("MODEL_OUTPUT_LIMIT_EXCEEDED");
    if (invocation.estimatedTokens < request.maximumOutputTokens) throw new Error("OUTPUT_RESERVE_MISSING_FROM_ESTIMATE");
    if (profile.limits.contextTokens !== null && invocation.estimatedTokens > profile.limits.contextTokens) throw new Error("MODEL_CONTEXT_LIMIT_EXCEEDED");
    if ((request.tools?.length ?? 0) > 0 && !profile.supports.tools) throw new Error("MODEL_TOOLS_NOT_SUPPORTED");
    if (request.responseSchema !== undefined && !profile.supports.structuredOutput) throw new Error("MODEL_STRUCTURED_OUTPUT_NOT_SUPPORTED");
    const effort = invocation.effort === undefined ? null : resolveEffort(profile, invocation.effort);
    const binding = this.registry.binding(model.endpointId);
    const response = await this.#runtime.invoke({ ...request, modelId: profile.modelId, ...(effort === null ? {} : { effortParams: effort.params }) }, {
      activityId: invocation.activityId,
      providerId: binding.providerId,
      // Continuation identity must bind to the actual service, not merely a shared codec.
      transportId: binding.id,
      modelId: profile.modelId,
      estimatedTokens: invocation.estimatedTokens,
      maximumRetries: invocation.maximumRetries,
      timeoutMs: invocation.timeoutMs,
      signal: invocation.signal,
    });
    return Object.freeze({ response, modelProfileId: model.id, endpointId: binding.id,
      providerId: binding.providerId, transport: binding.transport, modelId: profile.modelId, effort });
  }
}
