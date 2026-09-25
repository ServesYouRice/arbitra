import { z } from "zod";

import { modelProfileSchema } from "./model-profile.js";
import { providerExecutionSchema } from "./provider-execution.js";
import { verificationExecutionSchema } from "./verification-execution.js";
import { featureExecutionSchema } from "./feature-execution.js";
import { testingExecutionSchema } from "./testing.js";
import { checkpointPolicySchema } from "./checkpoint-policy.js";
import { incrementalAuditSchema } from "./incremental.js";

export const RUN_CONFIG_SCHEMA_VERSION = 1 as const;

const jsonObjectSchema = z.record(z.string(), z.json());

export const runScopeSchema = z.object({
  kind: z.enum(["repository", "module", "diff"]),
  modules: z.array(z.string().min(1)).optional(),
  base: z.string().min(1).optional(),
  head: z.string().min(1).optional(),
  revisionRange: z.string().min(1).optional(),
  diffMode: z.enum(["staged", "working_tree", "range"]).optional(),
  /** Repository-relative path prefixes removed from the snapshot, whatever the scope kind. */
  exclude: z.array(z.string().min(1)).optional(),
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
    if (workflow["testing"] !== undefined) {
      const testing = testingExecutionSchema.safeParse(workflow["testing"]);
      if (!testing.success) for (const issue of testing.error.issues) context.addIssue({ ...issue, path: ["testing", ...issue.path] });
    }
    if (workflow["feature"] !== undefined) {
      const feature = featureExecutionSchema.safeParse(workflow["feature"]);
      if (!feature.success) for (const issue of feature.error.issues) context.addIssue({ ...issue, path: ["feature", ...issue.path] });
    }
    if (workflow["incremental"] !== undefined) {
      const incremental = incrementalAuditSchema.safeParse(workflow["incremental"]);
      if (!incremental.success) for (const issue of incremental.error.issues) context.addIssue({ ...issue, path: ["incremental", ...issue.path] });
    }
    if (workflow["checkpoints"] !== undefined) {
      const checkpoints = checkpointPolicySchema.safeParse(workflow["checkpoints"]);
      if (!checkpoints.success) for (const issue of checkpoints.error.issues) context.addIssue({ ...issue, path: ["checkpoints", ...issue.path] });
    }
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
  if (config.workflow["incremental"] !== undefined && config.mode !== "audit") context.addIssue({ code: "custom", path: ["workflow", "incremental"], message: "Incremental reuse applies only to Audit runs" });
  if (config.workflow["testing"] !== undefined) {
    const testing = testingExecutionSchema.safeParse(config.workflow["testing"]);
    if (config.mode !== "testing") context.addIssue({ code: "custom", path: ["workflow", "testing"], message: "Testing settings require testing mode" });
    if (testing.success) for (const id of Object.values(testing.data.roles)) if (!Object.hasOwn(config.models, id)) context.addIssue({ code: "custom", path: ["workflow", "testing", "roles"], message: `Unknown Testing model profile: ${id}` });
    if (testing.success && testing.data.mode === "execute") for (const id of Object.values(testing.data.execution.models)) if (!Object.hasOwn(config.models, id)) context.addIssue({ code: "custom", path: ["workflow", "testing", "execution", "models"], message: `Unknown Testing writer profile: ${id}` });
  }
  if (config.workflow["feature"] !== undefined) {
    const feature = featureExecutionSchema.safeParse(config.workflow["feature"]);
    if (config.mode !== "feature") context.addIssue({ code: "custom", path: ["workflow", "feature"], message: "Feature settings require feature mode" });
    if (feature.success) for (const id of [feature.data.roles.requirements, feature.data.roles.exploration, feature.data.roles.planner, feature.data.roles.critic, ...feature.data.roles.reviewers]) {
      if (id !== undefined && !Object.hasOwn(config.models, id)) context.addIssue({ code: "custom", path: ["workflow", "feature", "roles"], message: `Unknown Feature model profile: ${id}` });
    }
  }
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
