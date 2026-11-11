import { createHash } from "node:crypto";
import { checkApiKey, type KeyCheck } from "@arbitra/providers/key-check.js";
import type { HttpClient } from "@arbitra/providers/transport-contract.js";
import type { RunConfig } from "@arbitra/schemas/config.js";
import { providerExecutionSchema } from "@arbitra/schemas/provider-execution.js";
import { MODEL_IDENTITY_PLACEHOLDER_PREFIX, type PreflightDiagnostic } from "./preflight.js";

/** One API key endpoint of a lineup, as the provider answered for it before the run (see {@link checkApiKey}). */
export interface ApiKeyCheck {
  readonly endpointId: string;
  readonly providerId: string;
  /** The environment variable the key is read from; never its value. */
  readonly variable: string;
  readonly state: KeyCheck["state"];
  readonly models: readonly { readonly profiles: readonly string[]; readonly modelId: string; readonly known: boolean | null }[];
  readonly detail: string | null;
  readonly cost: KeyCheck["cost"];
}

export interface ApiKeyCheckOptions {
  readonly credential: (environmentName: string) => string | undefined;
  readonly client?: HttpClient;
  readonly signal?: AbortSignal;
  /** Accepted answers, kept for {@link ACCEPTED_KEPT_MS}; by default one shared by this process. */
  readonly cache?: Map<string, { readonly at: number; readonly check: KeyCheck }>;
  readonly now?: () => number;
}

/** How long an accepted key is believed: the New run page checks again on each edit, and a key is not asked each time. */
export const ACCEPTED_KEPT_MS = 10 * 60 * 1_000;
const shared = new Map<string, { readonly at: number; readonly check: KeyCheck }>();

/**
 * Asks each API key endpoint of a lineup whether it takes the key and knows the models bound to it, without a
 * generation, before Start. A refused key or an unknown model is an error: the run's first call to it would fail. A
 * key the check could not ask about is a note, and the first call tells. A key that is not set is the environment
 * check's (PROVIDER_CREDENTIAL_MISSING), so it is not said twice. The key goes only to the provider; what is kept or
 * returned holds its digest at most.
 *
 * Observed live (memoria, November 2026): the Anthropic API route had never run against a current model, and only
 * starting the run showed every call refused.
 */
export async function apiKeyChecks(config: RunConfig, options: ApiKeyCheckOptions): Promise<{ readonly checks: readonly ApiKeyCheck[]; readonly diagnostics: readonly PreflightDiagnostic[] }> {
  const parsed = config.workflow["modelExecution"] === undefined ? undefined : providerExecutionSchema.safeParse(config.workflow["modelExecution"]);
  if (parsed?.success !== true) return { checks: [], diagnostics: [] };
  const execution = parsed.data;
  const cache = options.cache ?? shared; const now = options.now ?? Date.now;
  const results = await Promise.all(execution.endpoints.map(async (endpoint, index) => {
    if (!("apiKeyEnvVar" in endpoint)) return null;
    const profiles = Object.entries(execution.modelEndpoints).filter(([id, endpointId]) => endpointId === endpoint.id && config.models[id] !== undefined).map(([id]) => id);
    if (profiles.length === 0) return null;
    // A template's placeholder is never sent (MODEL_IDENTITY_PLACEHOLDER); the key is still checked.
    const byModel = new Map<string, string[]>();
    for (const id of profiles) {
      const modelId = config.models[id]?.modelId ?? "";
      if (modelId === "" || modelId.startsWith(MODEL_IDENTITY_PLACEHOLDER_PREFIX)) continue;
      byModel.set(modelId, [...(byModel.get(modelId) ?? []), id]);
    }
    const key = options.credential(endpoint.apiKeyEnvVar);
    const identity = createHash("sha256").update(JSON.stringify([endpoint.transport, endpoint.endpoint, endpoint.apiKeyEnvVar, key ?? null, [...byModel.keys()]])).digest("hex");
    const kept = cache.get(identity);
    const check = kept !== undefined && now() - kept.at < ACCEPTED_KEPT_MS ? kept.check
      : await checkApiKey(endpoint, [...byModel.keys()], { credential: options.credential, timeoutMs: 5_000, ...(options.client === undefined ? {} : { client: options.client }), ...(options.signal === undefined ? {} : { signal: options.signal }) });
    if (check === null) return null;
    if (check.state === "accepted" && check.models.every(({ known }) => known !== null)) cache.set(identity, { at: kept?.check === check ? kept.at : now(), check });
    else cache.delete(identity);
    return { index, profiles, check: { endpointId: endpoint.id, providerId: endpoint.providerId, variable: endpoint.apiKeyEnvVar, state: check.state,
      models: check.models.map(({ modelId, known }) => ({ profiles: byModel.get(modelId) ?? [], modelId, known })), detail: check.detail, cost: check.cost } satisfies ApiKeyCheck };
  }));
  const checks: ApiKeyCheck[] = []; const diagnostics: PreflightDiagnostic[] = [];
  const diagnostic = (code: string, severity: PreflightDiagnostic["severity"], path: string, message: string) => diagnostics.push(Object.freeze({ code, severity, scope: "environment", path, message }));
  for (const result of results) {
    if (result === null) continue;
    const { index, profiles, check } = result; checks.push(check);
    const who = `endpoint ${check.endpointId} (profiles ${profiles.join(", ")})`;
    if (check.state === "refused") diagnostic(`PROVIDER_KEY_REFUSED:${check.endpointId}`, "error", `workflow.modelExecution.endpoints.${index}.apiKeyEnvVar`, `${check.providerId} refused the key in ${check.variable} for ${who}${check.detail === null ? "" : `: ${check.detail}`}. Set a key it takes, or bind these profiles to another endpoint.`);
    if (check.state === "unchecked") diagnostic(`PROVIDER_KEY_UNCHECKED:${check.endpointId}`, "warning", `workflow.modelExecution.endpoints.${index}.apiKeyEnvVar`, `The key in ${check.variable} for ${who} could not be checked${check.detail === null ? "" : ` (${check.detail})`}; the run's first call to it tells.`);
    for (const { profiles: users, modelId, known } of check.models) {
      if (known !== false) continue;
      for (const profile of users) diagnostic(`PROVIDER_MODEL_UNKNOWN:${profile}`, "error", `models.${profile}.modelId`, `${check.providerId} has no model "${modelId}" for the key in ${check.variable} (profile ${profile}). Check the model's name, or whether this key's account may use it.`);
    }
  }
  return { checks, diagnostics };
}
