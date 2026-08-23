import { createHash } from "node:crypto";

import type { ContinuationTrace, SessionContinuationState } from "./types.js";
import { sessionContinuationState } from "./types.js";

export interface PersistedContinuation {
  readonly transport: string;
  readonly modelId: string;
  readonly activityId: string;
  readonly opaqueBase64: string;
  readonly opaqueEncoding: "utf8" | "bytes";
  readonly expiresAt: number | null;
}
export interface ContinuationBackend {
  save(key: string, value: PersistedContinuation): Promise<void>;
  load(key: string): Promise<PersistedContinuation | null>;
}
export interface ContinuationStoreOptions {
  readonly enabled: boolean;
  readonly now: () => number;
}

export class ContinuationStateStore {
  constructor(private readonly backend: ContinuationBackend, private readonly options: ContinuationStoreOptions) {}

  async save(activityId: string, state: SessionContinuationState): Promise<ContinuationTrace | null> {
    if (state.activityId !== activityId) throw new Error("CONTINUATION_ACTIVITY_MISMATCH");
    if (!this.options.enabled) return null;
    const bytes = toBytes(state.opaque);
    await this.backend.save(activityId, {
      transport: state.transport, modelId: state.modelId, activityId,
      opaqueBase64: Buffer.from(bytes).toString("base64"),
      opaqueEncoding: typeof state.opaque === "string" ? "utf8" : "bytes",
      expiresAt: state.expiresAt,
    });
    return trace(bytes, state.transport, state.modelId);
  }

  async load(activityId: string, expected: { readonly transport: string; readonly modelId: string }): Promise<SessionContinuationState | null> {
    if (!this.options.enabled) return null;
    const value = await this.backend.load(activityId);
    if (value === null) return null;
    if (value.activityId !== activityId) throw new Error("CONTINUATION_ACTIVITY_MISMATCH");
    if (value.transport !== expected.transport) throw new Error("CONTINUATION_TRANSPORT_BOUNDARY_CROSSING");
    if (value.modelId !== expected.modelId) throw new Error("CONTINUATION_MODEL_BOUNDARY_CROSSING");
    if (value.expiresAt !== null && value.expiresAt <= this.options.now()) return null;
    const bytes = Buffer.from(value.opaqueBase64, "base64");
    return sessionContinuationState({
      transport: value.transport, modelId: value.modelId, activityId,
      opaque: value.opaqueEncoding === "utf8" ? bytes.toString("utf8") : new Uint8Array(bytes),
      expiresAt: value.expiresAt,
    });
  }
}

export function continuationTrace(state: SessionContinuationState): ContinuationTrace {
  return trace(toBytes(state.opaque), state.transport, state.modelId);
}
function trace(bytes: Uint8Array, provider: string, model: string): ContinuationTrace {
  return Object.freeze({ hash: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength,
    scope: "session", provider, model });
}
function toBytes(value: string | Uint8Array): Uint8Array { return typeof value === "string" ? new TextEncoder().encode(value) : value; }
