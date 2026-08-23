import { z } from "zod";

import { modelProfileSchema } from "./model-profile.js";

export const RUN_CONFIG_SCHEMA_VERSION = 1 as const;

const jsonObjectSchema = z.record(z.string(), z.json());

export const runScopeSchema = z.object({
  kind: z.enum(["repository", "module", "diff"]),
  modules: z.array(z.string().min(1)).optional(),
  base: z.string().min(1).optional(),
  head: z.string().min(1).optional(),
  revisionRange: z.string().min(1).optional(),
}).strict();

export const runConfigSchema = z.object({
  schemaVersion: z.literal(RUN_CONFIG_SCHEMA_VERSION),
  mode: z.enum(["audit", "feature", "testing"]),
  scope: runScopeSchema,
  auditDepth: z.enum(["fast", "balanced", "deep"]),
  consensusPolicy: z.enum(["full", "risk_weighted", "minimal"]),
  maxConsensusRounds: z.number().int().min(0).max(3),
  verification: jsonObjectSchema,
  models: z.record(z.string(), modelProfileSchema),
  harness: z.object({
    mode: z.enum(["canonical", "native"]),
    profileId: z.string().min(1).optional(),
  }).strict(),
  workflow: jsonObjectSchema,
  budgets: jsonObjectSchema,
  security: jsonObjectSchema,
  protocols: jsonObjectSchema,
  promptOverrides: jsonObjectSchema,
  contextPolicies: jsonObjectSchema,
}).strict();

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
