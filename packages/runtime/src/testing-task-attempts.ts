import { createHash } from "node:crypto";
import { canonicalJson } from "@arbitra/core/config/config-store.js";
import { planTaskIRSchema } from "@arbitra/schemas/plan.js";
import { taskIRSchema, type TaskIR } from "@arbitra/schemas/task-ir.js";
import { testingTaskVerificationSchema, testingVerificationPolicySchema, type TestingVerificationPolicy, type TestingTaskVerification } from "@arbitra/schemas/testing-verification.js";
import type { VerificationExecutionRecord } from "./verification-execution.js";
import type { RunStore } from "./run-store.js";

export interface TestingTaskAttempt {
  readonly id: string; readonly ordinal: number; readonly capability: "fast" | "balanced" | "frontier";
  readonly state: "reserved" | "verified"; readonly verificationArtifactId?: string;
  readonly result?: "passed" | "failed" | "incomplete";
  readonly repairVerificationArtifactId?: string;
}
interface Ledger {
  readonly taskFingerprint: string; readonly policyFingerprint: string; readonly maximumAttempts: number;
  readonly attempts: readonly TestingTaskAttempt[];
  readonly invalidations?: readonly { attemptId: string; artifactId: string }[];
}

/** Reserves before model dispatch. Re-entering an unfinished attempt preserves its
 * identity; infrastructure failures consume the attempt budget but never promote. */
export class TestingTaskAttempts {
  readonly #task;
  readonly #policy;
  readonly #kind: string;
  #pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: RunStore, task: TaskIR, policy: TestingVerificationPolicy, private readonly maximumAttempts = 4) {
    this.#task = planTaskIRSchema.or(taskIRSchema).parse(task);
    this.#policy = testingVerificationPolicySchema.parse(policy);
    if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 10) throw new Error("INVALID_TESTING_ATTEMPT_LIMIT");
    this.#kind = `testing-task-attempts-${hash(this.#task.id)}`;
  }

  reserve(): Promise<TestingTaskAttempt | null> {
    return this.serial(async () => {
      const ledger = await this.load();
      const previous = ledger.attempts.at(-1);
      if (previous?.state === "reserved") return previous;
      const invalidation = ledger.invalidations?.findLast(({ attemptId }) => attemptId === previous?.id);
      if (previous?.result === "passed" && invalidation === undefined || ledger.attempts.length >= this.maximumAttempts) return null;
      const failures = ledger.attempts.filter(({ result }) => result === "failed").length + (ledger.invalidations?.length ?? 0);
      const attempt: TestingTaskAttempt = { id: `${this.#task.id}/attempt-${ledger.attempts.length + 1}`, ordinal: ledger.attempts.length + 1,
        capability: failures >= 2 ? "frontier" : this.#task.routing.capability, state: "reserved",
        ...(invalidation === undefined ? {} : { repairVerificationArtifactId: invalidation.artifactId }) };
      await this.save({ ...ledger, attempts: [...ledger.attempts, attempt] });
      return attempt;
    });
  }

  /** Preserve the original pass while recording independently verified final failure.
   * Reopening consumes the existing attempt cap; no budget is replenished. */
  invalidateFinal(artifactId: string, snapshotFingerprint: string): Promise<boolean> {
    return this.serial(async () => {
      const ledger = await this.load(); const last = ledger.attempts.at(-1);
      const descriptor = (await this.store.listArtifacts()).find((entry) => entry.artifactId === artifactId && entry.kind.startsWith("testing-task-verification-"));
      if (descriptor === undefined) throw new Error("TESTING_VERIFICATION_ARTIFACT_REQUIRED");
      const verification = testingTaskVerificationSchema.parse(await this.store.artifacts.get(descriptor.ref));
      if (verification.taskId !== this.#task.id || verification.taskFingerprint !== ledger.taskFingerprint || verification.policyFingerprint !== ledger.policyFingerprint
        || verification.snapshotFingerprint !== snapshotFingerprint || !verification.attemptId.startsWith("final/") || verification.status !== "failed") throw new Error("TESTING_FINAL_INVALIDATION_INVALID");
      await this.validateEvidence(verification);
      if (last?.state !== "verified" || last.result !== "passed") throw new Error("TESTING_FINAL_INVALIDATION_REQUIRES_COMPLETED_TASK");
      const previous = ledger.invalidations?.find(({ attemptId }) => attemptId === last.id);
      if (previous !== undefined && previous.artifactId !== artifactId) throw new Error("TESTING_FINAL_INVALIDATION_CHANGED");
      if (previous === undefined) await this.save({ ...ledger, invalidations: [...ledger.invalidations ?? [], { attemptId: last.id, artifactId }] });
      return ledger.attempts.length < this.maximumAttempts;
    });
  }

  recordVerification(attemptId: string, artifactId: string): Promise<TestingTaskAttempt> {
    return this.serial(async () => {
      const ledger = await this.load();
      const attempt = ledger.attempts.find(({ id }) => id === attemptId);
      if (attempt === undefined) throw new Error("TESTING_ATTEMPT_NOT_RESERVED");
      if (attempt.state === "verified") {
        if (attempt.verificationArtifactId !== artifactId) throw new Error("TESTING_ATTEMPT_RESULT_CHANGED");
        return attempt;
      }
      if (attempt !== ledger.attempts.at(-1)) throw new Error("TESTING_ATTEMPT_ORDER_INVALID");
      const descriptors = await this.store.listArtifacts();
      const artifact = descriptors.find((entry) => entry.artifactId === artifactId && entry.kind.startsWith("testing-task-verification-"));
      if (artifact === undefined) throw new Error("TESTING_VERIFICATION_ARTIFACT_REQUIRED");
      const verification = testingTaskVerificationSchema.parse(await this.store.artifacts.get(artifact.ref));
      if (verification.taskId !== this.#task.id || verification.attemptId !== attemptId || verification.taskFingerprint !== ledger.taskFingerprint || verification.policyFingerprint !== ledger.policyFingerprint) throw new Error("TESTING_ATTEMPT_VERIFICATION_STALE");
      await this.validateEvidence(verification);
      const next: TestingTaskAttempt = { ...attempt, state: "verified", verificationArtifactId: artifactId, result: verification.status };
      await this.save({ ...ledger, attempts: [...ledger.attempts.slice(0, -1), next] });
      return next;
    });
  }

  status(): Promise<{ state: "pending" | "running" | "completed" | "blocked"; attempts: readonly TestingTaskAttempt[]; deterministicFailures: number }> {
    return this.serial(async () => {
      const ledger = await this.load(); const last = ledger.attempts.at(-1);
      const invalidated = ledger.invalidations?.some(({ attemptId }) => attemptId === last?.id) ?? false;
      return { state: last?.state === "reserved" ? "running" : last?.result === "passed" && !invalidated ? "completed" : ledger.attempts.length >= this.maximumAttempts ? "blocked" : "pending",
        attempts: ledger.attempts, deterministicFailures: ledger.attempts.filter(({ result }) => result === "failed").length + (ledger.invalidations?.length ?? 0) };
    });
  }

  private async validateEvidence(verification: TestingTaskVerification): Promise<void> {
    const allComplete = verification.checks.length === this.#task.verification.commands.length && verification.checks.length > 0 && verification.checks.every(({ status, executionId }) => status !== "incomplete" && executionId !== null);
    if (verification.deterministicFailure !== (verification.status === "failed") || verification.status !== "incomplete" && (!allComplete || verification.reasons.length > 0)) throw new Error("TESTING_VERIFICATION_RESULT_INVALID");
    if (verification.status === "incomplete") return;
    const descriptors = await this.store.listArtifacts();
    const configuredChecks = this.#task.verification.commands.map(({ command }) => {
      const binding = this.#policy.bindings.find((entry) => entry.command === command);
      const check = this.#policy.execution.checks.find(({ id }) => id === binding?.checkId);
      if (check === undefined) throw new Error("TESTING_VERIFICATION_CHECK_INVALID");
      return check;
    });
    const executionFingerprint = hash({ ...this.#policy.execution, checks: configuredChecks });
    const invocationId = hash({ taskId: this.#task.id, attemptId: verification.attemptId });
    const seen = new Set<string>(); let failed = false;
    for (const check of verification.checks) {
      const binding = this.#policy.bindings.find(({ command, checkId }) => command === check.command && checkId === check.checkId);
      if (binding === undefined || seen.has(check.checkId) || !this.#task.verification.commands.some(({ command, expectedExitCode }) => command === check.command && expectedExitCode === check.expectedExitCode)
        || binding.expectedExitCode !== check.expectedExitCode) throw new Error("TESTING_VERIFICATION_CHECK_INVALID");
      seen.add(check.checkId);
      const descriptor = descriptors.find(({ kind }) => kind === `verification-execution-${check.executionId}`);
      if (descriptor === undefined) throw new Error("TESTING_EXECUTION_EVIDENCE_ABSENT");
      const execution = await this.store.artifacts.get<VerificationExecutionRecord>(descriptor.ref);
      if (execution.invocationId !== invocationId || execution.snapshotFingerprint !== verification.snapshotFingerprint || execution.executionFingerprint !== executionFingerprint) throw new Error("TESTING_EXECUTION_PROVENANCE_MISMATCH");
      const result = execution.result;
      if (execution.state !== "completed" || execution.checkId !== check.checkId || execution.id !== check.executionId || result?.checkId !== check.checkId || result.image !== this.#policy.execution.image
        || result.driver !== "docker" || result.isolation !== "read_only_snapshot_no_network" || result.status !== "exited" || result.stopped !== null || !result.cleanupCompleted || result.exitCode !== check.actualExitCode || result.exitCode === null) throw new Error("TESTING_EXECUTION_EVIDENCE_INVALID");
      const expectedStatus = result.exitCode === binding.expectedExitCode ? "passed" : "failed";
      if (check.status !== expectedStatus) throw new Error("TESTING_VERIFICATION_EXIT_MISMATCH");
      failed ||= expectedStatus === "failed";
    }
    if (verification.status !== (failed ? "failed" : "passed")) throw new Error("TESTING_VERIFICATION_RESULT_INVALID");
  }

  private async load(): Promise<Ledger> {
    const expected = { taskFingerprint: hash(this.#task), policyFingerprint: hash(this.#policy), maximumAttempts: this.maximumAttempts };
    const descriptor = (await this.store.listArtifacts()).find(({ kind }) => kind === this.#kind);
    if (descriptor === undefined) return { ...expected, attempts: [] };
    const ledger = await this.store.artifacts.get<Ledger>(descriptor.ref);
    if (ledger.taskFingerprint !== expected.taskFingerprint || ledger.policyFingerprint !== expected.policyFingerprint || ledger.maximumAttempts !== this.maximumAttempts) throw new Error("TESTING_TASK_EXECUTION_CONFIGURATION_CHANGED");
    return ledger;
  }
  private async save(ledger: Ledger): Promise<void> { await this.store.publish(this.#kind, ledger, "testing-execution"); }
  private serial<T>(operation: () => Promise<T>): Promise<T> { const pending = this.#pending.then(operation); this.#pending = pending.catch(() => undefined); return pending; }
}
function hash(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
