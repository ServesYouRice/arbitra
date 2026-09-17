import { describe, expect, it } from "vitest";
import { ProviderRegistry, type ProviderEndpoint } from "../src/registry.js";
import type { HttpClient, HttpRequest } from "../src/transport-contract.js";

const endpoint = (overrides: Partial<ProviderEndpoint> = {}): ProviderEndpoint => ({
  id: "primary", providerId: "provider", transport: "openai-chat",
  endpoint: "https://primary.example/v1", apiKeyEnvVar: "PRIMARY_KEY", ...overrides,
});

describe("provider endpoint registry", () => {
  it("dispatches all native protocols and compatible endpoints together with isolated credentials", async () => {
    const requests: HttpRequest[] = [];
    const bodies = [
      { output_text: "responses" },
      { choices: [{ message: { content: "chat" } }] },
      { content: [{ type: "text", text: "anthropic" }] },
      { candidates: [{ content: { parts: [{ text: "gemini" }] } }] },
      { choices: [{ message: { content: "compatible" } }] },
    ];
    const client: HttpClient = { async send(request) { requests.push(request); return { status: 200, headers: {}, body: bodies.shift() }; } };
    const bindings = [
      endpoint({ id: "responses", providerId: "openai", transport: "openai-responses", apiKeyEnvVar: "OPENAI_KEY" }),
      endpoint({ id: "chat", providerId: "openai", apiKeyEnvVar: "OPENAI_KEY" }),
      endpoint({ id: "anthropic", providerId: "anthropic", transport: "anthropic-messages", apiKeyEnvVar: "ANTHROPIC_KEY" }),
      endpoint({ id: "gemini", providerId: "google", transport: "gemini-native", endpoint: "https://google.example/v1beta", apiKeyEnvVar: "GOOGLE_KEY" }),
      endpoint({ id: "compatible", providerId: "other-service", endpoint: "https://other.example/api", apiKeyEnvVar: "OTHER_KEY" }),
    ];
    const registry = new ProviderRegistry(bindings, { client, credential: (name) => `credential-for-${name}` });
    const texts = [];
    for (const binding of bindings) {
      const transport = registry.transports[binding.id];
      if (transport === undefined) throw new Error("MISSING_TEST_TRANSPORT");
      texts.push((await transport.send({ modelId: "configured-model", messages: [{ role: "user", content: "hello" }], maximumOutputTokens: 10 }, new AbortController().signal)).text);
    }
    expect(texts).toEqual(["responses", "chat", "anthropic", "gemini", "compatible"]);
    expect(requests.map(({ url }) => url)).toEqual([
      "https://primary.example/v1/responses", "https://primary.example/v1/chat/completions",
      "https://primary.example/v1/messages", "https://google.example/v1beta/models/configured-model:generateContent",
      "https://other.example/api/chat/completions",
    ]);
    expect(requests.map(({ headers }) => headers["authorization"] ?? headers["x-api-key"] ?? headers["x-goog-api-key"])).toEqual([
      "Bearer credential-for-OPENAI_KEY", "Bearer credential-for-OPENAI_KEY", "credential-for-ANTHROPIC_KEY",
      "credential-for-GOOGLE_KEY", "Bearer credential-for-OTHER_KEY",
    ]);
  });

  it("resolves credentials at call time so rotation does not require rebuilding the registry", async () => {
    let credential = "first";
    const headers: string[] = [];
    const registry = new ProviderRegistry([endpoint()], {
      credential: () => credential,
      client: { async send(request) { headers.push(request.headers["authorization"] ?? ""); return { status: 200, headers: {}, body: { choices: [{ message: { content: "ok" } }] } }; } },
    });
    const transport = registry.transports["primary"];
    if (transport === undefined) throw new Error("MISSING_TEST_TRANSPORT");
    const request = { modelId: "model", messages: [], maximumOutputTokens: 10 };
    await transport.send(request, new AbortController().signal);
    credential = "second";
    await transport.send(request, new AbortController().signal);
    expect(headers).toEqual(["Bearer first", "Bearer second"]);
  });

  it("rejects duplicate bindings, unknown protocols, and model/endpoint identity mismatches", () => {
    expect(() => new ProviderRegistry([endpoint(), endpoint()])).toThrow("DUPLICATE_PROVIDER_ENDPOINT");
    expect(() => new ProviderRegistry([endpoint({ transport: "toString" })])).toThrow("UNKNOWN_TRANSPORT");
    const registry = new ProviderRegistry([endpoint()]);
    expect(() => registry.binding("primary", { providerId: "other", transport: "openai-chat" })).toThrow("MODEL_ENDPOINT_MISMATCH");
    expect(() => registry.binding("__proto__")).toThrow("UNKNOWN_PROVIDER_ENDPOINT");
  });

  it("adds custom protocols without removing the built-in transports", () => {
    const registry = new ProviderRegistry([endpoint(), endpoint({ id: "custom", transport: "custom-protocol" })], {
      factories: { "custom-protocol": () => ({ id: "custom-protocol", async send() { throw new Error("fixture only"); } }) },
    });
    expect(registry.transports["primary"]?.id).toBe("openai-chat");
    expect(registry.transports["custom"]?.id).toBe("custom-protocol");
  });

  it.each([
    { endpoint: "https://user:password@example.test" },
    { endpoint: "https://example.test/?key=secret" },
    { endpoint: "file:///tmp/provider" },
    { apiKeyEnvVar: "literal-secret" },
  ])("rejects invalid or credential-bearing configuration %j", (invalid) => {
    expect(() => new ProviderRegistry([endpoint(invalid)])).toThrow();
  });
});
