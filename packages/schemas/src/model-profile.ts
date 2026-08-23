import { z } from "zod";

export const MODEL_PROFILE_SCHEMA_VERSION = 1 as const;

export const capabilityTierSchema = z.enum(["frontier", "balanced", "fast"]);
export const effortLevelSchema = z.enum(["low", "medium", "high", "xhigh"]);

const providerParameterSchema = z.union([z.string(), z.number(), z.boolean()]);

export const modelProfileSchema = z.object({
  schemaVersion: z.literal(MODEL_PROFILE_SCHEMA_VERSION),
  provider: z.string().min(1),
  modelId: z.string().min(1),
  transport: z.string().min(1),
  servedBy: z.string().min(1).nullable(),
  family: z.string().min(1),
  independenceGroup: z.string().min(1),
  capabilityTier: capabilityTierSchema,
  supports: z.object({
    tools: z.boolean(),
    parallelToolCalls: z.boolean(),
    structuredOutput: z.boolean(),
    reasoning: z.boolean(),
    promptCaching: z.boolean(),
    batch: z.boolean(),
    vision: z.boolean(),
  }).strict(),
  limits: z.object({
    contextTokens: z.number().int().positive().nullable(),
    maxOutputTokens: z.number().int().positive().nullable(),
  }).strict(),
  effort: z.object({
    supported: z.array(effortLevelSchema),
    collapse: z.partialRecord(effortLevelSchema, effortLevelSchema),
    params: z.partialRecord(effortLevelSchema, z.record(z.string(), providerParameterSchema)),
  }).strict(),
  quirks: z.object({
    systemPromptSupport: z.enum(["full", "discouraged", "none"]),
    fewShotPolicy: z.enum(["helps", "neutral", "harmful"]),
    promptStyle: z.enum(["xml", "markdown", "plain"]),
    documentPlacement: z.enum(["leading", "trailing"]),
    historyPolicy: z.enum(["strip_reasoning", "round_trip_opaque", "verbatim"]),
    samplingDefaults: z.object({
      temperature: z.number().nullable(),
      topP: z.number().nullable(),
      topK: z.number().nullable(),
    }).strict(),
    greedyDecodingSafe: z.boolean(),
    toolLoopLimit: z.number().int().nonnegative(),
    prefillSupported: z.boolean(),
  }).strict(),
  structuredOutputDialect: z.enum([
    "openai_strict",
    "gemini",
    "anthropic_tool",
    "json_mode",
    "prompt_json",
    "none",
  ]),
}).strict();

export type CapabilityTier = z.infer<typeof capabilityTierSchema>;
export type EffortLevel = z.infer<typeof effortLevelSchema>;
export type ModelProfile = z.infer<typeof modelProfileSchema>;
