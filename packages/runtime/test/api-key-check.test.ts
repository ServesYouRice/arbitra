import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runConfigSchema, type RunConfig } from "@arbitra/schemas/config.js";
import type { HttpClient, HttpRequest, HttpResponse } from "@arbitra/providers/transport-contract.js";
import { apiKeyChecks } from "../src/api-key-check.js";

async function mixed(models: Readonly<Record<string, string>>): Promise<RunConfig> {
  const value = JSON.parse(await readFile(new URL("../../../examples/model-backed/audit-mixed-providers.json", import.meta.url), "utf8")) as { models: Record<string, { modelId: string }> };
  for (const [id, modelId] of Object.entries(models)) if (value.models[id] !== undefined) value.models[id].modelId = modelId;
  return runConfigSchema.parse(value);
}
function client(answer: (request: HttpRequest) => HttpResponse): HttpClient & { readonly requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  return { requests, send: async (request) => { requests.push(request); return answer(request); } };
}
const json = (status: number, body: unknown): HttpResponse => ({ status, headers: {}, body });
const keys: Readonly<Record<string, string>> = { ARBITRA_ANTHROPIC_API_KEY: "sk-ant-api03-aaaaaaaaaaaa", ARBITRA_OPENAI_API_KEY: "sk-proj-bbbbbbbbbbbb" };
const credential = (name: string) => keys[name];

describe("the API key check of a lineup", () => {
  it("says for each key endpoint whether its key is accepted and its models known, and refuses a start that would fail", async () => {
    // auditor-b runs on Anthropic, auditor-a on OpenAI, auditor-c on Gemini (whose key is not set).
    const config = await mixed({ "auditor-a": "gpt-5.5", "auditor-b": "claude-opus-9", "auditor-c": "gemini-3-pro" });
    const http = client((request) => request.url.includes("anthropic") ? json(404, { type: "error", error: { type: "not_found_error", message: "model: claude-opus-9" } }) : json(401, { error: { type: "invalid_request_error", code: "invalid_api_key", message: "Incorrect API key provided" } }));
    const { checks, diagnostics } = await apiKeyChecks(config, { credential, client: http, cache: new Map() });
    expect(checks).toEqual([
      { endpointId: "anthropic", providerId: "anthropic", variable: "ARBITRA_ANTHROPIC_API_KEY", state: "accepted", models: [{ profiles: ["auditor-b"], modelId: "claude-opus-9", known: false }], detail: null, cost: "models_route" },
      { endpointId: "gemini", providerId: "google", variable: "ARBITRA_GEMINI_API_KEY", state: "missing", models: [{ profiles: ["auditor-c"], modelId: "gemini-3-pro", known: null }], detail: null, cost: "none" },
      { endpointId: "openai", providerId: "openai", variable: "ARBITRA_OPENAI_API_KEY", state: "refused", models: [{ profiles: ["auditor-a"], modelId: "gpt-5.5", known: null }], detail: "invalid_request_error/invalid_api_key Incorrect API key provided", cost: "models_route" }]);
    // A missing key is already said by the environment check; the others are problems a run would meet at its first call.
    expect(diagnostics.map(({ code, severity, scope, path }) => ({ code, severity, scope, path }))).toEqual([
      { code: "PROVIDER_MODEL_UNKNOWN:auditor-b", severity: "error", scope: "environment", path: "models.auditor-b.modelId" },
      { code: "PROVIDER_KEY_REFUSED:openai", severity: "error", scope: "environment", path: "workflow.modelExecution.endpoints.2.apiKeyEnvVar" }]);
    expect(diagnostics[0]?.message).toBe("anthropic has no model \"claude-opus-9\" for the key in ARBITRA_ANTHROPIC_API_KEY (profile auditor-b). Check the model's name, or whether this key's account may use it.");
    expect(JSON.stringify({ checks, diagnostics })).not.toMatch(/aaaaaaaa|bbbbbbbb/u);
  });

  it("never asks about a template's placeholder model, and keeps an accepted answer for a while", async () => {
    const config = await mixed({ "auditor-b": "claude-opus-5-5" });
    const http = client(() => json(200, { data: [] }));
    const cache = new Map();
    const first = await apiKeyChecks(config, { credential, client: http, cache });
    expect(first.checks.find(({ endpointId }) => endpointId === "openai")).toMatchObject({ state: "accepted", models: [] });
    expect(http.requests.map(({ url }) => url)).toEqual(["https://api.anthropic.com/v1/models/claude-opus-5-5", "https://api.openai.com/v1/models"]);
    // The New run page checks again as the lineup is edited; an accepted key is not asked again each time.
    const again = await apiKeyChecks(config, { credential, client: http, cache });
    expect(again.checks).toEqual(first.checks);
    expect(http.requests).toHaveLength(2);
    // A changed key is asked again.
    await apiKeyChecks(config, { credential: (name) => name === "ARBITRA_ANTHROPIC_API_KEY" ? "sk-ant-api03-cccccccccccc" : credential(name), client: http, cache });
    expect(http.requests).toHaveLength(3);
  });

  it("notes a key it could not check, and does not stop the start for it", async () => {
    const config = await mixed({ "auditor-b": "claude-opus-5-5" });
    const { diagnostics } = await apiKeyChecks(config, { credential: (name) => name === "ARBITRA_ANTHROPIC_API_KEY" ? keys[name] : undefined, client: client(() => json(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } })), cache: new Map() });
    expect(diagnostics).toEqual([expect.objectContaining({ code: "PROVIDER_KEY_UNCHECKED:anthropic", severity: "warning" })]);
  });
});
