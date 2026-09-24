import { createHash } from "node:crypto";
import { canonicalJson } from "@arbitra/core/config/config-store.js";
import type { RunConfig } from "@arbitra/schemas/config.js";
import { planIRSchema, type PlanIR } from "@arbitra/schemas/plan.js";
import { testingExecutionSchema } from "@arbitra/schemas/testing.js";
import { testingOperatorViewSchema, testingVerifiedChangeSetSchema, type TestingOperatorView, type TestingVerificationSummary, type TestingVerifiedChangeSet } from "@arbitra/schemas/testing-operator.js";
import { testingTaskVerificationSchema } from "@arbitra/schemas/testing-verification.js";
import type { RunStore } from "./run-store.js";
import type { TestingOutcome } from "./testing-pipeline.js";
import type { TestingPlanExecutionOutcome } from "./testing-plan-executor.js";
import { DEFAULT_TESTING_REPAIR_ROUNDS, type TestingRepairRound } from "./testing-repair.js";
import { TestingTaskAttempts } from "./testing-task-attempts.js";

/**
 * Compose the operator's read-only Testing view from durable run state. It reads the
 * immutable run configuration, the attempt ledgers, verification evidence and repair
 * lineage; it never writes, dispatches or re-derives an outcome.
 */
export async function testingOperatorView(store: RunStore, runId: string, runState: string, config: RunConfig): Promise<TestingOperatorView> {
  const settings = testingExecutionSchema.parse(config.workflow["testing"]);
  const descriptors = await store.listArtifacts();
  const read = async <T>(kind: string): Promise<T | null> => {
    const descriptor = descriptors.find((item) => item.kind === kind);
    return descriptor === undefined ? null : await store.artifacts.get<T>(descriptor.ref);
  };
  const execution = settings.mode === "execute" ? settings.execution : null;
  const planning = await read<TestingOutcome>("testing-outcome");
  const outcome = await read<TestingPlanExecutionOutcome>("testing-execution-outcome");
  const planValue = await read<unknown>("plan-ir");
  const plan: PlanIR | null = planValue === null ? null : planIRSchema.parse(planValue);
  const lineage = await read<{ rounds: readonly TestingRepairRound[]; terminal?: { reason: string; snapshotFingerprint: string } }>("testing-repair-lineage");
  const verification = async (artifactId: string | undefined): Promise<TestingVerificationSummary | null> => {
    if (artifactId === undefined) return null;
    const descriptor = descriptors.find((item) => item.artifactId === artifactId && item.kind.startsWith("testing-task-verification-"));
    if (descriptor === undefined) return null;
    const parsed = testingTaskVerificationSchema.parse(await store.artifacts.get(descriptor.ref));
    return { artifactId, attemptId: parsed.attemptId, status: parsed.status, deterministicFailure: parsed.deterministicFailure, reasons: parsed.reasons, checks: parsed.checks, snapshotFingerprint: parsed.snapshotFingerprint };
  };
  const rounds = lineage?.rounds ?? [];
  const tasks = [];
  for (const task of plan?.tasks ?? []) {
    const grantRequest = execution?.authorization.tasks.find(({ taskId }) => taskId === task.id);
    const partition = execution?.authorization.partitions.find(({ id }) => id === grantRequest?.partitionId);
    let ledgerState: TestingOperatorView["tasks"][number]["ledgerState"] = "not_started";
    let attempts: TestingOperatorView["tasks"][number]["attempts"] = [];
    if (execution !== null && descriptors.some(({ kind }) => kind === `testing-task-attempts-${hash(task.id)}`)) {
      const status = await new TestingTaskAttempts(store, task, execution.verification, execution.maximumAttempts).status();
      ledgerState = status.state;
      attempts = await Promise.all(status.attempts.map(async (attempt) => ({
        attemptId: attempt.id, ordinal: attempt.ordinal, capability: attempt.capability, state: attempt.state, result: attempt.result ?? null,
        repairVerificationArtifactId: attempt.repairVerificationArtifactId ?? null, verification: await verification(attempt.verificationArtifactId),
      })));
    }
    const final = outcome?.finalVerification.find(({ taskId }) => taskId === task.id);
    const finalSummary = final === undefined ? null : { artifactId: final.artifactId, attemptId: final.attemptId, status: final.status, deterministicFailure: final.deterministicFailure, reasons: [...final.reasons], checks: final.checks.map((check) => ({ ...check })), snapshotFingerprint: final.snapshotFingerprint };
    const touched = rounds.some(({ staleTaskIds, reopened }) => staleTaskIds.includes(task.id) || reopened.some(({ taskId }) => taskId === task.id));
    tasks.push({
      taskId: task.id, title: task.title, capability: task.routing.capability, writeScope: [...task.scope.likelyFiles], dependsOn: [...task.dependencies.dependsOn],
      commands: task.verification.commands.map(({ command, executionPolicy }) => ({ command, executionPolicy })),
      grant: grantRequest === undefined || partition === undefined ? null : { partitionId: partition.id, exclusive: grantRequest.exclusive, paths: [...partition.paths] },
      ledgerState, executionState: outcome?.tasks.find(({ taskId }) => taskId === task.id)?.state ?? null, attempts,
      finalVerification: finalSummary,
      stale: touched && !(outcome?.passed === true && finalSummary?.status === "passed" && finalSummary.snapshotFingerprint === outcome.snapshotFingerprint),
    });
  }
  const completion = await read<{ artifactId: string }>("testing-execution-completion");
  const completionDescriptor = descriptors.find(({ kind }) => kind === "testing-execution-completion");
  const changeSetDescriptor = completion === null ? undefined : descriptors.find(({ artifactId }) => artifactId === completion.artifactId);
  const changeSet = changeSetDescriptor === undefined ? null : await store.artifacts.get<{ files: readonly unknown[] }>(changeSetDescriptor.ref);
  return testingOperatorViewSchema.parse({
    runId, runState,
    configuration: {
      mode: settings.mode, goal: settings.goal, roles: settings.roles,
      commands: settings.commands.map(({ command, evidence }) => ({ command, evidencePath: evidence.path })),
      execution: execution === null ? null : {
        authorization: execution.authorization, models: execution.models, maximumAttempts: execution.maximumAttempts,
        maximumRepairRounds: execution.maximumRepairRounds ?? DEFAULT_TESTING_REPAIR_ROUNDS,
        repairRoundsSource: execution.maximumRepairRounds === undefined ? "default" : "configured",
        sandbox: { driver: execution.verification.execution.driver, image: execution.verification.execution.image, maximumRuns: execution.verification.execution.maximumRuns, timeoutMs: execution.verification.execution.timeoutMs, network: "none" },
        checks: execution.verification.execution.checks, bindings: execution.verification.bindings,
      },
    },
    planning: planning === null ? null : { passed: planning.passed, reasons: planning.reasons, selectedGaps: planning.selectedGaps, testsExecuted: false, planFingerprint: planning.planFingerprint },
    noWork: planning !== null && planning.selectedGaps === 0,
    tasks,
    execution: outcome === null ? null : { passed: outcome.passed, reasons: outcome.reasons, planFingerprint: outcome.planFingerprint, snapshotFingerprint: outcome.snapshotFingerprint, planMatches: outcome.planFingerprint === planning?.planFingerprint },
    repair: {
      rounds: rounds.map(({ round, snapshotFingerprint, failedTaskIds, reopened, staleTaskIds, state }) => ({ round, snapshotFingerprint, failedTaskIds, reopened, staleTaskIds, state })),
      terminal: lineage?.terminal === undefined ? null : { reason: lineage.terminal.reason, snapshotFingerprint: lineage.terminal.snapshotFingerprint },
    },
    handoff: {
      planArtifactId: descriptors.find(({ kind }) => kind === "implementation")?.artifactId ?? null,
      verifiedChangeSet: completionDescriptor === undefined || changeSetDescriptor === undefined || changeSet === null ? null
        : { completionArtifactId: completionDescriptor.artifactId, changeSetArtifactId: changeSetDescriptor.artifactId, files: changeSet.files.length },
    },
  });
}

/**
 * The exact verified change set named by the completion record. The completion's hash
 * and every file's content hash are rechecked, so a download is the bytes that passed
 * fresh final verification or nothing.
 */
export async function testingVerifiedChangeSet(store: RunStore, runId: string): Promise<TestingVerifiedChangeSet> {
  const descriptors = await store.listArtifacts();
  const completionDescriptor = descriptors.find(({ kind }) => kind === "testing-execution-completion");
  if (completionDescriptor === undefined) throw Object.assign(new Error("TESTING_VERIFIED_HANDOFF_ABSENT"), { statusCode: 404 });
  const completion = await store.artifacts.get<{ artifactId: string; changeSetHash: string }>(completionDescriptor.ref);
  const changeSetDescriptor = descriptors.find(({ artifactId, kind }) => artifactId === completion.artifactId && kind.startsWith("testing-change-set-"));
  if (changeSetDescriptor === undefined) throw Object.assign(new Error("TESTING_VERIFIED_CHANGE_SET_ABSENT"), { statusCode: 409 });
  const changeSet = await store.artifacts.get<TestingVerifiedChangeSet["changeSet"]>(changeSetDescriptor.ref);
  if (hash(changeSet) !== completion.changeSetHash) throw Object.assign(new Error("TESTING_VERIFIED_CHANGE_SET_CHANGED"), { statusCode: 409 });
  for (const file of changeSet.files) {
    if (createHash("sha256").update(file.content).digest("hex") !== file.contentHash) throw Object.assign(new Error(`TESTING_VERIFIED_CHANGE_SET_CONTENT_MISMATCH:${file.path}`), { statusCode: 409 });
  }
  return testingVerifiedChangeSetSchema.parse({ runId, completionArtifactId: completionDescriptor.artifactId, changeSetArtifactId: changeSetDescriptor.artifactId, changeSet });
}

function hash(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
