import { describe, expect, it, vi } from "vitest";
import { AnthropicBatchDriver } from "../../src/batch/anthropic-batch.js";
import { BatchRequestError } from "../../src/batch/contract.js";
import { BATCH_DRIVER_DECLARATIONS } from "../../src/batch/drivers.js";
import { GeminiBatchDriver } from "../../src/batch/gemini-batch.js";
import { OpenAiBatchDriver } from "../../src/batch/openai-batch.js";
import { assertBatchLaneSupported } from "../../src/batch/preflight.js";
import { ProviderRegistry } from "../../src/registry.js";
import { FetchHttpClient, type HttpClient, type HttpRequest, type HttpResponse, type TransportRequest } from "../../src/transport-contract.js";

const signal = new AbortController().signal;
const request: TransportRequest = { modelId: "configured-model", messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hello" }], maximumOutputTokens: 10 };
const structured: TransportRequest = { ...request, responseSchema: { type: "object" } };

/** Routes by method and URL; every request is recorded for wire assertions. */
function fakeClient(routes: Record<string, (request: HttpRequest) => HttpResponse | Promise<HttpResponse>>) {
  const requests: HttpRequest[] = [];
  const client: HttpClient = { async send(value) {
    requests.push(value);
    const key = `${value.method ?? "POST"} ${value.url}`;
    const route = routes[key];
    if (route === undefined) throw new Error(`UNROUTED:${key}`);
    return route(value);
  } };
  return { client, requests };
}
const ok = (body: unknown): HttpResponse => ({ status: 200, headers: {}, body });
const configuration = (endpoint: string) => ({ endpoint, apiKeyEnv: "BATCH_KEY" });
const options = (client: HttpClient) => ({ client, credential: () => "secret-value" });

describe("OpenAI batch driver", () => {
  const base = "https://openai.example/v1/";
  it("uploads a JSONL input file, creates a /v1/responses batch keyed by metadata, and parses out-of-order results", async () => {
    const outputLines = [
      { id: "r2", custom_id: "a1-second", response: { status_code: 400, request_id: "req-2", body: { error: { message: "bad" } } }, error: null },
      { id: "r1", custom_id: "a1-first", response: { status_code: 200, request_id: "req-1", body: { output_text: '{"ok":true}', usage: { input_tokens: 4, output_tokens: 2 } } }, error: null },
    ].map((line) => JSON.stringify(line)).join("\n");
    const errorLines = [{ id: "r3", custom_id: "a1-third", response: null, error: { code: "batch_expired", message: "expired" } },
      { id: "r4", custom_id: "a1-fourth", response: null, error: { code: "batch_cancelled", message: "cancelled" } }].map((line) => JSON.stringify(line)).join("\n");
    const { client, requests } = fakeClient({
      [`POST ${base}files`]: () => ok({ id: "file-in" }),
      [`POST ${base}batches`]: () => ok({ id: "batch_1", status: "validating" }),
      [`GET ${base}batches/batch_1`]: () => ok({ id: "batch_1", status: "completed", output_file_id: "file-out", error_file_id: "file-err" }),
      [`GET ${base}files/file-out/content`]: () => ok(outputLines),
      [`GET ${base}files/file-err/content`]: () => ok(errorLines),
      [`POST ${base}batches/batch_1/cancel`]: () => ok({ id: "batch_1", status: "cancelling" }),
    });
    const driver = new OpenAiBatchDriver(configuration("https://openai.example/v1"), options(client));
    await expect(driver.submit({ submissionKey: "arbitra-key", modelId: "configured-model", items: [{ customId: "a1-first", request: structured }] }, signal))
      .resolves.toEqual({ providerJobId: "batch_1" });
    const upload = requests[0];
    expect(upload).toMatchObject({ bodyEncoding: "multipart", headers: { authorization: "Bearer secret-value" }, body: { fields: { purpose: "batch" }, file: { field: "file", filename: "arbitra-key.jsonl" } } });
    const line = JSON.parse(((upload?.body as { file: { content: string } }).file.content).trim()) as Record<string, unknown>;
    expect(line).toMatchObject({ custom_id: "a1-first", method: "POST", url: "/v1/responses", body: { model: "configured-model", max_output_tokens: 10, text: { format: { type: "json_schema" } } } });
    expect(requests[1]?.body).toEqual({ input_file_id: "file-in", endpoint: "/v1/responses", completion_window: "24h", metadata: { arbitra_submission_key: "arbitra-key" } });

    await expect(driver.status("batch_1", signal)).resolves.toEqual({ ended: true, providerStatus: "completed", jobFailure: null });
    const results = await driver.results("batch_1", signal);
    expect(results.map(({ customId, outcome }) => ({ customId, outcome }))).toEqual([
      { customId: "a1-second", outcome: "errored" }, { customId: "a1-first", outcome: "succeeded" },
      { customId: "a1-third", outcome: "expired" }, { customId: "a1-fourth", outcome: "cancelled" },
    ]);
    expect(results[0]?.error).toEqual({ code: "HTTP_400", message: "bad" });
    const parsed = driver.parse(results[1]?.body, structured);
    expect(parsed).toMatchObject({ structured: { ok: true }, providerRequestId: "req-1", usage: { inputTokens: 4, outputTokens: 2 } });
    expect(driver.usage(results[1]?.body)).toMatchObject({ inputTokens: 4, outputTokens: 2 });
    await driver.cancel("batch_1", signal);
    expect(requests.at(-1)).toMatchObject({ method: "POST", url: `${base}batches/batch_1/cancel` });
  });

  it("finds an uncertain submission by metadata across listing pages and reports whole-batch failures", async () => {
    const { client } = fakeClient({
      [`GET ${base}batches?limit=100`]: () => ok({ data: [{ id: "batch_a", metadata: { arbitra_submission_key: "other" } }], has_more: true, last_id: "batch_a" }),
      [`GET ${base}batches?limit=100&after=batch_a`]: () => ok({ data: [{ id: "batch_b", metadata: { arbitra_submission_key: "arbitra-key" } }], has_more: false }),
      [`GET ${base}batches/batch_f`]: () => ok({ id: "batch_f", status: "failed", errors: { data: [{ code: "invalid_json_line", message: "line 1" }] } }),
    });
    const driver = new OpenAiBatchDriver(configuration(base), options(client));
    await expect(driver.find("arbitra-key", "model", signal)).resolves.toEqual({ kind: "found", providerJobId: "batch_b" });
    await expect(driver.find("missing", "model", signal)).resolves.toEqual({ kind: "not_found" });
    await expect(driver.status("batch_f", signal)).resolves.toEqual({ ended: true, providerStatus: "failed", jobFailure: { code: "invalid_json_line", message: "line 1" } });
  });

  it("classifies a lost creation acknowledgment as possibly accepted, and upload or validation failures as definitely not", async () => {
    let create: () => Promise<HttpResponse> = async () => { throw new Error("socket hang up"); };
    const { client } = fakeClient({ [`POST ${base}files`]: () => ok({ id: "file-in" }), [`POST ${base}batches`]: () => create() });
    const driver = new OpenAiBatchDriver(configuration(base), options(client));
    const input = { submissionKey: "k", modelId: "m", items: [{ customId: "a1-x", request }] };
    await expect(driver.submit(input, signal)).rejects.toMatchObject({ accepted: "unknown", code: "NETWORK" });
    create = async () => ({ status: 503, headers: {}, body: null });
    await expect(driver.submit(input, signal)).rejects.toMatchObject({ accepted: "unknown", code: "HTTP" });
    create = async () => ({ status: 400, headers: {}, body: null });
    await expect(driver.submit(input, signal)).rejects.toMatchObject({ accepted: "no", code: "INVALID_REQUEST" });
    await expect(driver.submit({ ...input, items: [{ customId: "a1-y", request: { ...request, messages: [{ role: "tool", content: "x" }] } }] }, signal))
      .rejects.toMatchObject({ accepted: "no", code: "INVALID_REQUEST", message: "TOOL_CALL_ID_REQUIRED" });
    const failingUpload = fakeClient({ [`POST ${base}files`]: () => { throw new Error("reset"); } });
    await expect(new OpenAiBatchDriver(configuration(base), options(failingUpload.client)).submit(input, signal)).rejects.toMatchObject({ accepted: "no" });
    await expect(new OpenAiBatchDriver(configuration(base), { client, credential: () => undefined }).submit(input, signal)).rejects.toMatchObject({ accepted: "no", code: "AUTH" });
  });
});

describe("Anthropic Message Batches driver", () => {
  const base = "https://anthropic.example/v1/";
  it("submits custom IDs with Messages params, polls processing_status and parses every result type", async () => {
    const lines = [
      { custom_id: "a1-c", result: { type: "canceled" } },
      { custom_id: "a1-b", result: { type: "errored", error: { type: "error", error: { type: "invalid_request_error", message: "too long" } } } },
      { custom_id: "a1-a", result: { type: "succeeded", message: { id: "msg_1", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 2 } } } },
      { custom_id: "a1-d", result: { type: "expired" } },
    ].map((line) => JSON.stringify(line)).join("\n");
    const { client, requests } = fakeClient({
      [`POST ${base}messages/batches`]: () => ok({ id: "msgbatch_1", processing_status: "in_progress" }),
      [`GET ${base}messages/batches/msgbatch_1`]: () => ok({ id: "msgbatch_1", processing_status: "ended", results_url: `${base}messages/batches/msgbatch_1/results` }),
      [`GET ${base}messages/batches/msgbatch_1/results`]: () => ok(lines),
      [`POST ${base}messages/batches/msgbatch_1/cancel`]: () => ok({ id: "msgbatch_1", processing_status: "canceling" }),
    });
    const driver = new AnthropicBatchDriver(configuration(base), options(client));
    await expect(driver.submit({ submissionKey: "k", modelId: "configured-model", items: [{ customId: "a1-a", request }] }, signal)).resolves.toEqual({ providerJobId: "msgbatch_1" });
    expect(requests[0]).toMatchObject({ headers: { "x-api-key": "secret-value", "anthropic-version": "2023-06-01" },
      body: { requests: [{ custom_id: "a1-a", params: { model: "configured-model", system: "be brief", max_tokens: 10, messages: [{ role: "user", content: "hello" }] } }] } });
    await expect(driver.status("msgbatch_1", signal)).resolves.toEqual({ ended: true, providerStatus: "ended", jobFailure: null });
    const results = await driver.results("msgbatch_1", signal);
    expect(results.map(({ customId, outcome, error }) => ({ customId, outcome, code: error?.code ?? null }))).toEqual([
      { customId: "a1-c", outcome: "cancelled", code: "canceled" }, { customId: "a1-b", outcome: "errored", code: "invalid_request_error" },
      { customId: "a1-a", outcome: "succeeded", code: null }, { customId: "a1-d", outcome: "expired", code: "expired" },
    ]);
    expect(driver.parse(results[2]?.body, request)).toMatchObject({ text: "hi", usage: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 2 } });
    await driver.cancel("msgbatch_1", signal);
    expect(requests.at(-1)?.url).toBe(`${base}messages/batches/msgbatch_1/cancel`);
  });

  it("cannot reconcile by key and never sends credentials to a foreign results URL", async () => {
    const { client, requests } = fakeClient({
      [`GET ${base}messages/batches/msgbatch_x`]: () => ok({ id: "msgbatch_x", processing_status: "ended", results_url: "https://elsewhere.example/results" }),
    });
    const driver = new AnthropicBatchDriver(configuration(base), options(client));
    await expect(driver.find()).resolves.toMatchObject({ kind: "unsupported" });
    await expect(driver.results("msgbatch_x", signal)).rejects.toThrow("BATCH_RESULTS_URL_UNTRUSTED");
    expect(requests.map(({ url }) => url)).toEqual([`${base}messages/batches/msgbatch_x`]);
  });
});

describe("Gemini batch driver", () => {
  const base = "https://gemini.example/v1beta/";
  it("submits inline requests keyed by display name and parses inlined responses by metadata key", async () => {
    const operation = { name: "batches/abc", metadata: { displayName: "arbitra-key", state: "BATCH_STATE_SUCCEEDED" }, done: true,
      response: { inlinedResponses: { inlinedResponses: [
        { metadata: { key: "a1-b" }, error: { code: 3, message: "invalid" } },
        { metadata: { key: "a1-a" }, response: { candidates: [{ content: { parts: [{ text: "hi" }] } }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 } } },
      ] } } };
    const { client, requests } = fakeClient({
      [`POST ${base}models/configured-model:batchGenerateContent`]: () => ok({ name: "batches/abc", metadata: { state: "BATCH_STATE_PENDING" } }),
      [`GET ${base}batches/abc`]: () => ok(operation),
      [`GET ${base}batches?pageSize=100`]: () => ok({ operations: [operation] }),
      [`POST ${base}batches/abc:cancel`]: () => ok({}),
    });
    const driver = new GeminiBatchDriver(configuration("https://gemini.example/v1beta"), options(client));
    await expect(driver.submit({ submissionKey: "arbitra-key", modelId: "configured-model", items: [{ customId: "a1-a", request }] }, signal)).resolves.toEqual({ providerJobId: "batches/abc" });
    expect(requests[0]).toMatchObject({ headers: { "x-goog-api-key": "secret-value" }, body: { batch: { displayName: "arbitra-key", inputConfig: { requests: { requests: [
      { metadata: { key: "a1-a" }, request: { contents: [{ role: "user", parts: [{ text: "hello" }] }], systemInstruction: { parts: [{ text: "be brief" }] } } },
    ] } } } } });
    await expect(driver.status("batches/abc", signal)).resolves.toEqual({ ended: true, providerStatus: "SUCCEEDED", jobFailure: null });
    const results = await driver.results("batches/abc", signal);
    expect(results.map(({ customId, outcome }) => ({ customId, outcome }))).toEqual([{ customId: "a1-b", outcome: "errored" }, { customId: "a1-a", outcome: "succeeded" }]);
    expect(driver.parse(results[1]?.body, request)).toMatchObject({ text: "hi", usage: { inputTokens: 4, outputTokens: 2 } });
    await expect(driver.find("arbitra-key", "configured-model", signal)).resolves.toEqual({ kind: "found", providerJobId: "batches/abc" });
    await expect(driver.find("absent", "configured-model", signal)).resolves.toEqual({ kind: "not_found" });
    await driver.cancel("batches/abc", signal);
    expect(requests.at(-1)?.url).toBe(`${base}batches/abc:cancel`);
    await expect(driver.status("../files/x", signal)).rejects.toBeInstanceOf(BatchRequestError);
  });

  it("encodes batch items with the interactive codec, so structured output keeps standard JSON Schema", async () => {
    // Live P03: Gemini's OpenAPI-subset `responseSchema` rejects `additionalProperties`; the batch
    // driver must share the transport's `responseJsonSchema` encoding rather than duplicate the old one.
    const schema = { type: "object", properties: { capital: { type: "string" } }, required: ["capital"], additionalProperties: false };
    const { client, requests } = fakeClient({ [`POST ${base}models/configured-model:batchGenerateContent`]: () => ok({ name: "batches/s" }) });
    await new GeminiBatchDriver(configuration(base), options(client)).submit({ submissionKey: "k", modelId: "configured-model", items: [{ customId: "a1-s", request: { ...request, responseSchema: schema } }] }, signal);
    const item = (requests[0]?.body as { batch: { inputConfig: { requests: { requests: { request: { generationConfig: Record<string, unknown> } }[] } } } }).batch.inputConfig.requests.requests[0];
    expect(item?.request.generationConfig).toMatchObject({ responseMimeType: "application/json", responseJsonSchema: schema });
    expect(item?.request.generationConfig["responseSchema"]).toBeUndefined();
  });

  it("classifies a tier or credit refusal as a definite, non-retryable QUOTA non-submission with the provider's detail", async () => {
    const refusal = (status: number, error: Record<string, unknown>) => fakeClient({ [`POST ${base}models/configured-model:batchGenerateContent`]: () => ({ status, headers: {}, body: { error } }) });
    const submit = (client: HttpClient) => new GeminiBatchDriver(configuration(base), options(client)).submit({ submissionKey: "k", modelId: "configured-model", items: [{ customId: "a1-a", request }] }, signal);
    await expect(submit(refusal(429, { type: "invalid_request_error", code: "insufficient_quota", message: "You exceeded your current quota" }).client))
      .rejects.toMatchObject({ code: "QUOTA", accepted: "no", retryable: false, message: expect.stringContaining("insufficient_quota") });
    await expect(submit(refusal(400, { type: "invalid_request_error", message: "Your credit balance is too low (key=abc123)" }).client))
      .rejects.toMatchObject({ code: "QUOTA", message: expect.not.stringContaining("abc123") });
    // A generic precondition refusal stays an invalid request, but now names the provider's status.
    await expect(submit(refusal(400, { code: 400, status: "FAILED_PRECONDITION", message: "Precondition check failed." }).client))
      .rejects.toMatchObject({ code: "INVALID_REQUEST", accepted: "no", message: "Provider HTTP 400: 400/FAILED_PRECONDITION Precondition check failed." });
    await expect(submit(refusal(429, { status: "RESOURCE_EXHAUSTED", message: "Too many requests" }).client)).rejects.toMatchObject({ code: "RATE_LIMIT", retryable: true });
  });

  it("marks cancelled and expired jobs per item", async () => {
    const { client } = fakeClient({
      [`GET ${base}batches/c`]: () => ok({ name: "batches/c", metadata: { state: "BATCH_STATE_CANCELLED", output: { inlinedResponses: { inlinedResponses: [{ metadata: { key: "a1-a" }, error: { code: 1, message: "cancelled" } }] } } } }),
    });
    const driver = new GeminiBatchDriver(configuration(base), options(client));
    await expect(driver.results("batches/c", signal)).resolves.toMatchObject([{ customId: "a1-a", outcome: "cancelled" }]);
  });
});

describe("batch capability declarations and unsupported endpoints", () => {
  it("declares every shipped driver as unverified until live validation is recorded", () => {
    expect(BATCH_DRIVER_DECLARATIONS.map(({ driverId, transport, status, liveValidation }) => ({ driverId, transport, status, liveValidation }))).toEqual([
      { driverId: "openai-batch", transport: "openai-responses", status: "declared_unverified", liveValidation: null },
      { driverId: "anthropic-message-batches", transport: "anthropic-messages", status: "declared_unverified", liveValidation: null },
      { driverId: "gemini-batch", transport: "gemini-native", status: "declared_unverified", liveValidation: null },
    ]);
  });

  it("rejects batch lanes on endpoints without a driver, and profiles that do not declare batch or are interactive, with actionable errors", () => {
    const registry = new ProviderRegistry([
      { id: "compatible", providerId: "other", transport: "openai-chat", endpoint: "https://other.example/v1", apiKeyEnvVar: "OTHER_KEY" },
      { id: "responses", providerId: "openai", transport: "openai-responses", endpoint: "https://openai.example/v1", apiKeyEnvVar: "OPENAI_KEY" },
    ]);
    const batchProfile = { supports: { tools: false, parallelToolCalls: false, structuredOutput: true, reasoning: false, promptCaching: false, batch: true, vision: false } };
    expect(registry.supportsBatch("compatible")).toBe(false);
    expect(() => assertBatchLaneSupported(registry, "cheap", "compatible", batchProfile)).toThrow(
      /^BATCH_LANE_UNSUPPORTED_ENDPOINT:compatible: transport "openai-chat" has no batch driver \(batch drivers exist for: openai-responses, anthropic-messages, gemini-native\)\. Remove this model from workflow\.modelExecution\.batch\.lanes/u);
    expect(() => assertBatchLaneSupported(registry, "cheap", "responses", { supports: { ...batchProfile.supports, batch: false } })).toThrow("BATCH_LANE_MODEL_UNSUPPORTED:cheap");
    expect(() => assertBatchLaneSupported(registry, "cheap", "responses", { supports: { ...batchProfile.supports, tools: true } })).toThrow("BATCH_LANE_INTERACTIVE_PROFILE:cheap");
    expect(assertBatchLaneSupported(registry, "cheap", "responses", batchProfile).declaration.status).toBe("declared_unverified");
  });
});

describe("fetch client batch encodings", () => {
  it("sends GET without a body, multipart uploads as form data, and returns text responses raw", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(calls.length === 3 ? "{\"a\":1}\n" : JSON.stringify({ ok: true }), { status: 200 });
    });
    try {
      const client = new FetchHttpClient();
      await expect(client.send({ url: "https://x.example/batches", method: "GET", headers: { authorization: "Bearer k" }, body: null, signal })).resolves.toMatchObject({ body: { ok: true } });
      await client.send({ url: "https://x.example/files", headers: {}, bodyEncoding: "multipart", signal,
        body: { fields: { purpose: "batch" }, file: { field: "file", filename: "in.jsonl", contentType: "application/jsonl", content: "{}\n" } } });
      await expect(client.send({ url: "https://x.example/files/f/content", method: "GET", headers: {}, body: null, responseEncoding: "text", signal }))
        .resolves.toMatchObject({ body: "{\"a\":1}\n" });
      expect(calls[0]?.init).toMatchObject({ method: "GET" });
      expect(calls[0]?.init.body).toBeUndefined();
      const form = calls[1]?.init.body;
      expect(form).toBeInstanceOf(FormData);
      expect((form as FormData).get("purpose")).toBe("batch");
      expect(((form as FormData).get("file") as File).name).toBe("in.jsonl");
      expect(calls[1]?.init.headers).not.toHaveProperty("content-type");
    } finally { vi.unstubAllGlobals(); }
  });
});
