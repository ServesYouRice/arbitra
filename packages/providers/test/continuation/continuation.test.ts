import { describe, expect, it } from "vitest";

import { MemoryCacheHandleStore } from "../../src/cache-handle.js";
import { ContinuationStateStore, continuationTrace, type ContinuationBackend, type PersistedContinuation } from "../../src/continuation/store.js";
import { sessionContinuationState } from "../../src/continuation/types.js";

describe("continuation state boundaries", () => {
  it("throws named errors when transport or model boundaries are crossed", async () => {
    const backend = new MemoryBackend();
    const store = enabledStore(backend);
    await store.save("activity-1", state());
    await expect(store.load("activity-1", { transport: "other", modelId: "model-a" }))
      .rejects.toThrow("CONTINUATION_TRANSPORT_BOUNDARY_CROSSING");
    await expect(store.load("activity-1", { transport: "transport-a", modelId: "other" }))
      .rejects.toThrow("CONTINUATION_MODEL_BOUNDARY_CROSSING");
  });

  it("produces identical artifacts with continuation enabled and disabled", async () => {
    const enabledBackend = new MemoryBackend();
    const disabledBackend = new MemoryBackend();
    const enabled = await integrationRun(enabledStore(enabledBackend));
    const disabled = await integrationRun(new ContinuationStateStore(disabledBackend, { enabled: false, now: () => 100 }));
    expect(enabled.artifact).toEqual(disabled.artifact);
    expect(enabledBackend.values.size).toBe(1);
    expect(disabledBackend.values.size).toBe(0);
    expect(JSON.stringify(enabled.artifact)).not.toContain("opaque-secret-state");
  });

  it("expires normally and records only non-secret trace metadata", async () => {
    const backend = new MemoryBackend();
    const store = new ContinuationStateStore(backend, { enabled: true, now: () => 500 });
    await store.save("activity-1", state(400));
    expect(await store.load("activity-1", { transport: "transport-a", modelId: "model-a" })).toBeNull();
    const metadata = continuationTrace(state());
    expect(metadata).toMatchObject({ byteLength: 19, scope: "session", provider: "transport-a", model: "model-a" });
    expect(JSON.stringify(metadata)).not.toContain("opaque-secret-state");
  });

  it("keeps cache handles separately typed and able to outlive a node", () => {
    const cache = new MemoryCacheHandleStore();
    cache.set("shared-prefix", { transport: "transport-a", modelId: "model-a", cacheKey: "shared-prefix", opaqueHandle: "cache-1", expiresAt: 10_000 });
    expect(cache.get("shared-prefix")).toEqual({ transport: "transport-a", modelId: "model-a", cacheKey: "shared-prefix", opaqueHandle: "cache-1", expiresAt: 10_000 });
  });
});

async function integrationRun(store: ContinuationStateStore) {
  const restored = await store.load("activity-1", { transport: "transport-a", modelId: "model-a" });
  const artifact = { result: [1, 2, 3].reduce((total, value) => total + value, 0), restored: restored !== null };
  await store.save("activity-1", state());
  return { artifact: { ...artifact, restored: false } };
}

function enabledStore(backend: ContinuationBackend) {
  return new ContinuationStateStore(backend, { enabled: true, now: () => 100 });
}

function state(expiresAt: number | null = null) {
  return sessionContinuationState({ transport: "transport-a", modelId: "model-a", activityId: "activity-1", opaque: "opaque-secret-state", expiresAt });
}

class MemoryBackend implements ContinuationBackend {
  readonly values = new Map<string, PersistedContinuation>();
  async save(key: string, value: PersistedContinuation) { this.values.set(key, value); }
  async load(key: string) { return this.values.get(key) ?? null; }
}
