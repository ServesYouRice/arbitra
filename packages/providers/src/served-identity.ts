import { createHash } from "node:crypto";

import type { ModelProfile } from "./profiles/model-profile.js";

export function servedIdentity(profile: ModelProfile): string {
  const endpoint = new URL(profile.baseUrl);
  const host = endpoint.host.toLowerCase();
  const resolvedModelId = profile.servedBy ?? profile.modelId;
  return createHash("sha256").update(JSON.stringify([host, resolvedModelId, profile.fingerprint])).digest("hex");
}

export function independenceGroupOf(profile: ModelProfile): string {
  return profile.independenceGroup ?? `singleton:${servedIdentity(profile)}`;
}

export function collapseDuplicateServedIdentities(profiles: readonly ModelProfile[]): readonly ModelProfile[] {
  const seen = new Set<string>();
  return Object.freeze(profiles.filter((profile) => {
    const identity = servedIdentity(profile);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }));
}
