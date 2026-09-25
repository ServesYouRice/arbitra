import { describe, expect, it } from "vitest";

import type { HttpClient, HttpRequest, HttpResponse, ProviderTransport, TransportRequest } from "../../src/transport-contract.js";
import { AnthropicMessagesTransport } from "../../src/transports/anthropic-messages.js";
import { GeminiNativeTransport } from "../../src/transports/gemini-native.js";
import { OpenAiChatTransport } from "../../src/transports/openai-chat.js";
import { OpenAiResponsesTransport } from "../../src/transports/openai-responses.js";
import { retryAfterMilliseconds } from "../../src/transports/json-transport.js";

const adapters = [
  { name: "anthropic-messages", create: factory(AnthropicMessagesTransport), body: anthropicBody },
  { name: "openai-responses", create: factory(OpenAiResponsesTransport), body: responsesBody },
  { name: "openai-chat", create: factory(OpenAiChatTransport), body: chatBody },
  { name: "gemini-native", create: factory(GeminiNativeTransport), body: geminiBody },
] as const;

describe.each(adapters)("$name transport contract", ({ name, create, body }) => {
  it("handles success, structured output, tool calls, usage, refusal and continuation", async () => {
    const client = new ScriptedHttpClient([
      http(200, body("success")), http(200, body("structured")), http(200, body("tool")), http(200, body("refusal")),
    ]);
    const transport = create(client);
    const success = await transport.send(request(), signal());
    expect(success.text).toBe("hello");
    expect(success.usage).toMatchObject({ inputTokens: 10, outputTokens: 4 });
    expect(success.continuation).toBe(name === "openai-responses" ? "continue-1" : null);
    const structured = await transport.send({ ...request(), responseSchema: { type: "object" } }, signal());
    expect(structured.structured).toEqual({ ok: true });
    expect(structured.structuredOutputTier).toBe("native_structured");
    expect((await transport.send({ ...request(), tools: [tool()] }, signal())).toolCalls[0]).toMatchObject({ name: "lookup", arguments: { q: "x" } });
    const refused = await transport.send(request(), signal());
    expect(refused.refusal).toBeTruthy();
    expect(refused.text).toBeNull();
    expect(client.requests[0]?.body).toBeTypeOf("object");
  });

  it("classifies malformed responses, rate limits, timeouts and retryable server errors", async () => {
    const client = new ScriptedHttpClient([
      http(200, {}), http(429, {}, { "retry-after": "2" }), http(504, {}), http(503, {}), http(200, body("success")),
    ]);
    const transport = create(client);
    await expect(transport.send(request(), signal())).rejects.toMatchObject({ code: "MALFORMED_RESPONSE", retryable: false });
    await expect(transport.send(request(), signal())).rejects.toMatchObject({ code: "RATE_LIMIT", retryable: true, retryAfterMs: 2_000 });
    await expect(transport.send(request(), signal())).rejects.toMatchObject({ code: "TIMEOUT", retryable: true });
    await expect(transport.send(request(), signal())).rejects.toMatchObject({ code: "HTTP", retryable: true });
    await expect(transport.send(request(), signal())).resolves.toMatchObject({ text: "hello" });
  });

  it("fails explicitly instead of returning output truncated at the output ceiling", async () => {
    const truncated = { "anthropic-messages": { content: [{ type: "text", text: "{\"ok\":" }], stop_reason: "max_tokens", usage: {} },
      "openai-responses": { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output_text: "{\"ok\":", usage: {} },
      "openai-chat": { choices: [{ message: { content: "{\"ok\":" }, finish_reason: "length" }], usage: {} },
      "gemini-native": { candidates: [{ content: { parts: [{ text: "{\"ok\":" }] }, finishReason: "MAX_TOKENS" }], usageMetadata: {} } }[name];
    const transport = create(new ScriptedHttpClient([http(200, truncated), http(200, truncated)]));
    await expect(transport.send({ ...request(), responseSchema: { type: "object" } }, signal())).rejects.toMatchObject({ code: "OUTPUT_LIMIT", retryable: false });
    await expect(transport.send(request(), signal())).rejects.toThrow("MODEL_OUTPUT_LIMIT_REACHED");
  });

  it("propagates cancellation to the in-flight client", async () => {
    const client = new WaitingHttpClient();
    const transport = create(client);
    const controller = new AbortController();
    const pending = transport.send(request(), controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED", retryable: false });
    expect(client.receivedSignal).toBe(controller.signal);
  });
});

describe("native wire formats", () => {
  it("includes Anthropic cache reads and writes in total input without inventing missing usage", async () => {
    const client = new ScriptedHttpClient([
      http(200, { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 20, output_tokens: 4 } }),
      http(200, { content: [{ type: "text", text: "ok" }], usage: { cache_read_input_tokens: 80, output_tokens: 4 } }),
    ]);
    const transport = factory(AnthropicMessagesTransport)(client);
    expect((await transport.send(request(), signal())).usage).toEqual({ inputTokens: 110, outputTokens: 4, cacheReadTokens: 80, cacheWriteTokens: 20 });
    expect((await transport.send(request(), signal())).usage.inputTokens).toBeNull();
  });
  const messages = [
    { role: "system" as const, content: "Instructions" },
    { role: "user" as const, content: "Look it up" },
    { role: "assistant" as const, content: "", toolCalls: [{ id: "call-1", name: "lookup", arguments: { q: "x" } }] },
    { role: "tool" as const, content: "found", toolCallId: "call-1", toolName: "lookup" },
  ];
  it("addresses Gemini models and encodes native instructions, thinking and tool history", async () => {
    const client = new ScriptedHttpClient([http(200, geminiBody("success"))]);
    await factory(GeminiNativeTransport)(client).send({ ...request(), modelId: "models/fixture-model", messages, effortParams: { thinkingBudget: 128 } }, signal());
    expect(client.requests[0]?.url).toBe("https://compatible.example.test/api/models/fixture-model:generateContent");
    const wire = JSON.parse(JSON.stringify(client.requests[0]?.body)) as Record<string, unknown>;
    expect(wire).toMatchObject({ systemInstruction: { parts: [{ text: "Instructions" }] }, generationConfig: { thinkingConfig: { thinkingBudget: 128 } }, contents: [
      { role: "user", parts: [{ text: "Look it up" }] },
      { role: "model", parts: [{ functionCall: { name: "lookup", args: { q: "x" } } }] },
      { role: "user", parts: [{ functionResponse: { name: "lookup", response: { result: "found" } } }] },
    ] });
    expect(wire).not.toHaveProperty("continuation"); expect(wire).not.toHaveProperty("model");
  });
  it("keeps blocked Gemini responses distinct from malformed responses", async () => {
    const client = new ScriptedHttpClient([http(200, { promptFeedback: { blockReason: "SAFETY" } }), http(200, { candidates: [{ finishReason: "SAFETY" }] })]);
    const transport = factory(GeminiNativeTransport)(client);
    for (let i = 0; i < 2; i += 1) await expect(transport.send({ ...request(), responseSchema: { type: "object" } }, signal())).resolves.toMatchObject({ refusal: "SAFETY", structured: null });
  });
  it("uses Chat Completions scalar effort and snake-case tool identifiers", async () => {
    const client = new ScriptedHttpClient([http(200, chatBody("success"))]);
    await factory(OpenAiChatTransport)(client).send({ ...request(), messages, effortParams: { effort: "high" } }, signal());
    expect(client.requests[0]?.body).toMatchObject({ reasoning_effort: "high", max_completion_tokens: 100, messages: [
      { role: "system" }, { role: "user" }, { tool_calls: [{ id: "call-1", function: { name: "lookup", arguments: '{"q":"x"}' } }] }, { role: "tool", tool_call_id: "call-1" },
    ] });
    expect(client.requests[0]?.body).not.toHaveProperty("continuation");
  });
  it("encodes Responses tool results and reads every text and refusal content block", async () => {
    const client = new ScriptedHttpClient([
      http(200, { output: [{ type: "message", content: [{ type: "output_text", text: "hel" }, { type: "output_text", text: "lo" }] }] }),
      http(200, { output: [{ type: "message", content: [{ type: "refusal", refusal: "cannot comply" }] }] }),
    ]);
    const transport = factory(OpenAiResponsesTransport)(client);
    expect((await transport.send({ ...request(), messages }, signal())).text).toBe("hello");
    expect(client.requests[0]?.body).toMatchObject({ input: [
      { role: "system" }, { role: "user" }, { type: "function_call", call_id: "call-1" }, { type: "function_call_output", call_id: "call-1", output: "found" },
    ], previous_response_id: "previous-1" });
    await expect(transport.send({ ...request(), responseSchema: { type: "object" } }, signal())).resolves.toMatchObject({ refusal: "cannot comply", structured: null });
  });
  it("uses Anthropic output configuration and native tool-result blocks", async () => {
    const client = new ScriptedHttpClient([http(200, anthropicBody("structured"))]);
    await factory(AnthropicMessagesTransport)(client).send({ ...request(), messages, responseSchema: { type: "object" } }, signal());
    expect(client.requests[0]?.body).toMatchObject({ output_config: { format: { type: "json_schema", schema: { type: "object" } } }, messages: [
      { role: "user" }, { role: "assistant", content: [{ type: "tool_use", id: "call-1" }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "found" }] },
    ] });
    expect(client.requests[0]?.body).not.toHaveProperty("continuation");
  });
  it("does not retry local encoding failures as network failures", async () => {
    const client = new ScriptedHttpClient([]);
    await expect(factory(GeminiNativeTransport)(client).send({ ...request(), modelId: "../../unsafe" }, signal())).rejects.toMatchObject({ code: "INVALID_REQUEST", retryable: false });
    expect(client.requests).toEqual([]);
  });
});

describe("Retry-After parsing", () => {
  it("accepts delay seconds and HTTP dates but rejects negative and malformed values", () => {
    expect(retryAfterMilliseconds("1.5", 0)).toBe(1_500);
    expect(retryAfterMilliseconds("Thu, 01 Jan 1970 00:00:02 GMT", 1_000)).toBe(1_000);
    expect(retryAfterMilliseconds("-1", 0)).toBeNull();
    expect(retryAfterMilliseconds("tomorrow", 0)).toBeNull();
  });
});

function factory<T extends ProviderTransport>(Constructor: new (
  config: { endpoint: string; apiKeyEnv: string; compatibleProviderName?: string }, client?: HttpClient,
  credential?: (name: string) => string | undefined,
) => T) {
  return (client: HttpClient) => new Constructor({ endpoint: "https://compatible.example.test/api/", apiKeyEnv: "TEST_PROVIDER_KEY", compatibleProviderName: "fixture" }, client, () => "fixture-secret");
}

function request(): TransportRequest {
  return { modelId: "fixture-model", messages: [{ role: "user", content: "hello" }], maximumOutputTokens: 100,
    continuation: "previous-1" };
}
function tool() { return { name: "lookup", description: "Lookup a value", inputSchema: { type: "object" } }; }
function signal() { return new AbortController().signal; }
function http(status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): HttpResponse { return { status, body, headers }; }

class ScriptedHttpClient implements HttpClient {
  readonly requests: HttpRequest[] = [];
  constructor(private readonly responses: readonly HttpResponse[]) {}
  async send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request); const value = this.responses[this.requests.length - 1];
    if (value === undefined) throw new Error("HTTP_SCRIPT_EXHAUSTED"); return value;
  }
}
class WaitingHttpClient implements HttpClient {
  receivedSignal: AbortSignal | null = null;
  async send(request: HttpRequest): Promise<HttpResponse> {
    this.receivedSignal = request.signal;
    return new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => {
      const error = new Error("aborted"); error.name = "AbortError"; reject(error);
    }, { once: true }));
  }
}

type Case = "success" | "structured" | "tool" | "refusal";
function chatBody(kind: Case): unknown {
  const message = kind === "tool" ? { content: null, tool_calls: [{ id: "call-1", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }] }
    : kind === "refusal" ? { content: null, refusal: "cannot comply" }
    : { content: kind === "structured" ? "{\"ok\":true}" : "hello" };
  return { choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 4 }, continuation: "continue-1" };
}
function responsesBody(kind: Case): unknown {
  if (kind === "tool") return { output: [{ type: "function_call", call_id: "call-1", name: "lookup", arguments: "{\"q\":\"x\"}" }], usage: { input_tokens: 10, output_tokens: 4 }, id: "continue-1" };
  return { output_text: kind === "refusal" ? null : kind === "structured" ? "{\"ok\":true}" : "hello",
    refusal: kind === "refusal" ? "cannot comply" : null, usage: { input_tokens: 10, output_tokens: 4 }, id: "continue-1" };
}
function anthropicBody(kind: Case): unknown {
  const content = kind === "tool" ? [{ type: "tool_use", id: "call-1", name: "lookup", input: { q: "x" } }]
    : kind === "refusal" ? [] : [{ type: "text", text: kind === "structured" ? "{\"ok\":true}" : "hello" }];
  return { content, stop_reason: kind === "refusal" ? "refusal" : "end_turn", refusal: "cannot comply",
    usage: { input_tokens: 10, output_tokens: 4 }, continuation: "continue-1" };
}
function geminiBody(kind: Case): unknown {
  const parts = kind === "tool" ? [{ functionCall: { id: "call-1", name: "lookup", args: { q: "x" } } }]
    : kind === "refusal" ? [] : [{ text: kind === "structured" ? "{\"ok\":true}" : "hello" }];
  return { candidates: [{ content: { parts }, finishReason: kind === "refusal" ? "SAFETY" : "STOP", safetyMessage: "cannot comply" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 }, continuation: "continue-1" };
}
