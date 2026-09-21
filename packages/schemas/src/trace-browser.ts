import { z } from "zod";
import type { ModelActivityTraceRecord } from "./model-trace.js";

export const traceQuerySchema = z.strictObject({
  offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  nodeId: z.string().min(1).max(512).optional(),
  modelId: z.string().min(1).max(512).optional(),
  protocolId: z.string().min(1).max(512).optional(),
  outcome: z.enum(["success", "refusal", "error", "cancelled"]).optional(),
  activity: z.string().min(1).max(512).optional(),
});
export type TraceQuery = z.input<typeof traceQuerySchema>;
export interface TraceEntry { readonly traceId: string; readonly trace: ModelActivityTraceRecord }
export interface TracePage {
  readonly entries: readonly TraceEntry[];
  readonly total: number;
  readonly offset: number;
  readonly nextOffset: number | null;
  readonly facets: { readonly nodeIds: readonly string[]; readonly modelIds: readonly string[]; readonly protocolIds: readonly string[] };
}
export interface TraceArtifact { readonly reference: string; readonly content: string; readonly redacted: true }
