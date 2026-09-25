import type { HttpClient, TransportConfiguration } from "../transport-contract.js";
import { JsonProtocolTransport, assertOutputComplete, array, number, object, response, string, type ProtocolCodec } from "./json-transport.js";

export const geminiNativeCodec: ProtocolCodec = {
  id: "gemini-native", path: (request) => {
    const model = request.modelId.replace(/^models\//u, "");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(model)) throw new Error("INVALID_GEMINI_MODEL_ID");
    return `models/${model}:generateContent`;
  }, authHeaders: (key) => ({ "x-goog-api-key": key }),
  encode: (request) => ({
    contents: request.messages.filter(({ role }) => role !== "system").map((message) => {
      if (message.role === "tool") {
        if (!message.toolName) throw new Error("TOOL_NAME_REQUIRED");
        return { role: "user", parts: [{ functionResponse: { name: message.toolName, id: message.toolCallId, response: { result: message.content } } }] };
      }
      return { role: message.role === "assistant" ? "model" : "user", parts: [
        ...(message.content === "" ? [] : [{ text: message.content }]),
        ...(message.toolCalls ?? []).map((call) => ({ functionCall: { id: call.id, name: call.name, args: call.arguments }, ...geminiThoughtSignature(call.providerState) })),
      ] };
    }),
    systemInstruction: request.messages.some(({ role }) => role === "system") ? { parts: request.messages.filter(({ role }) => role === "system").map(({ content }) => ({ text: content })) } : undefined,
    // The *JsonSchema fields take standard JSON Schema. The older `parameters`/`responseSchema`
    // accept only an OpenAPI subset and reject `additionalProperties` (observed live, P03).
    tools: request.tools === undefined ? undefined : [{ functionDeclarations: request.tools.map((tool) => ({ name: tool.name, description: tool.description, parametersJsonSchema: tool.inputSchema })) }],
    generationConfig: { maxOutputTokens: request.maximumOutputTokens,
      responseMimeType: request.responseSchema === undefined ? undefined : "application/json", responseJsonSchema: request.responseSchema, thinkingConfig: request.effortParams } }),
  parse(body, request, headers) {
    const root = object(body, "gemini response");
    const feedback = object(root["promptFeedback"] ?? {}, "prompt feedback");
    const blockReason = string(feedback["blockReason"]);
    const blocked = blockReason !== null && blockReason !== "BLOCK_REASON_UNSPECIFIED";
    const candidate = object(array(root["candidates"])[0] ?? (blocked ? {} : undefined), "candidate");
    const finishReason = string(candidate["finishReason"]);
    assertOutputComplete(finishReason === "MAX_TOKENS");
    const refusal = blocked ? blockReason : ["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"].includes(finishReason ?? "") ? string(candidate["finishMessage"]) ?? finishReason : null;
    const content = object(candidate["content"] ?? (refusal === null ? undefined : {}), "candidate content"); let text: string | null = null; const calls = [];
    for (const item of array(content["parts"])) {
      const part = object(item, "candidate part");
      if (typeof part["text"] === "string" && part["thought"] !== true) text = `${text ?? ""}${part["text"]}`;
      if (part["functionCall"] !== undefined) { const call = object(part["functionCall"], "function call");
        const signature = string(part["thoughtSignature"]);
        calls.push({ id: string(call["id"]) ?? `gemini-call-${calls.length}`, name: string(call["name"]) ?? "", arguments: call["args"], ...(signature === null ? {} : { providerState: { thoughtSignature: signature } }) }); }
    }
    const usage = object(root["usageMetadata"] ?? {}, "usage");
    return response(request, { text, toolCalls: calls,
      refusal, usage: { inputTokens: number(usage["promptTokenCount"]), outputTokens: number(usage["candidatesTokenCount"]),
        cacheReadTokens: number(usage["cachedContentTokenCount"]) }, requestId: string(root["responseId"]) ?? headers["x-request-id"] ?? null });
  },
};
function geminiThoughtSignature(state: unknown): { thoughtSignature?: string } {
  const signature = state !== null && typeof state === "object" ? (state as Record<string, unknown>)["thoughtSignature"] : undefined;
  return typeof signature === "string" ? { thoughtSignature: signature } : {};
}
export class GeminiNativeTransport extends JsonProtocolTransport {
  constructor(config: TransportConfiguration, client?: HttpClient, credential?: (name: string) => string | undefined) { super(config, geminiNativeCodec, client, credential); }
}
