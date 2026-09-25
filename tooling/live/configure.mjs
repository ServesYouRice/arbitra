#!/usr/bin/env node
// Materialize live-acceptance configurations (completion plan P03) from the model-backed
// examples, rebinding every model role to the endpoints actually funded for this run.
//
//   node tooling/live/configure.mjs <bindings.json> <output-directory>
//
// bindings.json: { "endpoints": [ProviderEndpoint...], "profiles": { "<endpoint id>": { modelId, family, ... } },
//                  "assign": { "<example>": { "<model role>": "<endpoint id>" } }, "overrides": { "<example>": {...} } }
// Each model role keeps the example's capability tier and role wiring; provider, transport,
// model identity, structured-output dialect and independence group come from the binding.
// Nothing here reads or writes credentials: endpoints name environment variables only.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [bindingsPath, output] = process.argv.slice(2);
if (bindingsPath === undefined || output === undefined) throw new Error("usage: configure.mjs <bindings.json> <output-directory>");
const bindings = JSON.parse(readFileSync(resolve(bindingsPath), "utf8"));
const examples = new URL("../../examples/model-backed/", import.meta.url);
const dialects = { "gemini-native": "gemini", "openai-chat": "json_mode", "openai-responses": "openai_strict", "anthropic-messages": "anthropic_tool" };
const history = { "gemini-native": "round_trip_opaque", "openai-chat": "strip_reasoning", "openai-responses": "round_trip_opaque", "anthropic-messages": "round_trip_opaque" };

mkdirSync(resolve(output), { recursive: true });
for (const [example, assignment] of Object.entries(bindings.assign)) {
  const config = JSON.parse(readFileSync(new URL(`${example}.json`, examples), "utf8"));
  const used = new Set();
  for (const [role, endpointId] of Object.entries(assignment)) {
    const endpoint = bindings.endpoints.find(({ id }) => id === endpointId);
    const profile = bindings.profiles[endpointId];
    if (config.models[role] === undefined || endpoint === undefined || profile === undefined) throw new Error(`BINDING_INVALID:${example}:${role}:${endpointId}`);
    config.models[role] = { ...config.models[role], provider: endpoint.providerId, transport: endpoint.transport, modelId: profile.modelId, family: profile.family,
      independenceGroup: profile.independenceGroup ?? endpointId, structuredOutputDialect: profile.structuredOutputDialect ?? dialects[endpoint.transport],
      supports: { ...config.models[role].supports, ...profile.supports }, limits: { ...config.models[role].limits, ...profile.limits },
      quirks: { ...config.models[role].quirks, historyPolicy: history[endpoint.transport] } };
    config.workflow.modelExecution.modelEndpoints[role] = endpointId;
    used.add(endpointId);
  }
  const endpoints = bindings.endpoints.filter(({ id }) => used.has(id));
  config.workflow.modelExecution.endpoints = endpoints;
  config.workflow.modelExecution.rateLimits = Object.fromEntries([...new Set(endpoints.map(({ providerId }) => providerId))].map((provider) => [provider, bindings.providerRateLimits?.[provider] ?? bindings.rateLimit ?? { rpm: 15, tpm: 1_000_000, maxConcurrent: 2 }]));
  const merged = deepMerge(config, bindings.overrides?.[example] ?? {});
  writeFileSync(join(resolve(output), `${example}.json`), `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`${example}: ${Object.entries(assignment).map(([role, id]) => `${role}->${id}`).join(", ")}`);
}

function deepMerge(base, patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) result[key] = base?.[key] !== undefined && typeof base[key] === "object" && !Array.isArray(base[key]) ? deepMerge(base[key], value) : value;
  return result;
}
