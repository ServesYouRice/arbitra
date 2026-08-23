import { describe, expect, it } from "vitest";

import type { HttpClient, HttpRequest, HttpResponse, ProviderTransport, TransportRequest } from "../../src/transport-contract.js";
import { AnthropicMessagesTransport } from "../../src/transports/anthropic-messages.js";
import { GeminiNativeTransport } from "../../src/transports/gemini-native.js";
import { OpenAiChatTransport } from "../../src/transports/openai-chat.js";
import { OpenAiResponsesTransport } from "../../src/transports/openai-responses.js";

const adapters = [
  { name: "anthropic-messages", create: factory(AnthropicMessagesTransport), body: anthropicBody },
  { name: "openai-responses", create: factory(OpenAiResponsesTransport), body: responsesBody },
  { name: "openai-chat", create: factory(OpenAiChatTransport), body: chatBody },
  { name: "gemini-native", create: factory(GeminiNativeTransport), body: geminiBody },
] as const;

describe.each(adapters)("$name transport contract", ({ create, body }) => {
  it("handles success, structured output, tool calls, usage, refusal and continuation", async () => {
    const client = new ScriptedHttpClient([
      http(200, body("success")), http(200, body("structured")), http(200, body("tool")), http(200, body("refusal")),
    ]);
    const transport = create(client);
    const success = await transport.send(request(), signal());
    expect(success.text).toBe("hello");
    expect(success.usage).toMatchObject({ inputTokens: 10, outputTokens: 4 });
    expect(success.continuation).toBe("continue-1");
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

function factory<T extends ProviderTransport>(Constructor: new (
  config: { endpoint: string; apiKeyEnv: string; compatibleProviderName?: string }, client?: HttpClient,
  credential?: (name: string) => string | undefined,
) => T) {
  return (client: HttpClient) => new Constructor({ endpoint: "https://compatible.example.test/api/", apiKeyEnv: "TEST_PROVIDER_KEY", compatibleProviderName: "fixture" }, client, () => "fixture-secret");
}

function request(): TransportRequest {
  return { modelId: "fixture-model", messages: [{ role: "user", content: "hello" }], maximumOutputTokens: 100,
    effortParams: { level: "high" }, continuation: "previous-1" };
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
