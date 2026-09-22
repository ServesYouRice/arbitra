import { createHash } from "node:crypto";
import { canonicalJson } from "@arbitra/core/config/config-store.js";
import { taskIRSchema, type TaskIR } from "@arbitra/schemas/task-ir.js";
import { testingExecutionSchema, type TestingExecution } from "@arbitra/schemas/testing.js";
import { testingVerificationPolicySchema, type TestingVerificationPolicy } from "@arbitra/schemas/testing-verification.js";
import type { RepositorySnapshot } from "./repository.js";
import type { TestingWorkspace } from "./testing-workspace.js";
import { repositoryTestCommands } from "./testing-context.js";
import { VerificationExecutor } from "./verification-execution.js";
import type { RunStore } from "./run-store.js";
import type { TestSandbox } from "./test-sandbox.js";

export interface TestingTaskVerification {
  readonly taskId: string; readonly attemptId: string; readonly snapshotFingerprint: string;
  readonly status: "passed" | "failed" | "incomplete";
  readonly deterministicFailure: boolean;
  readonly reasons: readonly string[];
  readonly checks: readonly { readonly command: string; readonly checkId: string; readonly executionId: string | null; readonly status: "passed" | "failed" | "incomplete"; readonly expectedExitCode: number; readonly actualExitCode: number | null }[];
}

/** Uses trusted command-to-argv bindings and the existing no-network sandbox.
 * Evidence is bound to the complete fresh workspace, not only test path names. */
export class TestingTaskVerifier {
  readonly #execution: VerificationExecutor;
  readonly #settings: TestingExecution;
  readonly #policy: TestingVerificationPolicy;
  readonly #originalCommands;
  #pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: RunStore, originalSnapshot: RepositorySnapshot, settings: TestingExecution, policy: TestingVerificationPolicy, sandbox?: TestSandbox) {
    this.#settings = testingExecutionSchema.parse(settings);
    this.#policy = testingVerificationPolicySchema.parse(policy);
    this.#originalCommands = repositoryTestCommands(originalSnapshot, this.#settings);
    this.#execution = new VerificationExecutor(store, sandbox);
  }

  verify(task: TaskIR, attemptId: string, workspace: TestingWorkspace, signal: AbortSignal): Promise<TestingTaskVerification> {
    const parsed = taskIRSchema.parse(task);
    if (attemptId.trim() === "" || attemptId.length > 100) return Promise.reject(new Error("INVALID_TESTING_ATTEMPT_ID"));
    const pending = this.#pending.then(() => this.run(parsed, attemptId, workspace, signal));
    this.#pending = pending.catch(() => undefined); return pending;
  }

  private async run(task: TaskIR, attemptId: string, workspace: TestingWorkspace, signal: AbortSignal): Promise<TestingTaskVerification> {
    const { snapshot, writes } = await workspace.verificationInput(task.id);
    const snapshotFingerprint = fingerprint(snapshot);
    const currentCommands = repositoryTestCommands(snapshot, this.#settings);
    if (task.verification.commands.length === 0 || new Set(task.verification.commands.map(({ command }) => command)).size !== task.verification.commands.length) throw new Error("TESTING_VERIFICATION_COMMANDS_REQUIRED_AND_UNIQUE");
    const selected = task.verification.commands.map((command) => {
      const binding = this.#policy.bindings.find((item) => item.command === command.command);
      if (binding === undefined) throw new Error(`TESTING_COMMAND_NOT_AUTHORIZED:${command.command}`);
      if (binding.expectedExitCode !== command.expectedExitCode) throw new Error("TESTING_EXPECTED_EXIT_CODE_CHANGED");
      const required = command.executionPolicy === "derived_repository_script" ? "repository_script" : command.executionPolicy === "allowlisted" ? "allowlisted" : "operator_approved";
      if (binding.authorization !== required) throw new Error("TESTING_COMMAND_APPROVAL_REQUIRED");
      const original = this.#originalCommands.find((item) => item.command === command.command);
      const current = currentCommands.find((item) => item.command === command.command);
      if (binding.authorization === "repository_script" && (original?.executionPolicy !== "derived_repository_script" || current?.executionPolicy !== "derived_repository_script")) throw new Error("TESTING_COMMAND_NOT_REPOSITORY_DERIVED");
      if (original !== undefined && canonicalJson(original) !== canonicalJson(current ?? null)) throw new Error("TESTING_COMMAND_SOURCE_CHANGED");
      const check = this.#policy.execution.checks.find(({ id }) => id === binding.checkId);
      if (check === undefined) throw new Error("TESTING_SANDBOX_CHECK_ABSENT");
      if (check.sourcePaths.some((path) => !snapshot.files.some((file) => file.path === path))) throw new Error("TESTING_CHECK_SOURCE_MISSING");
      return { command, binding, check };
    });
    const reasons: string[] = [];
    const writtenPaths = [...new Set(writes.map(({ path }) => path))];
    if (writtenPaths.length === 0) reasons.push("no_recorded_test_changes");
    if (writtenPaths.some((path) => !task.scope.likelyFiles.includes(path))) throw new Error("TESTING_WRITES_OUTSIDE_TASK_SCOPE");
    if (writtenPaths.some((path) => !selected.some(({ check }) => check.sourcePaths.includes(path)))) throw new Error("TESTING_WRITE_WITHOUT_VERIFICATION_CHECK");
    const checks: TestingTaskVerification["checks"][number][] = [];
    if (reasons.length === 0) {
      // Restrict the trusted policy to the task's bound commands, never incidental checks.
      const execution = { ...this.#policy.execution, checks: selected.map(({ check }) => check) };
      const invocationId = createHash("sha256").update(canonicalJson({ taskId: task.id, attemptId })).digest("hex");
      const results = await this.#execution.execute(snapshot, execution, selected.flatMap(({ check }) => check.sourcePaths), signal, invocationId);
      for (const { command, binding, check } of selected) {
        const record = results.records.find((item) => item.checkId === check.id);
        const result = record?.result;
        const completed = record?.state === "completed" && result?.status === "exited" && result.stopped === null && result.cleanupCompleted
          && result.driver === "docker" && result.image === execution.image && result.checkId === check.id && result.isolation === "read_only_snapshot_no_network" && result.exitCode !== null;
        const status = completed ? result.exitCode === binding.expectedExitCode ? "passed" : "failed" : "incomplete";
        checks.push({ command: command.command, checkId: check.id, executionId: record?.id ?? null, status, expectedExitCode: binding.expectedExitCode, actualExitCode: result?.exitCode ?? null });
        if (status === "incomplete") reasons.push(results.deferredCheckIds.includes(check.id) ? `verification_budget_exhausted:${check.id}` : `verification_incomplete:${check.id}`);
      }
    }
    if (fingerprint(await workspace.snapshot()) !== snapshotFingerprint) reasons.push("workspace_changed_during_verification");
    const status = reasons.length > 0 || checks.length === 0 ? "incomplete" : checks.some((check) => check.status === "failed") ? "failed" : "passed";
    const outcome: TestingTaskVerification = { taskId: task.id, attemptId, snapshotFingerprint, status, deterministicFailure: status === "failed", reasons, checks };
    const key = createHash("sha256").update(canonicalJson({ task, attemptId, snapshotFingerprint, policy: this.#policy })).digest("hex");
    await this.store.publish(`testing-task-verification-${key}`, outcome, "testing-execution");
    return outcome;
  }
}

function fingerprint(snapshot: RepositorySnapshot): string { return createHash("sha256").update(canonicalJson(snapshot.files.map(({ path, lines }) => ({ path, lines })).sort((a, b) => a.path.localeCompare(b.path)))).digest("hex"); }
