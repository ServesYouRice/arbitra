import type { HttpClient, TransportConfiguration } from "../transport-contract.js";
import { JsonProtocolTransport, assertOutputComplete, array, number, object, response, string, type ProtocolCodec } from "./json-transport.js";

const codec: ProtocolCodec = {
  id: "openai-chat", path: "chat/completions",
  authHeaders: (key) => ({ authorization: `Bearer ${key}` }),
  encode: (request) => ({ model: request.modelId, messages: request.messages.map((message) => {
    if (message.role === "tool" && !message.toolCallId) throw new Error("TOOL_CALL_ID_REQUIRED");
    return { role: message.role, content: message.content,
      tool_call_id: message.role === "tool" ? message.toolCallId : undefined,
      tool_calls: message.toolCalls?.map((call) => ({ type: "function", id: call.id, function: { name: call.name, arguments: JSON.stringify(call.arguments) }, ...chatExtraContent(call.providerState) })) };
  }), max_completion_tokens: request.maximumOutputTokens,
    tools: request.tools?.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
    response_format: request.responseSchema === undefined ? undefined : { type: "json_schema", json_schema: { name: "response", strict: true, schema: request.responseSchema } },
    reasoning_effort: request.effortParams?.["reasoning_effort"] ?? request.effortParams?.["effort"] }),
  parse(body, request, headers) {
    const root = object(body, "openai-chat response");
    const choice = object(array(root["choices"])[0], "choice");
    assertOutputComplete(choice["finish_reason"] === "length");
    const message = object(choice["message"], "message");
    const text = string(message["content"]);
    const calls = array(message["tool_calls"]).map((item) => {
      const call = object(item, "tool call"); const fn = object(call["function"], "tool function");
      const raw = string(fn["arguments"]) ?? "{}"; let args: unknown;
      try { args = JSON.parse(raw); } catch { throw new Error("Tool arguments were not valid JSON"); }
      // Compatible services attach round-trip data here (Gemini: extra_content.google.thought_signature).
      const extra = call["extra_content"];
      return { id: string(call["id"]) ?? "", name: string(fn["name"]) ?? "", arguments: args, ...(extra !== null && typeof extra === "object" ? { providerState: { extra_content: extra } } : {}) };
    });
    const usage = object(root["usage"] ?? {}, "usage");
    return response(request, { text, toolCalls: calls, refusal: string(message["refusal"]),
      usage: { inputTokens: number(usage["prompt_tokens"]), outputTokens: number(usage["completion_tokens"]),
        cacheReadTokens: number(object(usage["prompt_tokens_details"] ?? {}, "details")["cached_tokens"]) },
      // Compatible services (observed live: Gemini's OpenAI endpoint, P13) send no x-request-id; the completion id is their identity.
      requestId: headers["x-request-id"] ?? string(root["id"]) ?? null });
  },
};
function chatExtraContent(state: unknown): { extra_content?: unknown } {
  const extra = state !== null && typeof state === "object" ? (state as Record<string, unknown>)["extra_content"] : undefined;
  return extra !== null && typeof extra === "object" ? { extra_content: extra } : {};
}
export class OpenAiChatTransport extends JsonProtocolTransport {
  constructor(config: TransportConfiguration, client?: HttpClient, credential?: (name: string) => string | undefined) { super(config, codec, client, credential); }
}
