import type { HttpClient, TransportConfiguration } from "../transport-contract.js";
import { JsonProtocolTransport, array, number, object, response, string, type ProtocolCodec } from "./json-transport.js";

const codec: ProtocolCodec = {
  id: "gemini-native", path: "models/generateContent", authHeaders: (key) => ({ "x-goog-api-key": key }),
  encode: (request) => ({ model: request.modelId,
    contents: request.messages.filter(({ role }) => role !== "system").map(({ role, content }) => ({ role: role === "assistant" ? "model" : "user", parts: [{ text: content }] })),
    systemInstruction: request.messages.filter(({ role }) => role === "system").map(({ content }) => content).join("\n") || undefined,
    tools: request.tools === undefined ? undefined : [{ functionDeclarations: request.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema })) }],
    generationConfig: { maxOutputTokens: request.maximumOutputTokens,
      responseMimeType: request.responseSchema === undefined ? undefined : "application/json", responseSchema: request.responseSchema, ...request.effortParams },
    continuation: request.continuation }),
  parse(body, request, headers) {
    const root = object(body, "gemini response"); const candidate = object(array(root["candidates"])[0], "candidate");
    const content = object(candidate["content"], "candidate content"); let text: string | null = null; const calls = [];
    for (const item of array(content["parts"])) {
      const part = object(item, "candidate part");
      if (typeof part["text"] === "string") text = `${text ?? ""}${part["text"]}`;
      if (part["functionCall"] !== undefined) { const call = object(part["functionCall"], "function call");
        calls.push({ id: string(call["id"]) ?? "", name: string(call["name"]) ?? "", arguments: call["args"] }); }
    }
    const usage = object(root["usageMetadata"] ?? {}, "usage");
    return response(request, { text, toolCalls: calls,
      refusal: candidate["finishReason"] === "SAFETY" ? string(candidate["safetyMessage"]) ?? "safety refusal" : null,
      continuation: string(root["continuation"]), usage: { inputTokens: number(usage["promptTokenCount"]), outputTokens: number(usage["candidatesTokenCount"]),
        cacheReadTokens: number(usage["cachedContentTokenCount"]) }, requestId: headers["x-request-id"] ?? null });
  },
};
export class GeminiNativeTransport extends JsonProtocolTransport {
  constructor(config: TransportConfiguration, client?: HttpClient, credential?: (name: string) => string | undefined) { super(config, codec, client, credential); }
}
