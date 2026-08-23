import type { HttpClient, TransportConfiguration } from "../transport-contract.js";
import { JsonProtocolTransport, array, number, object, response, string, type ProtocolCodec } from "./json-transport.js";

const codec: ProtocolCodec = {
  id: "openai-responses", path: "responses", authHeaders: (key) => ({ authorization: `Bearer ${key}` }),
  encode: (request) => ({ model: request.modelId, input: request.messages, max_output_tokens: request.maximumOutputTokens,
    tools: request.tools?.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.inputSchema })),
    text: request.responseSchema === undefined ? undefined : { format: { type: "json_schema", name: "response", strict: true, schema: request.responseSchema } },
    reasoning: request.effortParams, previous_response_id: request.continuation }),
  parse(body, request, headers) {
    const root = object(body, "openai-responses response");
    if (!Array.isArray(root["output"]) && typeof root["output_text"] !== "string" && typeof root["refusal"] !== "string") {
      throw new Error("openai-responses response has no output");
    }
    let text: string | null = string(root["output_text"]); const calls = [];
    for (const item of array(root["output"])) {
      const value = object(item, "output item");
      if (value["type"] === "function_call") {
        const raw = string(value["arguments"]) ?? "{}";
        calls.push({ id: string(value["call_id"]) ?? "", name: string(value["name"]) ?? "", arguments: JSON.parse(raw) as unknown });
      }
      if (value["type"] === "message" && text === null) {
        const part = object(array(value["content"])[0], "message content"); text = string(part["text"]);
      }
    }
    const usage = object(root["usage"] ?? {}, "usage");
    return response(request, { text, toolCalls: calls, refusal: string(root["refusal"]), continuation: string(root["id"]),
      usage: { inputTokens: number(usage["input_tokens"]), outputTokens: number(usage["output_tokens"]),
        cacheReadTokens: number(object(usage["input_tokens_details"] ?? {}, "input details")["cached_tokens"]) }, requestId: headers["x-request-id"] ?? null });
  },
};
export class OpenAiResponsesTransport extends JsonProtocolTransport {
  constructor(config: TransportConfiguration, client?: HttpClient, credential?: (name: string) => string | undefined) { super(config, codec, client, credential); }
}
