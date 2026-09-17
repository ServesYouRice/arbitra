import { describe, expect, it } from "vitest";
import { providerExecutionSchema } from "../src/provider-execution.js";
import { runConfigSchema } from "../src/config.js";
import { readFileSync } from "node:fs";

const valid = {
  endpoints: [{ id: "endpoint", providerId: "provider", transport: "openai-chat", endpoint: "https://provider.example/v1", apiKeyEnvVar: "PROVIDER_KEY" }],
  modelEndpoints: { auditor: "endpoint" }, maximumOutputTokens: 100, timeoutMs: 30_000, maximumRetries: 2,
  maximumTokens: 10_000, rateLimits: { provider: { rpm: 10, tpm: 10_000, maxConcurrent: 2 } },
};

describe("provider execution configuration", () => {
  it("validates model-to-endpoint identity through the public run configuration schema", () => {
    const raw: unknown = JSON.parse(readFileSync(new URL("./golden/run-config.valid.json", import.meta.url), "utf8"));
    const config = runConfigSchema.parse(raw);
    const rawProfile: unknown = JSON.parse(readFileSync(new URL("./golden/model-profile.valid.json", import.meta.url), "utf8"));
    const withModel = runConfigSchema.parse({ ...config, models: { auditor: rawProfile } });
    const model = withModel.models["auditor"];
    if (model === undefined) throw new Error("MISSING_FIXTURE_MODEL");
    const execution = { ...valid, endpoints: [{ ...valid.endpoints[0], providerId: model.provider, transport: model.transport }],
      rateLimits: { [model.provider]: { rpm: 10, tpm: 10_000, maxConcurrent: 2 } } };
    const complete = { ...withModel, workflow: { ...withModel.workflow, modelExecution: execution } };
    expect(runConfigSchema.safeParse(complete).success).toBe(true);
    expect(runConfigSchema.safeParse({ ...complete, models: {} }).success).toBe(false);
    expect(runConfigSchema.safeParse({ ...complete, models: { auditor: { ...model, provider: "different-provider" } } }).success).toBe(false);
    expect(runConfigSchema.safeParse({ ...complete, workflow: { modelExecution: { ...execution, modelEndpoints: {} } } }).success).toBe(false);
  });
  it("accepts explicit operator limits and compatible endpoints without provider-name allowlists", () => {
    expect(providerExecutionSchema.parse(valid)).toEqual(valid);
  });
  it.each([
    { modelEndpoints: { auditor: "missing" } },
    { rateLimits: {} },
    { endpoints: [...valid.endpoints, ...valid.endpoints] },
    { maximumTokens: 1 },
    { maximumRetries: -1 },
    { endpoints: [{ ...valid.endpoints[0], endpoint: "https://provider.example/?key=secret" }] },
    { endpoints: [{ ...valid.endpoints[0], apiKeyEnvVar: "a credential value" }] },
  ])("rejects invalid binding or budget %j", (invalid) => {
    expect(providerExecutionSchema.safeParse({ ...valid, ...invalid }).success).toBe(false);
  });
});
