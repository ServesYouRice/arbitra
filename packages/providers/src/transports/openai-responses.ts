import type { HttpClient, TransportConfiguration } from "../transport-contract.js";
import { JsonProtocolTransport, assertOutputComplete, array, number, object, response, string, type ProtocolCodec } from "./json-transport.js";

export const openAiResponsesCodec: ProtocolCodec = {
  id: "openai-responses", path: "responses", authHeaders: (key) => ({ authorization: `Bearer ${key}` }),
  encode: (request) => ({ model: request.modelId, input: request.messages.flatMap((message): readonly unknown[] => {
    if (message.role === "tool") {
      if (!message.toolCallId) throw new Error("TOOL_CALL_ID_REQUIRED");
      return [{ type: "function_call_output", call_id: message.toolCallId, output: message.content }];
    }
    return [...(message.content === "" && message.toolCalls?.length ? [] : [{ role: message.role, content: message.content }]),
      ...(message.toolCalls ?? []).map((call) => ({ type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) }))];
  }), max_output_tokens: request.maximumOutputTokens,
    tools: request.tools?.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.inputSchema })),
    text: request.responseSchema === undefined ? undefined : { format: { type: "json_schema", name: "response", strict: true, schema: request.responseSchema } },
    reasoning: request.effortParams, previous_response_id: request.continuation }),
  parse(body, request, headers) {
    const root = object(body, "openai-responses response");
    assertOutputComplete(root["status"] === "incomplete" && object(root["incomplete_details"] ?? {}, "incomplete details")["reason"] === "max_output_tokens");
    if (!Array.isArray(root["output"]) && typeof root["output_text"] !== "string" && typeof root["refusal"] !== "string") {
      throw new Error("openai-responses response has no output");
    }
    const convenienceText = string(root["output_text"]);
    let text: string | null = null; let refusal = string(root["refusal"]); const calls = [];
    for (const item of array(root["output"])) {
      const value = object(item, "output item");
      if (value["type"] === "function_call") {
        const raw = string(value["arguments"]) ?? "{}";
        calls.push({ id: string(value["call_id"]) ?? "", name: string(value["name"]) ?? "", arguments: JSON.parse(raw) as unknown });
      }
      if (value["type"] === "message") {
        for (const item of array(value["content"])) {
          const part = object(item, "message content");
          if (part["type"] === "output_text" && typeof part["text"] === "string") text = `${text ?? ""}${part["text"]}`;
          if (part["type"] === "refusal") refusal = string(part["refusal"]) ?? "refused";
        }
      }
    }
    const usage = object(root["usage"] ?? {}, "usage");
    return response(request, { text: text ?? convenienceText, toolCalls: calls, refusal, continuation: string(root["id"]),
      usage: { inputTokens: number(usage["input_tokens"]), outputTokens: number(usage["output_tokens"]),
        cacheReadTokens: number(object(usage["input_tokens_details"] ?? {}, "input details")["cached_tokens"]) }, requestId: headers["x-request-id"] ?? null });
  },
};
export class OpenAiResponsesTransport extends JsonProtocolTransport {
  constructor(config: TransportConfiguration, client?: HttpClient, credential?: (name: string) => string | undefined) { super(config, openAiResponsesCodec, client, credential); }
}
