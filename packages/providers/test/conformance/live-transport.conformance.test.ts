import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ContinuationStateStore } from "../../src/continuation/store.js";
import { ProviderRegistry, type ProviderEndpoint } from "../../src/registry.js";
import { ProviderInvocationFailure, ProviderInvocationRuntime, type InvocationTrace } from "../../src/runtime.js";
import { RateLimitScheduler } from "../../src/scheduler.js";
import { TransportError, type TransportRequest, type TransportResponse } from "../../src/transport-contract.js";

/**
 * P03 live transport conformance: every case is an ACTUAL invocation through the
 * production registry and invocation runtime, and each observation carries provenance
 * (endpoint, protocol, model, provider request ID, measured usage, time). Opt-in only:
 *
 *   ARBITRA_LIVE_CONFORMANCE=1 ARBITRA_LIVE_ENDPOINTS=tooling/live/endpoints.json \
 *   ARBITRA_LIVE_EVIDENCE=.runs/live/transport.json \
 *     pnpm --filter @arbitra/providers exec vitest run test/conformance/live-transport.conformance.test.ts
 *
 * An endpoint whose credential is absent, rejected or unfunded is recorded as
 * `unavailable` with the provider's error class; it is never counted as passing.
 * Cases a protocol cannot express are `unsupported`; cases not elicited are `not_elicited`.
 */
interface LiveEndpoint extends ProviderEndpoint { readonly modelId: string; readonly continuation?: boolean }
type Status = "passed" | "failed" | "unavailable" | "unsupported" | "not_elicited";
interface Observation {
  readonly endpointId: string; readonly transport: string; readonly providerId: string; readonly modelId: string; readonly endpoint: string;
  readonly case: string; readonly status: Status; readonly detail: string;
  readonly providerRequestIds: readonly string[]; readonly usage: readonly TransportResponse["usage"][];
  readonly traces: readonly Pick<InvocationTrace, "attempt" | "outcome" | "errorCode">[]; readonly observedAt: string; readonly source: "live";
}

const enabled = process.env["ARBITRA_LIVE_CONFORMANCE"] === "1" && process.env["ARBITRA_LIVE_ENDPOINTS"] !== undefined;
const evidencePath = resolve(process.env["ARBITRA_LIVE_EVIDENCE"] ?? ".runs/live/transport-conformance.json");
const observations: Observation[] = [];
const redact = (text: string) => text.replace(/(sk-(?:ant-|proj-)?|AIza|AQ\.)[A-Za-z0-9_.-]{8,}/gu, "$1<redacted>").slice(0, 400);

function harness(endpoint: LiveEndpoint) {
  const registry = new ProviderRegistry([endpoint]);
  const traces: InvocationTrace[] = [];
  const runtime = new ProviderInvocationRuntime({
    transports: registry.transports,
    scheduler: new RateLimitScheduler({ [endpoint.providerId]: { rpm: 30, tpm: 500_000, maxConcurrent: 1 } }),
    budget: { reserve: () => ({ allowed: true }), recordActual() {} },
    continuation: new ContinuationStateStore((() => { const saved = new Map<string, unknown>(); return { async save(id: string, value: unknown) { saved.set(id, value); }, async load(id: string) { return (saved.get(id) ?? null) as never; } }; })(), { enabled: endpoint.continuation === true, now: () => Date.now() }),
    traces: { record: (trace) => traces.push(trace) },
    maximumBackoffMs: 2_000,
  });
  let activity = 0;
  const invoke = (request: Omit<TransportRequest, "modelId">, options: { timeoutMs?: number; maximumRetries?: number; signal?: AbortSignal; activityId?: string } = {}) =>
    runtime.invoke({ ...request, modelId: endpoint.modelId }, { activityId: options.activityId ?? `live/${endpoint.id}/${activity += 1}`, providerId: endpoint.providerId, transportId: endpoint.id, modelId: endpoint.modelId,
      estimatedTokens: 2_000, maximumRetries: options.maximumRetries ?? 2, timeoutMs: options.timeoutMs ?? 60_000, signal: options.signal ?? new AbortController().signal });
  return { invoke, traces };
}

async function observe(endpoint: LiveEndpoint, name: string, body: (context: ReturnType<typeof harness>) => Promise<{ status: Status; detail: string; responses?: readonly TransportResponse[] }>): Promise<Observation> {
  const context = harness(endpoint);
  let result: { status: Status; detail: string; responses?: readonly TransportResponse[] };
  try { result = await body(context); }
  catch (error) {
    const code = error instanceof ProviderInvocationFailure ? error.causeCode : error instanceof TransportError ? error.code : "UNKNOWN";
    result = { status: code === "AUTH" || code === "QUOTA" ? "unavailable" : "failed", detail: `${code}: ${redact(String((error as Error).message))}` };
  }
  const observation: Observation = { endpointId: endpoint.id, transport: endpoint.transport, providerId: endpoint.providerId, modelId: endpoint.modelId, endpoint: endpoint.endpoint,
    case: name, status: result.status, detail: result.detail, providerRequestIds: (result.responses ?? []).flatMap(({ providerRequestId }) => providerRequestId === null ? [] : [providerRequestId]),
    usage: (result.responses ?? []).map(({ usage }) => usage), traces: context.traces.map(({ attempt, outcome, errorCode }) => ({ attempt, outcome, errorCode })), observedAt: new Date().toISOString(), source: "live" };
  observations.push(observation);
  return observation;
}

const endpoints: LiveEndpoint[] = enabled ? JSON.parse(await readFile(resolve(process.env["ARBITRA_LIVE_ENDPOINTS"] ?? ""), "utf8")) as LiveEndpoint[] : [];
const weather = { name: "get_weather", description: "Return the current weather for a city.", inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false } };
const answerSchema = { type: "object", properties: { capital: { type: "string" }, population_millions: { type: "integer" } }, required: ["capital", "population_millions"], additionalProperties: false };
const system = { role: "system" as const, content: "You are a terse assistant used for protocol conformance testing." };

describe.skipIf(!enabled)("P03 live transport conformance", { timeout: 180_000 }, () => {
  describe.each(endpoints)("$id ($transport, $modelId)", (endpoint) => {
    it("completes plain text with measured usage and a provider request identity", async () => {
      const seen = await observe(endpoint, "text", async ({ invoke }) => {
        const response = await invoke({ messages: [system, { role: "user", content: "Reply with exactly the word: pong" }], maximumOutputTokens: 256 });
        const ok = /pong/iu.test(response.text ?? "") && (response.usage.inputTokens ?? 0) > 0 && (response.usage.outputTokens ?? 0) > 0;
        return { status: ok ? "passed" : "failed", detail: `text=${JSON.stringify(response.text?.slice(0, 40))} requestId=${response.providerRequestId === null ? "absent" : "present"}`, responses: [response] };
      });
      expect(["passed", "unavailable"]).toContain(seen.status);
    });

    it("returns schema-valid structured output", async () => {
      const seen = await observe(endpoint, "structured_output", async ({ invoke }) => {
        const response = await invoke({ messages: [system, { role: "user", content: "Give the capital of France and its population in millions (integer)." }], responseSchema: answerSchema, maximumOutputTokens: 512 });
        const value = response.structured as { capital?: unknown; population_millions?: unknown } | null;
        const ok = typeof value?.capital === "string" && /paris/iu.test(value.capital) && Number.isInteger(value.population_millions);
        return { status: ok ? "passed" : "failed", detail: `tier=${response.structuredOutputTier} value=${JSON.stringify(value)}`, responses: [response] };
      });
      expect(["passed", "unavailable"]).toContain(seen.status);
    });

    it("emits a tool call and consumes the tool result", async () => {
      const seen = await observe(endpoint, "tools", async ({ invoke }) => {
        const user = { role: "user" as const, content: "What is the weather in Lisbon? Use the tool, then answer in one sentence." };
        const first = await invoke({ messages: [system, user], tools: [weather], maximumOutputTokens: 512 });
        const call = first.toolCalls[0];
        if (call === undefined || call.name !== "get_weather") return { status: "failed", detail: `no tool call; text=${JSON.stringify(first.text?.slice(0, 60))}`, responses: [first] };
        const second = await invoke({ messages: [system, user, { role: "assistant", content: first.text ?? "", toolCalls: [call] }, { role: "tool", toolCallId: call.id, toolName: call.name, content: '{"condition":"sunny","celsius":24}' }], tools: [weather], maximumOutputTokens: 512 });
        const ok = /lisbon/iu.test(JSON.stringify(call.arguments)) && /24|sunny/iu.test(second.text ?? "");
        return { status: ok ? "passed" : "failed", detail: `arguments=${JSON.stringify(call.arguments)} answer=${JSON.stringify(second.text?.slice(0, 80))}`, responses: [first, second] };
      });
      expect(["passed", "unavailable"]).toContain(seen.status);
    });

    it("classifies a truncated answer as an output-limit failure rather than a complete answer", async () => {
      const seen = await observe(endpoint, "output_limit", async ({ invoke }) => {
        try {
          const response = await invoke({ messages: [system, { role: "user", content: "Count from 1 to 400, one number per line." }], maximumOutputTokens: 16, ...(endpoint.transport === "gemini-native" ? { effortParams: { thinkingBudget: 0 } } : {}) });
          return { status: "failed", detail: `accepted as complete: ${JSON.stringify(response.text?.slice(-30))}`, responses: [response] };
        } catch (error) {
          const code = error instanceof ProviderInvocationFailure ? error.causeCode : "UNKNOWN";
          if (code === "OUTPUT_LIMIT") return { status: "passed", detail: "OUTPUT_LIMIT" };
          throw error;
        }
      });
      expect(["passed", "unavailable"]).toContain(seen.status);
    });

    it("cancels an in-flight request", async () => {
      const seen = await observe(endpoint, "cancellation", async ({ invoke, traces }) => {
        const controller = new AbortController(); setTimeout(() => controller.abort(), 150);
        try { const response = await invoke({ messages: [system, { role: "user", content: "Write a 600-word essay about rivers." }], maximumOutputTokens: 2048 }, { signal: controller.signal }); return { status: "failed", detail: "completed despite cancellation", responses: [response] }; }
        catch (error) { return { status: error instanceof ProviderInvocationFailure && error.causeCode === "CANCELLED" && traces.length === 1 ? "passed" : "failed", detail: `${(error as ProviderInvocationFailure).causeCode}` }; }
      });
      expect(["passed", "unavailable"]).toContain(seen.status);
    });

    it("times out and retries a retryable failure within the configured bound", async () => {
      const seen = await observe(endpoint, "timeout_retry", async ({ invoke, traces }) => {
        try { const response = await invoke({ messages: [system, { role: "user", content: "Write a 600-word essay about mountains." }], maximumOutputTokens: 2048 }, { timeoutMs: 200, maximumRetries: 1 }); return { status: "failed", detail: "completed inside 200 ms", responses: [response] }; }
        catch (error) {
          const outcomes = traces.map(({ outcome, errorCode }) => `${outcome}:${errorCode}`);
          if (traces.some(({ errorCode }) => errorCode === "QUOTA" || errorCode === "AUTH")) return { status: "unavailable", detail: outcomes.join(",") };
          return { status: error instanceof ProviderInvocationFailure && error.causeCode === "TIMEOUT" && outcomes.join(",") === "retry:TIMEOUT,failed:TIMEOUT" ? "passed" : "failed", detail: outcomes.join(",") };
        }
      });
      expect(["passed", "unavailable"]).toContain(seen.status);
    });

    it("reports cache accounting on a repeated long prefix, or records that it did not", async () => {
      const seen = await observe(endpoint, "cache_accounting", async ({ invoke }) => {
        const prefix = Array.from({ length: 400 }, (_, index) => `Reference line ${index}: the quick brown fox jumps over the lazy dog.`).join("\n");
        const request = { messages: [system, { role: "user" as const, content: `${prefix}\n\nReply with the word: done` }], maximumOutputTokens: 64 };
        const first = await invoke(request); const second = await invoke(request);
        const read = second.usage.cacheReadTokens;
        return { status: read === null ? "not_elicited" : read > 0 ? "passed" : "not_elicited", detail: `cacheReadTokens first=${String(first.usage.cacheReadTokens)} second=${String(read)}`, responses: [first, second] };
      });
      expect(["passed", "unavailable", "not_elicited"]).toContain(seen.status);
    });

    it("continues a server-side conversation where the protocol supports it", async () => {
      if (endpoint.continuation !== true) { await observe(endpoint, "continuation", async () => ({ status: "unsupported", detail: `${endpoint.transport} has no server-side continuation in arbitra` })); return; }
      const seen = await observe(endpoint, "continuation", async ({ invoke }) => {
        const first = await invoke({ messages: [system, { role: "user", content: "Remember the code word: heliotrope. Reply ok." }], maximumOutputTokens: 64 }, { activityId: `live/${endpoint.id}/continuation` });
        const second = await invoke({ messages: [{ role: "user", content: "What was the code word?" }], maximumOutputTokens: 64 }, { activityId: `live/${endpoint.id}/continuation` });
        return { status: first.continuation !== null && /heliotrope/iu.test(second.text ?? "") ? "passed" : "failed", detail: `continuation=${first.continuation === null ? "absent" : "present"} answer=${JSON.stringify(second.text?.slice(0, 40))}`, responses: [first, second] };
      });
      expect(["passed", "unavailable"]).toContain(seen.status);
    });
  });

  it("writes redacted, provenance-bearing evidence", async () => {
    await mkdir(dirname(evidencePath), { recursive: true });
    const report = { evidence: "p03-live-transport-conformance", generatedAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, node: process.version, observations };
    const text = JSON.stringify(report, null, 2);
    expect(text).not.toMatch(/sk-ant-api|sk-proj-[A-Za-z0-9]{8}|AIza[A-Za-z0-9]{8}/u);
    await writeFile(evidencePath, text);
    console.log(JSON.stringify(observations.map(({ endpointId, case: name, status, detail }) => ({ endpointId, case: name, status, detail })), null, 1));
  });
});
