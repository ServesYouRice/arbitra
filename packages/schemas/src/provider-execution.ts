import { z } from "zod";

const identifier = z.string().trim().min(1);
const endpointUrl = z.string().url().refine((value) => {
  const url = new URL(value);
  return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
}, "Provider endpoints must use HTTP(S) and cannot contain credentials, queries, or fragments");

export const providerEndpointSchema = z.object({
  id: identifier,
  providerId: identifier,
  transport: identifier,
  endpoint: endpointUrl,
  apiKeyEnvVar: z.string().regex(/^[A-Z_][A-Z0-9_]*$/u),
}).strict();

/** Configured limits are operator policy, not a shipped table of provider capabilities. */
export const providerExecutionSchema = z.object({
  endpoints: z.array(providerEndpointSchema).min(1),
  modelEndpoints: z.record(identifier, identifier),
  roles: z.object({ planner: identifier, verifier: identifier, critic: identifier.optional() }).strict().optional(),
  maximumOutputTokens: z.number().int().positive(),
  maximumDiscoveryTokens: z.number().int().positive().optional(),
  maximumContextTokens: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().max(2_147_483_647),
  maximumRetries: z.number().int().min(0).max(10),
  maximumTokens: z.number().int().positive(),
  rateLimits: z.record(identifier, z.object({
    rpm: z.number().int().positive(),
    tpm: z.number().int().positive(),
    maxConcurrent: z.number().int().positive(),
  }).strict()),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  for (const [index, endpoint] of value.endpoints.entries()) {
    if (ids.has(endpoint.id)) context.addIssue({ code: "custom", path: ["endpoints", index, "id"], message: "Duplicate endpoint ID" });
    ids.add(endpoint.id);
    if (!Object.hasOwn(value.rateLimits, endpoint.providerId)) context.addIssue({ code: "custom", path: ["rateLimits", endpoint.providerId], message: "Provider rate policy required" });
  }
  for (const [modelId, endpointId] of Object.entries(value.modelEndpoints)) {
    if (!ids.has(endpointId)) context.addIssue({ code: "custom", path: ["modelEndpoints", modelId], message: "Unknown provider endpoint" });
  }
  if (value.maximumTokens < value.maximumOutputTokens) context.addIssue({ code: "custom", path: ["maximumTokens"], message: "Token budget cannot be smaller than the output reserve" });
  if (value.maximumDiscoveryTokens !== undefined && value.maximumDiscoveryTokens <= value.maximumOutputTokens) context.addIssue({ code: "custom", path: ["maximumDiscoveryTokens"], message: "Discovery context budget must leave room beyond the output reserve" });
  if (value.maximumContextTokens !== undefined && value.maximumContextTokens <= value.maximumOutputTokens) context.addIssue({ code: "custom", path: ["maximumContextTokens"], message: "Context budget must leave room beyond the output reserve" });
});

export type ProviderExecution = z.infer<typeof providerExecutionSchema>;
