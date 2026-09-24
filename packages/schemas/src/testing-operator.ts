import { z } from "zod";
import { testingTaskVerificationSchema } from "./testing-verification.js";
import { testingWriteAuthorizationSchema } from "./testing-executor.js";

/**
 * The read-only operator view of one Testing run: the immutable configuration and write
 * authority the run was started with, the plan next to what execution actually did, and
 * whether a verified change set exists. Every field is derived from durable run state;
 * nothing here grants authority or decides an outcome.
 */
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const verificationSummarySchema = testingTaskVerificationSchema.pick({ status: true, deterministicFailure: true, reasons: true, checks: true, snapshotFingerprint: true, attemptId: true }).extend({ artifactId: z.string().min(1) });
export type TestingVerificationSummary = z.infer<typeof verificationSummarySchema>;

export const testingOperatorViewSchema = z.strictObject({
  runId: z.string().min(1),
  runState: z.string().min(1),
  configuration: z.strictObject({
    mode: z.enum(["plan", "execute"]),
    goal: z.string(),
    roles: z.strictObject({ analyst: z.string(), planner: z.string() }),
    commands: z.array(z.strictObject({ command: z.string(), evidencePath: z.string() })),
    execution: z.strictObject({
      authorization: testingWriteAuthorizationSchema,
      models: z.strictObject({ fast: z.string(), balanced: z.string(), frontier: z.string() }),
      maximumAttempts: z.number().int(),
      maximumRepairRounds: z.number().int(),
      repairRoundsSource: z.enum(["configured", "default"]),
      sandbox: z.strictObject({ driver: z.literal("docker"), image: z.string(), maximumRuns: z.number().int(), timeoutMs: z.number().int(), network: z.literal("none") }),
      checks: z.array(z.strictObject({ id: z.string(), executable: z.string(), arguments: z.array(z.string()), sourcePaths: z.array(z.string()) })),
      bindings: z.array(z.strictObject({ command: z.string(), checkId: z.string(), expectedExitCode: z.number().int(), authorization: z.enum(["repository_script", "allowlisted", "operator_approved"]) })),
    }).nullable(),
  }),
  planning: z.strictObject({ passed: z.boolean(), reasons: z.array(z.string()), selectedGaps: z.number().int(), testsExecuted: z.literal(false), planFingerprint: z.string().nullable() }).nullable(),
  /** `true` only when planning selected no gaps. This is not evidence of coverage. */
  noWork: z.boolean(),
  tasks: z.array(z.strictObject({
    taskId: z.string(),
    title: z.string(),
    capability: z.enum(["fast", "balanced", "frontier"]),
    writeScope: z.array(z.string()),
    dependsOn: z.array(z.string()),
    commands: z.array(z.strictObject({ command: z.string(), executionPolicy: z.string() })),
    grant: z.strictObject({ partitionId: z.string(), exclusive: z.boolean(), paths: z.array(z.string()) }).nullable(),
    /** The attempt ledger's view; `not_started` when no ledger exists yet. */
    ledgerState: z.enum(["not_started", "pending", "running", "completed", "blocked"]),
    /** The last execution outcome's view of this task, when one was recorded. */
    executionState: z.enum(["completed", "blocked"]).nullable(),
    attempts: z.array(z.strictObject({
      attemptId: z.string(), ordinal: z.number().int(), capability: z.enum(["fast", "balanced", "frontier"]),
      state: z.enum(["reserved", "verified"]), result: z.enum(["passed", "failed", "incomplete"]).nullable(),
      repairVerificationArtifactId: z.string().nullable(),
      verification: verificationSummarySchema.nullable(),
    })),
    finalVerification: verificationSummarySchema.nullable(),
    stale: z.boolean(),
  })),
  execution: z.strictObject({ passed: z.boolean(), reasons: z.array(z.string()), planFingerprint: z.string(), snapshotFingerprint: z.string(), planMatches: z.boolean() }).nullable(),
  repair: z.strictObject({
    rounds: z.array(z.strictObject({
      round: z.number().int(), snapshotFingerprint: hash, failedTaskIds: z.array(z.string()),
      reopened: z.array(z.strictObject({ taskId: z.string(), causeTaskId: z.string(), verificationArtifactId: z.string() })),
      staleTaskIds: z.array(z.string()), state: z.enum(["reopening", "reopened"]),
    })),
    terminal: z.strictObject({ reason: z.string(), snapshotFingerprint: hash }).nullable(),
  }),
  handoff: z.strictObject({
    planArtifactId: z.string().nullable(),
    verifiedChangeSet: z.strictObject({ completionArtifactId: z.string(), changeSetArtifactId: z.string(), files: z.number().int() }).nullable(),
  }),
});
export type TestingOperatorView = z.infer<typeof testingOperatorViewSchema>;

/** Exact verified bytes for download. Applying them still requires `expectedHash` checks. */
export const testingVerifiedChangeSetSchema = z.strictObject({
  runId: z.string().min(1),
  completionArtifactId: z.string().min(1),
  changeSetArtifactId: z.string().min(1),
  changeSet: z.strictObject({
    schemaVersion: z.literal(1),
    planFingerprint: hash,
    baselineFingerprint: hash,
    snapshotFingerprint: hash,
    verificationArtifactIds: z.array(z.string()),
    files: z.array(z.strictObject({ path: z.string().min(1), expectedHash: hash.nullable(), contentHash: hash, content: z.string() })).min(1),
  }),
});
export type TestingVerifiedChangeSet = z.infer<typeof testingVerifiedChangeSetSchema>;
