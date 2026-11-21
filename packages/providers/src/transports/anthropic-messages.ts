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

/**
 * The first message's text as content blocks, the start every call of its stage shares (`sharedStart`) in a block of
 * its own marked for the cache; the plain text when it marks no such start. The API reads a cache entry only at the
 * exact end of a marked block, and a call's first turn otherwise marks only its own end, which no other call sends:
 * observed live (November 11, 2026, Opus through the API), none of 98 first discovery calls and 305 first verification
 * questions read anything, though all began alike, and cache writes were 58% of the run's cost. The mark is left off
 * where it would cut a surrogate pair.
 */
function sharedStartBlocks(message: TransportMessage): string | readonly unknown[] {
  const end = message.sharedStart;
  if (end === undefined || !Number.isSafeInteger(end) || end <= 0 || end > message.content.length) return message.content;
  const last = message.content.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) return message.content;
  const shared = { type: "text", text: message.content.slice(0, end), cache_control: { type: "ephemeral" } };
  return end === message.content.length ? [shared] : [shared, { type: "text", text: message.content.slice(end) }];
}

export const anthropicMessagesCodec: ProtocolCodec = {
  id: "anthropic-messages", path: "messages",
  authHeaders: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
  encode(request) {
    const system = request.messages.filter(({ role }) => role === "system").map(({ content }) => content).join("\n");
    const effort = effortOf(request.effortParams);
    const format = request.responseSchema === undefined ? undefined : { type: "json_schema", schema: request.responseSchema };
    const outputConfig = effort === undefined && format === undefined ? undefined : { ...(effort === undefined ? {} : { effort }), ...(format === undefined ? {} : { format }) };
    // Prompt caching. The cache is read by prefix (tools, then system, then messages) and only at a marked block's end;
    // a request may carry four marks, the top-level one included, and this one carries at most three. The system
    // prompt is the stage's own instructions, so its end is marked; the first message marks the end of the start every
    // call of the stage shares; and the top-level mark is written at the request's last block, which each later turn
    // of a tool loop reads back. More marks cost nothing: a token is billed once, as written or read (Anthropic's
    // prompt caching guide, read November 21, 2026). A start below the model's least cacheable length (512 tokens on
    // the 5.5 models, up to 4,096 on older ones) is not cached, silently.
    // Every mark lives five minutes, the API's default, and each read renews it. An hour would cost twice the input
    // price to write against 1.25 times, and pays only across gaps of five to sixty minutes between calls that share a
    // start: observed live (November 11, 2026), discovery's 755 API calls had no gap over five minutes and checking's
    // 1,097 had one, a 24-minute stop for a restart.
    return { model: request.modelId, system: system === "" ? undefined : [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: request.messages.filter(({ role }) => role !== "system").map((message, index) => {
        if (message.role === "tool") {
          if (!message.toolCallId) throw new Error("TOOL_CALL_ID_REQUIRED");
          return { role: "user", content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }] };
        }
        return { role: message.role, content: message.toolCalls?.length ? [
          ...thinkingOf(message),
          ...(message.content === "" ? [] : [{ type: "text", text: message.content }]),
          ...message.toolCalls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.arguments })),
        ] : index === 0 ? sharedStartBlocks(message) : message.content };
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
