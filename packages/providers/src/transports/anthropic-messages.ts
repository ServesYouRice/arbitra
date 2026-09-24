import type { HttpClient, TransportConfiguration } from "../transport-contract.js";
import { JsonProtocolTransport, array, number, object, response, string, type ProtocolCodec } from "./json-transport.js";

export const anthropicMessagesCodec: ProtocolCodec = {
  id: "anthropic-messages", path: "messages",
  authHeaders: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
  encode(request) {
    const system = request.messages.filter(({ role }) => role === "system").map(({ content }) => content).join("\n");
    return { model: request.modelId, system: system || undefined, messages: request.messages.filter(({ role }) => role !== "system").map((message) => {
      if (message.role === "tool") {
        if (!message.toolCallId) throw new Error("TOOL_CALL_ID_REQUIRED");
        return { role: "user", content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }] };
      }
      return { role: message.role, content: message.toolCalls?.length ? [
        ...(message.content === "" ? [] : [{ type: "text", text: message.content }]),
        ...message.toolCalls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.arguments })),
      ] : message.content };
    }),
      max_tokens: request.maximumOutputTokens, tools: request.tools?.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })),
      output_config: request.responseSchema === undefined ? undefined : { format: { type: "json_schema", schema: request.responseSchema } },
      thinking: request.effortParams };
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
    const input = number(usage["input_tokens"]);
    const cacheRead = number(usage["cache_read_input_tokens"]);
    const cacheWrite = number(usage["cache_creation_input_tokens"]);
    // Anthropic reports disjoint buckets. Normalize to total input, matching the
    // shared usage contract and the other codecs' prompt-token totals.
    const completeCacheUsage = (usage["cache_read_input_tokens"] === undefined || cacheRead !== null)
      && (usage["cache_creation_input_tokens"] === undefined || cacheWrite !== null);
    const totalInput = input === null || !completeCacheUsage ? null : input + (cacheRead ?? 0) + (cacheWrite ?? 0);
    return response(request, { text, toolCalls: calls, refusal: root["stop_reason"] === "refusal" ? string(root["refusal"]) ?? "refused" : null,
      usage: { inputTokens: totalInput, outputTokens: number(usage["output_tokens"]),
        cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite },
      requestId: headers["request-id"] ?? null });
  },
};
export class AnthropicMessagesTransport extends JsonProtocolTransport {
  constructor(config: TransportConfiguration, client?: HttpClient, credential?: (name: string) => string | undefined) { super(config, anthropicMessagesCodec, client, credential); }
}
