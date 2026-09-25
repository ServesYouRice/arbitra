import { describe, expect, it } from "vitest";
import type { HttpClient, HttpResponse } from "../../src/transport-contract.js";
import { OpenAiChatTransport } from "../../src/transports/openai-chat.js";

const completion = (headers: Record<string, string>): HttpResponse => ({ status: 200, headers,
  body: { id: "chatcmpl-body-id", choices: [{ message: { content: "hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } } });
const send = (response: HttpResponse) => {
  const client: HttpClient = { send: async () => response };
  return new OpenAiChatTransport({ endpoint: "https://compatible.example/v1", apiKeyEnv: "KEY" }, client, () => "fixture")
    .send({ modelId: "m", messages: [{ role: "user", content: "hi" }], maximumOutputTokens: 8 }, new AbortController().signal);
};

describe("openai-chat provider request identity", () => {
  it("prefers the x-request-id header and falls back to the completion id that compatible services send", async () => {
    expect((await send(completion({ "x-request-id": "req-header" }))).providerRequestId).toBe("req-header");
    // Observed live (P13): Gemini's OpenAI-compatible endpoint sends no x-request-id header.
    expect((await send(completion({}))).providerRequestId).toBe("chatcmpl-body-id");
  });
});
