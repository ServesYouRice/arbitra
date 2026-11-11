import { describe, expect, it } from "vitest";
import { checkApiKey } from "../src/key-check.js";
import type { HttpClient, HttpRequest, HttpResponse } from "../src/transport-contract.js";

const KEY = "sk-ant-api03-secretsecretsecret";

function client(answer: (request: HttpRequest) => HttpResponse): HttpClient & { readonly requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  return { requests, send: async (request) => { requests.push(request); return answer(request); } };
}
const json = (status: number, body: unknown): HttpResponse => ({ status, headers: {}, body });
const anthropic = { transport: "anthropic-messages", endpoint: "https://api.anthropic.com/v1", apiKeyEnvVar: "ANTHROPIC_KEY" };
const credential = (name: string) => name === "ANTHROPIC_KEY" || name === "OPENAI_KEY" || name === "GEMINI_KEY" ? KEY : undefined;

describe("checking an API key before a run starts", () => {
  // Observed live (memoria, November 2026): the Anthropic API route had never run against a current model, and only
  // starting the run showed that every call was refused. The check asks the provider's models route: no generation.
  it("asks Anthropic's models route for each model, and says the key is accepted and the model known", async () => {
    const http = client((request) => request.url.endsWith("/claude-opus-5-5") ? json(200, { id: "claude-opus-5-5", type: "model" }) : json(404, { type: "error", error: { type: "not_found_error", message: "model: claude-opus-9" } }));
    const result = await checkApiKey(anthropic, ["claude-opus-5-5", "claude-opus-9", "claude-opus-5-5"], { credential, client: http });
    expect(result).toEqual({ state: "accepted", models: [{ modelId: "claude-opus-5-5", known: true }, { modelId: "claude-opus-9", known: false }], detail: null, cost: "models_route" });
    expect(http.requests.map(({ url, method, body }) => ({ url, method, body }))).toEqual([
      { url: "https://api.anthropic.com/v1/models/claude-opus-5-5", method: "GET", body: undefined },
      { url: "https://api.anthropic.com/v1/models/claude-opus-9", method: "GET", body: undefined }]);
    // The key goes only to the provider, in its own header.
    expect(http.requests[0]?.headers).toMatchObject({ "x-api-key": KEY, "anthropic-version": "2023-06-01" });
  });

  it("says a key the provider refuses is refused, and never repeats the key", async () => {
    const http = client(() => json(401, { type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${KEY}` } }));
    const result = await checkApiKey(anthropic, ["claude-opus-5-5"], { credential, client: http });
    expect(result?.state).toBe("refused");
    expect(result?.models).toEqual([{ modelId: "claude-opus-5-5", known: null }]);
    expect(JSON.stringify(result)).not.toContain("secretsecret");
  });

  it("says a key that is not set is missing, and asks nothing", async () => {
    const http = client(() => json(200, {}));
    expect(await checkApiKey({ ...anthropic, apiKeyEnvVar: "UNSET_KEY" }, ["claude-opus-5-5"], { credential, client: http })).toMatchObject({ state: "missing" });
    expect(http.requests).toEqual([]);
  });

  it("says the check could not be made when the provider cannot be reached or answers otherwise", async () => {
    const down: HttpClient = { send: async () => { throw Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } }); } };
    expect(await checkApiKey(anthropic, ["claude-opus-5-5"], { credential, client: down })).toMatchObject({ state: "unchecked", models: [{ modelId: "claude-opus-5-5", known: null }] });
    const busy = client(() => json(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
    expect(await checkApiKey(anthropic, ["claude-opus-5-5"], { credential, client: busy })).toMatchObject({ state: "unchecked", detail: expect.stringContaining("529") });
    // A key of no known shape that the provider echoes is taken out of its words too.
    const echo = client(() => json(500, { type: "error", error: { type: "api_error", message: "upstream saw plainkey1234567890" } }));
    const echoed = await checkApiKey(anthropic, ["claude-opus-5-5"], { credential: () => "plainkey1234567890", client: echo });
    expect(echoed?.detail).toBe("HTTP 500: api_error upstream saw <redacted>");
  });

  it("reads an OpenAI-compatible provider's model list once", async () => {
    const http = client(() => json(200, { object: "list", data: [{ id: "gpt-5.5" }, { id: "models/gemini-3-pro" }] }));
    const result = await checkApiKey({ transport: "openai-chat", endpoint: "https://example.test/v1", apiKeyEnvVar: "OPENAI_KEY" }, ["gpt-5.5", "gemini-3-pro", "gpt-9"], { credential, client: http });
    expect(result).toEqual({ state: "accepted", models: [{ modelId: "gpt-5.5", known: true }, { modelId: "gemini-3-pro", known: true }, { modelId: "gpt-9", known: false }], detail: null, cost: "models_route" });
    expect(http.requests.map(({ url }) => url)).toEqual(["https://example.test/v1/models"]);
    expect(http.requests[0]?.headers).toEqual({ authorization: `Bearer ${KEY}` });
  });

  it("asks Gemini's models route, and reads its invalid-key answer as refused", async () => {
    const http = client(() => json(400, { error: { code: 400, status: "INVALID_ARGUMENT", message: "API key not valid. Please pass a valid API key.", details: [{ reason: "API_KEY_INVALID" }] } }));
    const result = await checkApiKey({ transport: "gemini-native", endpoint: "https://generativelanguage.googleapis.com/v1beta", apiKeyEnvVar: "GEMINI_KEY" }, ["gemini-3-pro"], { credential, client: http });
    expect(result?.state).toBe("refused");
    expect(http.requests[0]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro");
    expect(http.requests[0]?.headers).toEqual({ "x-goog-api-key": KEY });
  });

  it("checks the key alone on the models list when no model is named", async () => {
    const http = client(() => json(200, { data: [] }));
    expect(await checkApiKey(anthropic, [], { credential, client: http })).toEqual({ state: "accepted", models: [], detail: null, cost: "models_route" });
    expect(http.requests.map(({ url }) => url)).toEqual(["https://api.anthropic.com/v1/models"]);
  });

  it("leaves a transport it has no cheap check for alone", async () => {
    expect(await checkApiKey({ transport: "custom-wire", endpoint: "https://example.test", apiKeyEnvVar: "OPENAI_KEY" }, ["m"], { credential, client: client(() => json(200, {})) })).toBeNull();
  });
});
