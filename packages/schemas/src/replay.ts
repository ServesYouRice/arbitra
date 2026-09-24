import { z } from "zod";
import { runConfigSchema } from "./config.js";
import { testingWriteAuthorizationSchema } from "./testing-executor.js";

const text = z.string().refine((value) => value.trim().length > 0, "Expected nonempty text");

/**
 * Replay creates a new run from a saved source run. Each mode has its own contract:
 * Audit replays reuse round-zero discovery under new consensus policy, while Feature and
 * Testing replays reuse only saved stages whose recorded identity still matches.
 */
export const auditReplayRequestSchema = z.strictObject({
  mode: z.literal("audit"),
  consensusPolicy: z.enum(["full", "risk_weighted", "minimal"]),
  maximumRounds: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  criticEnabled: z.boolean(),
});

/**
 * `configuration` replaces the source run's saved configuration for the new run and must
 * keep its mode. Omitted, the source configuration is reused unchanged.
 */
export const featureReplayRequestSchema = z.strictObject({
  mode: z.literal("feature"),
  configuration: runConfigSchema.optional(),
  /**
   * `reapprove` (the default) derives requirements again, reusing a compatible saved draft,
   * and requires fresh interactive approval. `reuse_approved` names the source run's exact
   * current approved contract; it fails when that contract is stale or incompatible.
   */
  requirements: z.discriminatedUnion("decision", [
    z.strictObject({ decision: z.literal("reapprove") }),
    z.strictObject({ decision: z.literal("reuse_approved"), artifactId: text }),
  ]).optional(),
});

/**
 * Testing replay must choose its execution explicitly. `plan` never dispatches writers or
 * checks. `execute` is a new execution whose write authority comes only from this request.
 */
export const testingReplayRequestSchema = z.strictObject({
  mode: z.literal("testing"),
  configuration: runConfigSchema.optional(),
  execution: z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("plan") }),
    z.strictObject({ mode: z.literal("execute"), authorization: testingWriteAuthorizationSchema }),
  ]),
});

export const replayRequestSchema = z.discriminatedUnion("mode", [auditReplayRequestSchema, featureReplayRequestSchema, testingReplayRequestSchema]);
export type ReplayRequest = z.infer<typeof replayRequestSchema>;
export type AuditReplayRequest = z.infer<typeof auditReplayRequestSchema>;
export type FeatureReplayRequest = z.infer<typeof featureReplayRequestSchema>;
export type TestingReplayRequest = z.infer<typeof testingReplayRequestSchema>;
