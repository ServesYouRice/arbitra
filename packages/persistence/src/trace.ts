import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJson } from "./canonical-json.js";
import { DEFAULT_FSYNC_POLICY, fsync, type FsyncPolicy, type Fsyncable } from "./fsync.js";

export type TraceOutcome = "success" | "refusal" | "error" | "cancelled";
export interface ModelActivityTraceRecord {
  readonly schemaVersion: 1;
  readonly runId: string; readonly nodeId: string; readonly activityId: string; readonly attempt: number;
  readonly modelId: string; readonly modelProfileVersion: string;
  readonly transportId: string; readonly transportVersion: string;
  readonly harnessId: string; readonly harnessVersion: string; readonly harnessPolicyHash: string;
  readonly protocolId: string; readonly protocolVersion: string; readonly protocolHash: string;
  readonly promptHash: string; readonly resolvedProviderConfigHash: string;
  readonly capability: "frontier" | "balanced" | "fast";
  readonly effortRequested: "low" | "medium" | "high" | "xhigh";
  readonly effortResolved: "low" | "medium" | "high" | "xhigh";
  readonly inputArtifactRefs: readonly string[]; readonly outputArtifactRef: string | null;
  readonly durationMs: number;
  readonly tokenUsage: { readonly inputTokens: number | null; readonly outputTokens: number | null;
    readonly cacheReadTokens: number | null; readonly cacheWriteTokens: number | null } | null;
  readonly costUsd: number | null; readonly cacheHitRate: number | null;
  readonly toolCallCount: number; readonly toolCallErrors: number; readonly repairCount: number;
  readonly refusal: string | null; readonly error: { readonly code: string; readonly message: string } | null;
  readonly continuationState: { readonly hash: string; readonly byteLength: number; readonly scope: "session" } | null;
  readonly advisorTokens: number | null; readonly outcome: TraceOutcome;
}
export interface ModelActivityTerminalEventLike { readonly type: "model_activity_terminal"; readonly trace: ModelActivityTraceRecord; }
interface TraceHandle extends Fsyncable { write(data: Uint8Array): Promise<unknown>; close(): Promise<void>; }
export interface TraceFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  open(path: string, flags: "a"): Promise<TraceHandle>;
}
const nodeFileSystem: TraceFileSystem = { mkdir, open };

export class TraceRecorder {
  private readonly fileSystem: TraceFileSystem;
  private readonly fsyncPolicy: FsyncPolicy;
  constructor(private readonly runsDirectory: string, options: { readonly fileSystem?: TraceFileSystem; readonly fsyncPolicy?: FsyncPolicy } = {}) {
    this.fileSystem = options.fileSystem ?? nodeFileSystem; this.fsyncPolicy = options.fsyncPolicy ?? DEFAULT_FSYNC_POLICY;
  }
  async record(trace: ModelActivityTraceRecord): Promise<void> {
    validateTrace(trace);
    const directory = traceDirectory(this.runsDirectory, trace.runId);
    await this.fileSystem.mkdir(directory, { recursive: true });
    const handle = await this.fileSystem.open(join(directory, "model-activity.jsonl"), "a");
    try {
      await handle.write(new TextEncoder().encode(`${canonicalJson(trace)}\n`));
      await fsync(handle, this.fsyncPolicy, "expensive");
    } finally { await handle.close(); }
  }
  async recordEvent(event: ModelActivityTerminalEventLike): Promise<void> { await this.record(event.trace); }
}

export async function loadActivityTraces(runsDirectory: string, runId: string): Promise<readonly ModelActivityTraceRecord[]> {
  let text: string;
  try { text = await readFile(join(traceDirectory(runsDirectory, runId), "model-activity.jsonl"), "utf8"); }
  catch (error) { if (hasCode(error, "ENOENT")) return []; throw error; }
  const lines = text.split("\n").filter(Boolean);
  return Object.freeze(lines.map((line, index) => {
    let value: unknown;
    try { value = JSON.parse(line) as unknown; } catch (error) { throw new SyntaxError(`Invalid model trace JSON at line ${index + 1}`, { cause: error }); }
    validateTrace(value); return Object.freeze(value);
  }));
}

export function traceDirectory(runsDirectory: string, runId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(runId)) throw new Error("INVALID_TRACE_RUN_ID");
  return join(runsDirectory, runId, "metrics");
}

const requiredKeys = ["schemaVersion", "runId", "nodeId", "activityId", "attempt", "modelId", "modelProfileVersion",
  "transportId", "transportVersion", "harnessId", "harnessVersion", "harnessPolicyHash", "protocolId", "protocolVersion",
  "protocolHash", "promptHash", "resolvedProviderConfigHash", "capability", "effortRequested", "effortResolved",
  "inputArtifactRefs", "outputArtifactRef", "durationMs", "tokenUsage", "costUsd", "cacheHitRate", "toolCallCount",
  "toolCallErrors", "repairCount", "refusal", "error", "continuationState", "advisorTokens", "outcome"] as const;

function validateTrace(value: unknown): asserts value is ModelActivityTraceRecord {
  if (!isObject(value) || Object.keys(value).length !== requiredKeys.length || requiredKeys.some((key) => !(key in value))) throw new Error("INVALID_MODEL_ACTIVITY_TRACE_FIELDS");
  for (const key of ["runId", "nodeId", "activityId", "modelId", "modelProfileVersion", "transportId", "transportVersion",
    "harnessId", "harnessVersion", "harnessPolicyHash", "protocolId", "protocolVersion", "protocolHash", "promptHash",
    "resolvedProviderConfigHash"] as const) if (typeof value[key] !== "string" || value[key].length === 0) throw new Error(`INVALID_MODEL_ACTIVITY_TRACE:${key}`);
  if (!positiveInteger(value.attempt)) throw new Error("INVALID_MODEL_ACTIVITY_TRACE:attempt");
  if (!nonnegative(value.durationMs)) throw new Error("INVALID_MODEL_ACTIVITY_TRACE:durationMs");
  for (const key of ["toolCallCount", "toolCallErrors", "repairCount"] as const) if (!nonnegativeInteger(value[key])) throw new Error(`INVALID_MODEL_ACTIVITY_TRACE:${key}`);
  if (value.schemaVersion !== 1 || !["success", "refusal", "error", "cancelled"].includes(value.outcome as string)) throw new Error("INVALID_MODEL_ACTIVITY_TRACE:outcome");
  if (!["frontier", "balanced", "fast"].includes(value.capability as string)
    || !["low", "medium", "high", "xhigh"].includes(value.effortRequested as string)
    || !["low", "medium", "high", "xhigh"].includes(value.effortResolved as string)) throw new Error("INVALID_MODEL_ACTIVITY_TRACE:routing");
  if (!Array.isArray(value.inputArtifactRefs) || !value.inputArtifactRefs.every((item) => typeof item === "string")) throw new Error("INVALID_MODEL_ACTIVITY_TRACE:inputArtifactRefs");
  if (value.outputArtifactRef !== null && typeof value.outputArtifactRef !== "string") throw new Error("INVALID_MODEL_ACTIVITY_TRACE:outputArtifactRef");
  if (!validUsage(value.tokenUsage) || !nullableNonnegative(value.costUsd)
    || !nullableRate(value.cacheHitRate) || !nullableNonnegative(value.advisorTokens)) throw new Error("INVALID_MODEL_ACTIVITY_TRACE:metrics");
  if (value.outcome === "refusal" && typeof value.refusal !== "string") throw new Error("INVALID_MODEL_ACTIVITY_TRACE:refusal");
  if ((value.outcome === "error" || value.outcome === "cancelled") && !isObject(value.error)) throw new Error("INVALID_MODEL_ACTIVITY_TRACE:error");
  if (value.outcome !== "refusal" && value.refusal !== null) throw new Error("INVALID_MODEL_ACTIVITY_TRACE:unexpectedRefusal");
  if (value.outcome !== "error" && value.outcome !== "cancelled" && value.error !== null) throw new Error("INVALID_MODEL_ACTIVITY_TRACE:unexpectedError");
  if (!validContinuation(value.continuationState)) throw new Error("INVALID_MODEL_ACTIVITY_TRACE:continuationState");
}
function nonnegative(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function positiveInteger(value: unknown): value is number { return nonnegative(value) && Number.isSafeInteger(value) && value >= 1; }
function nonnegativeInteger(value: unknown): value is number { return nonnegative(value) && Number.isSafeInteger(value); }
function nullableNonnegative(value: unknown): value is number | null { return value === null || nonnegative(value); }
function nullableRate(value: unknown): value is number | null { return value === null || (nonnegative(value) && value <= 1); }
function validUsage(value: unknown): boolean {
  return value === null || (isObject(value)
    && ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"].every((key) => key in value && nullableNonnegative(value[key])));
}
function validContinuation(value: unknown): boolean {
  return value === null || (isObject(value) && typeof value["hash"] === "string"
    && nonnegativeInteger(value["byteLength"]) && value["scope"] === "session");
}
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function hasCode(error: unknown, code: string): boolean { return isObject(error) && error["code"] === code; }
