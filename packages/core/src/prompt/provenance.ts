import { createHash } from "node:crypto";
import type { ProtocolPin } from "./layers.js";

export interface PromptProvenance extends ProtocolPin {
  readonly nodeId: string; readonly modelId: string; readonly overrides: { readonly before: string | null; readonly after: string | null };
  readonly promptHash: string; readonly redactionCount: number;
}
export interface RenderedPromptProvenance { readonly auditorId: string; readonly renderedPromptHash: string }
export function renderedPromptProvenance(auditorId: string, renderedBytes: Uint8Array): RenderedPromptProvenance {
  if (auditorId.trim() === "") throw new Error("Auditor id is required for rendered prompt provenance.");
  return Object.freeze({ auditorId, renderedPromptHash: createHash("sha256").update(renderedBytes).digest("hex") });
}
