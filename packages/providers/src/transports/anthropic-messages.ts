import type { HttpClient, TransportConfiguration, TransportMessage } from "../transport-contract.js";
import { JsonProtocolTransport, assertOutputComplete, array, number, object, response, string, type ProtocolCodec } from "./json-transport.js";

/**
 * Thinking blocks a reply carried before its tool calls. Claude's API wants them back unchanged, ahead of the
 * `tool_use` blocks, when that turn is replayed with its tool results; they ride on the first call's
 * `providerState`, which arbitra keeps in history without reading it.
 */
interface AnthropicState { readonly anthropicThinking: readonly unknown[] }
const isState = (value: unknown): value is AnthropicState => typeof value === "object" && value !== null && Array.isArray((value as Record<string, unknown>)["anthropicThinking"]);
const thinkingOf = (message: TransportMessage): readonly unknown[] => {
  const state = message.toolCalls?.[0]?.providerState;
  return isState(state) ? state.anthropicThinking : [];
};

/**
 * Effort goes in `output_config.effort` with adaptive thinking; `thinking` takes no effort field (observed live
 * November 10: `thinking.adaptive.effort: Extra inputs are not permitted`). A profile's params map a level to
 * `{ effort: <word> }`, the same shape the CLI dialects send.
 */
function effortOf(params: Readonly<Record<string, string | number | boolean | null>> | undefined): string | undefined {
  const effort = params?.["effort"];
  return typeof effort === "string" && effort !== "" ? effort : undefined;
}

export const anthropicMessagesCodec: ProtocolCodec = {
  id: "anthropic-messages", path: "messages",
  authHeaders: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
  encode(request) {
    const system = request.messages.filter(({ role }) => role === "system").map(({ content }) => content).join("\n");
    const effort = effortOf(request.effortParams);
    const format = request.responseSchema === undefined ? undefined : { type: "json_schema", schema: request.responseSchema };
    const outputConfig = effort === undefined && format === undefined ? undefined : { ...(effort === undefined ? {} : { effort }), ...(format === undefined ? {} : { format }) };
    return { model: request.modelId, system: system || undefined, messages: request.messages.filter(({ role }) => role !== "system").map((message) => {
      if (message.role === "tool") {
        if (!message.toolCallId) throw new Error("TOOL_CALL_ID_REQUIRED");
        return { role: "user", content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }] };
      }
      return { role: message.role, content: message.toolCalls?.length ? [
        ...thinkingOf(message),
        ...(message.content === "" ? [] : [{ type: "text", text: message.content }]),
        ...message.toolCalls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.arguments })),
      ] : message.content };
    }),
      max_tokens: request.maximumOutputTokens, tools: request.tools?.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })),
      output_config: outputConfig,
      // Adaptive thinking is the only mode current Claude models take; effort sets its depth.
      thinking: effort === undefined ? undefined : { type: "adaptive" },
      // Automatic prompt caching: the request's last cacheable block is written, and each later turn of a tool loop
      // reads everything before it. Without it every turn pays the whole conversation at the full input price.
      cache_control: { type: "ephemeral" } };
  },
  parse(body, request, headers) {
    const root = object(body, "anthropic response");
    assertOutputComplete(root["stop_reason"] === "max_tokens");
    if (!Array.isArray(root["content"])) throw new Error("anthropic response content must be an array");
    let text: string | null = null; const calls: { id: string; name: string; arguments: unknown; providerState?: AnthropicState }[] = []; const thinking: unknown[] = [];
    for (const item of array(root["content"])) {
      const part = object(item, "content part");
      if (part["type"] === "thinking" || part["type"] === "redacted_thinking") thinking.push(part);
      if (part["type"] === "text") text = `${text ?? ""}${string(part["text"]) ?? ""}`;
      if (part["type"] === "tool_use") calls.push({ id: string(part["id"]) ?? "", name: string(part["name"]) ?? "", arguments: part["input"] });
    }
    if (calls[0] !== undefined && thinking.length > 0) calls[0] = { ...calls[0], providerState: { anthropicThinking: thinking } };
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
