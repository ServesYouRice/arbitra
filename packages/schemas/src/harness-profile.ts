import { z } from "zod";

export const HARNESS_PROFILE_SCHEMA_VERSION = 1 as const;

export const harnessProfileSchema = z.object({
  schemaVersion: z.literal(HARNESS_PROFILE_SCHEMA_VERSION),
  id: z.string().min(1),
  version: z.string().min(1),
  kind: z.string().min(1),
  capabilities: z.object({
    readFiles: z.boolean(),
    writeFiles: z.boolean(),
    shell: z.boolean(),
    skills: z.boolean(),
    hooks: z.boolean(),
    mcp: z.boolean(),
    subagents: z.boolean(),
    sandbox: z.boolean(),
    resumableSessions: z.boolean(),
    structuredEvents: z.boolean(),
    enforcesExternalPolicy: z.boolean(),
    managesContextInternally: z.boolean(),
    reportsUsage: z.boolean(),
  }).strict(),
  policy: z.object({
    projectInstructions: z.enum(["disabled", "enabled"]),
    network: z.enum(["none", "restricted", "full"]),
    memory: z.enum(["none", "session", "persistent"]),
    subagents: z.boolean(),
    advisor: z.boolean(),
  }).strict(),
}).strict();

export type HarnessProfile = z.infer<typeof harnessProfileSchema>;
