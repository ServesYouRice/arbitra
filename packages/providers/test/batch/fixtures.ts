import type { BatchDriver, BatchJobStatus, BatchLookup, BatchRawItemResult, BatchSubmitInput } from "../../src/batch/contract.js";
import { BatchLane, type BatchLaneItem, type BatchLaneSettings, type BatchStateBackend } from "../../src/batch/lane.js";
import type { InvocationTrace, RuntimeTimer } from "../../src/runtime.js";
import { DurableTokenBudget, type TokenBudgetState } from "../../src/token-budget.js";
import type { TransportRequest, TransportResponse, TransportUsage } from "../../src/transport-contract.js";
import { response } from "../../src/transports/json-transport.js";

/** Durable storage that survives "restarts" (new lanes) within one test. */
export class MemoryBackend implements BatchStateBackend {
  readonly values = new Map<string, unknown>();
  async load(key: string): Promise<unknown> { return this.values.has(key) ? structuredClone(this.values.get(key)) : null; }
  async save(key: string, value: unknown): Promise<void> { this.values.set(key, structuredClone(value)); }
  async list(prefix: string): Promise<readonly string[]> { return [...this.values.keys()].filter((key) => key.startsWith(prefix)).sort(); }
}

/** Manual clock: sleeps advance time; timeouts fire when time reaches them (zero-delay ones on the next macrotask). */
export class ManualTimer implements RuntimeTimer {
  now = 1_000;
  readonly sleeps: number[] = [];
  #pending = new Set<{ at: number; callback: () => void }>();
  timeout(milliseconds: number, callback: () => void): () => void {
    const entry = { at: this.now + milliseconds, callback };
    this.#pending.add(entry);
    if (milliseconds === 0) setImmediate(() => this.#fire());
    return () => { this.#pending.delete(entry); };
  }
  async sleep(milliseconds: number): Promise<void> {
    this.sleeps.push(milliseconds);
    this.now += milliseconds;
    this.#fire();
    await new Promise((resolve) => setImmediate(resolve));
  }
  #fire(): void {
    for (const entry of [...this.#pending]) if (entry.at <= this.now) { this.#pending.delete(entry); entry.callback(); }
  }
}

type Body = { readonly text: string; readonly usage?: TransportUsage };

/** A scripted provider batch API. Each hook can be replaced per test. */
export class ScriptedDriver implements BatchDriver {
  readonly id = "scripted-batch";
  readonly transport = "scripted";
  readonly declaration = Object.freeze({ capability: "batch" as const, driverId: "scripted-batch", transport: "scripted", status: "declared_unverified" as const,
    documentation: [], liveValidation: null, reconciliation: "metadata_listing" as const });
  readonly submits: BatchSubmitInput[] = [];
  readonly cancels: string[] = [];
  readonly finds: string[] = [];
  statusCalls = 0;
  onSubmit: (input: BatchSubmitInput) => Promise<{ readonly providerJobId: string }> = async () => ({ providerJobId: `job-${this.submits.length}` });
  onFind: (key: string) => Promise<BatchLookup> = async () => ({ kind: "not_found" });
  onStatus: (jobId: string) => Promise<BatchJobStatus> = async () => ({ ended: true, providerStatus: "ended", jobFailure: null });
  onResults: (jobId: string) => Promise<readonly BatchRawItemResult[]> = async () => this.succeedAll();

  async submit(input: BatchSubmitInput): Promise<{ readonly providerJobId: string }> { this.submits.push(input); return this.onSubmit(input); }
  async find(key: string): Promise<BatchLookup> { this.finds.push(key); return this.onFind(key); }
  async status(jobId: string): Promise<BatchJobStatus> { this.statusCalls += 1; return this.onStatus(jobId); }
  async results(jobId: string): Promise<readonly BatchRawItemResult[]> { return this.onResults(jobId); }
  async cancel(jobId: string): Promise<void> { this.cancels.push(jobId); }
  parse(body: unknown, request: TransportRequest): TransportResponse {
    const value = body as Body;
    return response(request, { text: value.text, ...(value.usage === undefined ? {} : { usage: value.usage }) });
  }
  usage(body: unknown): TransportUsage | null { return (body as Body).usage ?? null; }

  succeedAll(index = this.submits.length - 1): readonly BatchRawItemResult[] {
    return (this.submits[index]?.items ?? []).map(({ customId }) => ({ customId, outcome: "succeeded" as const,
      body: { text: `answer:${customId}`, usage: { inputTokens: 5, outputTokens: 7, cacheReadTokens: null, cacheWriteTokens: null } }, error: null }));
  }
}

export const settings: BatchLaneSettings = { pollIntervalMs: 1_000, maximumWaitMs: 60_000, maximumItemsPerSubmission: 10, collectWindowMs: 0, maximumAttempts: 2 };

export function environment(maximumTokens = 1_000) {
  const backend = new MemoryBackend();
  const timer = new ManualTimer();
  const driver = new ScriptedDriver();
  let budgetState: unknown = null;
  const budgetBackend = { load: async () => structuredClone(budgetState), save: async (state: TokenBudgetState) => { budgetState = structuredClone(state); } };
  const traces: InvocationTrace[] = [];
  const lane = () => new BatchLane({
    namespace: "run-1", driver: () => driver, budget: new DurableTokenBudget(maximumTokens, budgetBackend), backend,
    traces: { record: (trace) => { traces.push(trace); } }, now: () => timer.now, timer, requestTimeoutMs: 5_000,
  });
  const budget = () => new DurableTokenBudget(maximumTokens, budgetBackend).snapshot();
  return { backend, timer, driver, lane, budget, traces };
}

export function item(activityId: string, overrides: Partial<BatchLaneItem> = {}): BatchLaneItem {
  return {
    activityId, traceId: `trace-${activityId}`, fingerprint: `fingerprint-${activityId}`, endpointId: "endpoint", providerId: "provider", modelId: "model",
    request: { modelId: "model", messages: [{ role: "user", content: `question ${activityId}` }], maximumOutputTokens: 10 },
    estimatedTokens: 100, settings, signal: new AbortController().signal, ...overrides,
  };
}

export async function until(condition: () => boolean, limit = 500): Promise<void> {
  for (let index = 0; index < limit; index += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("CONDITION_NOT_REACHED");
}
