import { z } from "zod";

import { modelProfileSchema } from "./model-profile.js";
import { providerExecutionSchema } from "./provider-execution.js";
import { verificationExecutionSchema } from "./verification-execution.js";

export const RUN_CONFIG_SCHEMA_VERSION = 1 as const;

const jsonObjectSchema = z.record(z.string(), z.json());

export const runScopeSchema = z.object({
  kind: z.enum(["repository", "module", "diff"]),
  modules: z.array(z.string().min(1)).optional(),
  base: z.string().min(1).optional(),
  head: z.string().min(1).optional(),
  revisionRange: z.string().min(1).optional(),
  diffMode: z.enum(["staged", "working_tree", "range"]).optional(),
}).strict();

export const runConfigSchema = z.object({
  schemaVersion: z.literal(RUN_CONFIG_SCHEMA_VERSION),
  mode: z.enum(["audit", "feature", "testing"]),
  scope: runScopeSchema,
  auditDepth: z.enum(["fast", "balanced", "deep"]),
  consensusPolicy: z.enum(["full", "risk_weighted", "minimal"]),
  maxConsensusRounds: z.number().int().min(0).max(3),
  verification: jsonObjectSchema.superRefine((verification, context) => {
    if (verification["execution"] !== undefined) {
      const result = verificationExecutionSchema.safeParse(verification["execution"]);
      if (!result.success) for (const issue of result.error.issues) context.addIssue({ ...issue, path: ["execution", ...issue.path] });
    }
    const maximum = verification["maxModelQuestionsPerRound"];
    if (maximum !== undefined && (typeof maximum !== "number" || !Number.isSafeInteger(maximum) || maximum < 0)) {
      context.addIssue({ code: "custom", path: ["maxModelQuestionsPerRound"], message: "Expected a nonnegative safe integer" });
    }
  }),
  models: z.record(z.string(), modelProfileSchema),
  harness: z.object({
    mode: z.enum(["canonical", "native"]),
    profileId: z.string().min(1).optional(),
  }).strict(),
  workflow: jsonObjectSchema.superRefine((workflow, context) => {
    if (workflow["modelExecution"] === undefined) return;
    const result = providerExecutionSchema.safeParse(workflow["modelExecution"]);
    if (!result.success) for (const issue of result.error.issues) context.addIssue({ ...issue, path: ["modelExecution", ...issue.path] });
  }),
  budgets: jsonObjectSchema,
  security: jsonObjectSchema,
  protocols: jsonObjectSchema,
  promptOverrides: jsonObjectSchema,
  contextPolicies: jsonObjectSchema,
}).strict().superRefine((config, context) => {
  if (config.workflow["modelExecution"] === undefined) return;
  const result = providerExecutionSchema.safeParse(config.workflow["modelExecution"]);
  if (!result.success) return;
  const execution = result.data;
  const endpoints = new Map(execution.endpoints.map((endpoint) => [endpoint.id, endpoint]));
  for (const [role, id] of Object.entries(execution.roles ?? {})) {
    if (id !== undefined && !Object.hasOwn(config.models, id)) context.addIssue({ code: "custom", path: ["workflow", "modelExecution", "roles", role], message: "Unknown model profile" });
  }
  for (const [id, model] of Object.entries(config.models)) {
    const endpointId = Object.hasOwn(execution.modelEndpoints, id) ? execution.modelEndpoints[id] : undefined;
    const endpoint = endpointId === undefined ? undefined : endpoints.get(endpointId);
    if (endpoint === undefined || endpoint.providerId !== model.provider || endpoint.transport !== model.transport) {
      context.addIssue({ code: "custom", path: ["workflow", "modelExecution", "modelEndpoints", id], message: "Model requires an endpoint with matching provider and transport" });
    }
  }
  for (const id of Object.keys(execution.modelEndpoints)) {
    if (!Object.hasOwn(config.models, id)) context.addIssue({ code: "custom", path: ["workflow", "modelExecution", "modelEndpoints", id], message: "Unknown model profile" });
  }
});

export const RUN_CONFIG_FIELD_INVENTORY = [
  "mode",
  "scope",
  "auditDepth",
  "consensusPolicy",
  "maxConsensusRounds",
  "verification",
  "models",
  "harness",
  "workflow",
  "budgets",
  "security",
  "protocols",
  "promptOverrides",
  "contextPolicies",
] as const;

export type RunScope = z.infer<typeof runScopeSchema>;
export type RunConfig = z.infer<typeof runConfigSchema>;
export type RunConfigField = typeof RUN_CONFIG_FIELD_INVENTORY[number];
