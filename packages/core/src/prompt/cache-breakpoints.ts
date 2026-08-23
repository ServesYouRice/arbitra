import { createHash } from "node:crypto";
import type { PromptLayerName } from "./layers.js";

export interface CacheBreakpoint { readonly afterLayer: PromptLayerName; readonly endByte: number; readonly prefixHash: string }
export function cacheBreakpoint(afterLayer: PromptLayerName, bytes: Uint8Array, endByte: number): CacheBreakpoint {
  return Object.freeze({ afterLayer, endByte, prefixHash: createHash("sha256").update(bytes.subarray(0, endByte)).digest("hex") });
}
