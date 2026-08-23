import type { HttpClient, TransportConfiguration } from "../transport-contract.js";
import { JsonProtocolTransport, array, number, object, response, string, type ProtocolCodec } from "./json-transport.js";

const codec: ProtocolCodec = {
  id: "anthropic-messages", path: "messages",
  authHeaders: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
  encode(request) {
    const system = request.messages.filter(({ role }) => role === "system").map(({ content }) => content).join("\n");
    return { model: request.modelId, system: system || undefined, messages: request.messages.filter(({ role }) => role !== "system"),
      max_tokens: request.maximumOutputTokens, tools: request.tools?.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })),
      output_format: request.responseSchema === undefined ? undefined : { type: "json_schema", schema: request.responseSchema },
      thinking: request.effortParams, continuation: request.continuation };
  },
  parse(body, request, headers) {
    const root = object(body, "anthropic response");
    if (!Array.isArray(root["content"])) throw new Error("anthropic response content must be an array");
    let text: string | null = null; const calls = [];
    for (const item of array(root["content"])) {
      const part = object(item, "content part");
      if (part["type"] === "text") text = `${text ?? ""}${string(part["text"]) ?? ""}`;
      if (part["type"] === "tool_use") calls.push({ id: string(part["id"]) ?? "", name: string(part["name"]) ?? "", arguments: part["input"] });
    }
    const usage = object(root["usage"] ?? {}, "usage");
    return response(request, { text, toolCalls: calls, refusal: root["stop_reason"] === "refusal" ? string(root["refusal"]) ?? "refused" : null,
      continuation: string(root["continuation"]), usage: { inputTokens: number(usage["input_tokens"]), outputTokens: number(usage["output_tokens"]),
        cacheReadTokens: number(usage["cache_read_input_tokens"]), cacheWriteTokens: number(usage["cache_creation_input_tokens"]) },
      requestId: headers["request-id"] ?? null });
  },
};
export class AnthropicMessagesTransport extends JsonProtocolTransport {
  constructor(config: TransportConfiguration, client?: HttpClient, credential?: (name: string) => string | undefined) { super(config, codec, client, credential); }
}
