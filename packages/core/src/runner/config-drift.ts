import { createHash } from "node:crypto";

export interface ProviderConfigRecord { readonly t: "provider_config"; readonly runId: string; readonly hash: string; }
export interface ConfigDriftReport { readonly changed: boolean; readonly previousHash: string | null; readonly currentHash: string; readonly warning: string | null; }

export function resolvedProviderConfigHash(config: unknown): string {
  return createHash("sha256").update(stableJson(removeCredentialValues(config))).digest("hex");
}
export function providerConfigRecord(runId: string, config: unknown): ProviderConfigRecord {
  return Object.freeze({ t: "provider_config", runId, hash: resolvedProviderConfigHash(config) });
}
export function detectConfigDrift(records: readonly ProviderConfigRecord[], resolvedConfig: unknown): ConfigDriftReport {
  const previousHash = records.at(-1)?.hash ?? null;
  const currentHash = resolvedProviderConfigHash(resolvedConfig);
  const changed = previousHash !== null && previousHash !== currentHash;
  return Object.freeze({ changed, previousHash, currentHash,
    warning: changed ? "Resolved provider configuration changed since the recorded run; do not mix results without an explicit restart policy." : null });
}

function removeCredentialValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeCredentialValues);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) =>
    [key, /(?:api.?key|credential|secret|password|accessToken|authToken|bearerToken|tokenValue)$/iu.test(key)
      ? "[CREDENTIAL_VALUE_OMITTED]" : removeCredentialValues(item)]));
}
function stableJson(value: unknown): string { return JSON.stringify(value); }
