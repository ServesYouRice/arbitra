import { createHash } from "node:crypto";
import { canonicalJson } from "@arbitra/core/config/config-store.js";
import { runConfigSchema, type RunConfig } from "@arbitra/schemas/config.js";
import { planIRSchema, type PlanIR } from "@arbitra/schemas/plan.js";
import { testingExecutionSchema } from "@arbitra/schemas/testing.js";
import { testingPlanExecutionOptionsSchema } from "@arbitra/schemas/testing-executor.js";
import { WritePartitions } from "@arbitra/security/write-partitions";
import { testInventory } from "@arbitra/workflow/nodes/test-inventory.js";
import type { ModelActivities } from "./model-activities.js";
import { readStage } from "./pipeline.js";
import type { RepositorySnapshot } from "./repository.js";
import type { RunStore } from "./run-store.js";
import type { TestSandbox } from "./test-sandbox.js";
import type { TestingOutcome } from "./testing-pipeline.js";
import { DEFAULT_TESTING_REPAIR_ROUNDS, TestingRepairLineage, testingRepairClosure, type TestingRepairRound } from "./testing-repair.js";
import { TestingTaskAttempts } from "./testing-task-attempts.js";
import { runTestingBatch } from "./testing-task-runner.js";
import { TestingTaskVerifier, type TestingTaskVerificationResult } from "./testing-task-verifier.js";
import { testingWriteSchedule } from "./testing-write-schedule.js";
import { TestingWorkspace } from "./testing-workspace.js";
import { verificationSnapshotFingerprint } from "./verification-execution.js";
import { testingChangeSet, type TestingChangeSet } from "./testing-change-set.js";

import type { TestingPlanExecutionOptions } from "@arbitra/schemas/testing-executor.js";
export type { TestingPlanExecutionOptions } from "@arbitra/schemas/testing-executor.js";
export interface TestingPlanExecutionOutcome {
  readonly passed: boolean;
  readonly reasons: readonly string[];
  readonly planFingerprint: string;
  readonly snapshotFingerprint: string;
  readonly tasks: readonly { taskId: string; state: "completed" | "blocked" }[];
  readonly finalVerification: readonly TestingTaskVerificationResult[];
  /** Durable repair lineage: each invalidated snapshot, its failures and reopened/stale closure. */
  readonly repair: readonly { round: number; snapshotFingerprint: string; failedTaskIds: readonly string[]; reopenedTaskIds: readonly string[]; staleTaskIds: readonly string[] }[];
}

/** Own one executor per run under the public run lock. Disjoint writer batches
 * settle before serial verification. No writable host path reaches a model. */
export class TestingPlanExecutor {
  readonly #config: RunConfig;
  readonly #snapshot: RepositorySnapshot;
  readonly #options: TestingPlanExecutionOptions;
  readonly #partitions: WritePartitions;
  readonly #workspace: TestingWorkspace;
  readonly #verifier: TestingTaskVerifier;
  #pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: RunStore, config: RunConfig, snapshot: RepositorySnapshot,
    private readonly activities: ModelActivities, options: TestingPlanExecutionOptions, sandbox?: TestSandbox) {
    this.#config = runConfigSchema.parse(config); this.#snapshot = structuredClone(snapshot);
    this.#options = testingPlanExecutionOptionsSchema.parse(options);
    if (config.mode !== "testing" || config.harness.mode !== "canonical") throw new Error("TESTING_PLAN_EXECUTOR_CONFIGURATION_INVALID");
    if (!Number.isSafeInteger(options.maximumAttempts) || options.maximumAttempts < 1 || options.maximumAttempts > 10) throw new Error("INVALID_TESTING_ATTEMPT_LIMIT");
    this.#partitions = new WritePartitions(this.#options.authorization.partitions);
    this.#workspace = new TestingWorkspace(store, this.#partitions);
    this.#verifier = new TestingTaskVerifier(store, this.#snapshot, testingExecutionSchema.parse(config.workflow["testing"]), this.#options.verification, sandbox);
  }

  run(signal: AbortSignal): Promise<TestingPlanExecutionOutcome> {
    const pending = this.#pending.then(() => this.execute(signal));
    this.#pending = pending.catch(() => undefined); return pending;
  }

  /** Revalidate the journal and final checks, then persist exact verified bytes. */
  handoff(signal: AbortSignal): Promise<{ artifactId: string; changes: TestingChangeSet }> {
    const pending = this.#pending.then(() => this.createHandoff(signal));
    this.#pending = pending.catch(() => undefined); return pending;
  }

  /** Publish completion before cleanup so restart never needs a deleted worktree. */
  finalize(signal: AbortSignal): Promise<{ artifactId: string; changes: TestingChangeSet }> {
    const pending = this.#pending.then(async () => {
      if (signal.aborted) throw new Error("TESTING_EXECUTION_CANCELLED");
      const fingerprint = hash({ config: this.#config, options: this.#options, baseline: verificationSnapshotFingerprint(this.#snapshot) });
      const prior = (await this.store.listArtifacts()).find(({ kind }) => kind === "testing-execution-completion");
      let result: { artifactId: string; changes: TestingChangeSet };
      if (prior === undefined) {
        result = await this.createHandoff(signal);
        await this.store.publish("testing-execution-completion", { fingerprint, artifactId: result.artifactId, changeSetHash: hash(result.changes) }, "testing-execution");
      } else {
        const completion = await this.store.artifacts.get<{ fingerprint: string; artifactId: string; changeSetHash: string }>(prior.ref);
        if (completion.fingerprint !== fingerprint) throw new Error("TESTING_EXECUTION_CONFIGURATION_CHANGED");
        const changes = JSON.parse((await this.store.readArtifact(completion.artifactId)).content) as TestingChangeSet;
        const plan = planIRSchema.parse(await readStage(this.store, "plan-ir"));
        if (hash(changes) !== completion.changeSetHash || hash(plan) !== changes.planFingerprint) throw new Error("TESTING_COMPLETED_HANDOFF_CHANGED");
        result = { artifactId: completion.artifactId, changes };
      }
      await this.#verifier.recover(signal);
      const workspace = await readStage<{ state: string }>(this.store, "testing-workspace");
      if (workspace.state === "closed") await this.#workspace.recoverClosed();
      else {
        await this.#workspace.prepare(this.#snapshot, signal);
        if (verificationSnapshotFingerprint(await this.#workspace.snapshot()) !== result.changes.snapshotFingerprint) throw new Error("TESTING_COMPLETED_WORKSPACE_CHANGED");
        await this.#workspace.close();
      }
      return result;
    });
    this.#pending = pending.catch(() => undefined); return pending;
  }

  private async createHandoff(signal: AbortSignal): Promise<{ artifactId: string; changes: TestingChangeSet }> {
    const outcome = await this.execute(signal);
    const changes = testingChangeSet(this.#snapshot, await this.#workspace.snapshot(), outcome);
    const artifact = await this.store.publish(`testing-change-set-${hash(changes)}`, changes, "testing-execution");
    const persisted = await this.store.artifacts.get<TestingChangeSet>(artifact.ref);
    if (canonicalJson(persisted) !== canonicalJson(changes)) throw new Error("TESTING_CHANGE_SET_PERSISTENCE_CHANGED");
    return { artifactId: artifact.artifactId, changes: persisted };
  }

  /** Explicit lifecycle boundary, after the caller has exported the verified changes. */
  close(): Promise<void> {
    const pending = this.#pending.then(() => this.#workspace.close());
    this.#pending = pending.catch(() => undefined); return pending;
  }

  private async execute(signal: AbortSignal): Promise<TestingPlanExecutionOutcome> {
    if (signal.aborted) throw new Error("TESTING_EXECUTION_CANCELLED");
    const gate = await readStage<TestingOutcome>(this.store, "testing-outcome");
    const plan = planIRSchema.parse(await readStage(this.store, "plan-ir"));
    if (gate.passed !== true || !Array.isArray(gate.reasons) || gate.reasons.length !== 0 || gate.testsExecuted !== false || gate.planFingerprint !== hash(plan)) throw new Error("TESTING_PASSED_PLAN_REQUIRED");
    const inventory = testInventory(this.#snapshot.files.map(({ path }) => ({ path, kind: "file" })));
    const schedule = testingWriteSchedule(plan, inventory, this.#options.authorization);
    for (const task of plan.tasks) this.#verifier.preflight(task);
    const ranks = { fast: 0, balanced: 1, frontier: 2 };
    for (const capability of new Set([...plan.tasks.map(({ routing }) => routing.capability), "frontier" as const])) {
      const id = this.#options.models[capability];
      const profile = Object.hasOwn(this.#config.models, id) ? this.#config.models[id] : undefined;
      if (profile === undefined || !profile.supports.tools || ranks[profile.capabilityTier] < ranks[capability]) throw new Error("TESTING_TASK_MODEL_CONFIGURATION_INVALID");
    }
    const fingerprint = hash({ config: this.#config, options: this.#options, schedule, snapshot: verificationSnapshotFingerprint(this.#snapshot) });
    const binding = (await this.store.listArtifacts()).find(({ kind }) => kind === "testing-execution-binding");
    if (binding === undefined) await this.store.publish("testing-execution-binding", { fingerprint }, "testing-execution");
    else if ((await this.store.artifacts.get<{ fingerprint: string }>(binding.ref)).fingerprint !== fingerprint) throw new Error("TESTING_EXECUTION_CONFIGURATION_CHANGED");
    await this.#verifier.recover(signal);
    await this.#workspace.prepare(this.#snapshot, signal);
    const lineage = new TestingRepairLineage(this.store, fingerprint, this.#options.maximumRepairRounds ?? DEFAULT_TESTING_REPAIR_ROUNDS);
    // Each pass runs the whole schedule through the shared writer/lease/check path.
    // Completed tasks are no-ops; reopened tasks receive one new bounded attempt in
    // dependency order. Restart therefore resumes an interrupted repair unchanged.
    while (true) {
      if (signal.aborted) throw new Error("TESTING_EXECUTION_CANCELLED");
      await this.completeReopening(lineage, plan);
      const tasks: { taskId: string; state: "completed" | "blocked" }[] = [];
      const reasons: string[] = [];
      for (const batch of schedule.batches) {
        const inputs = batch.map((request) => {
          const task = plan.tasks.find(({ id }) => id === request.taskId);
          if (task === undefined) throw new Error("TESTING_SCHEDULE_TASK_ABSENT");
          return { store: this.store, config: this.#config, activities: this.activities, task,
            policy: this.#options.verification, request, partitions: this.#partitions, workspace: this.#workspace, verifier: this.#verifier,
            models: this.#options.models, maximumAttempts: this.#options.maximumAttempts, signal,
            ...(this.#options.advisors === undefined ? {} : { advisors: this.#options.advisors }) };
        });
        const results = await runTestingBatch(inputs);
        for (const [index, result] of results.entries()) {
          const task = inputs[index]?.task; if (task === undefined) throw new Error("TESTING_BATCH_TASK_ABSENT");
          const state = result.state === "completed" ? "completed" : "blocked";
          tasks.push({ taskId: task.id, state });
          if (state === "blocked") reasons.push(`${result.state === "blocked" ? "task_attempts_exhausted" : "batch_blocked"}:${task.id}`);
        }
        if (reasons.length > 0) break;
      }
      const snapshotFingerprint = verificationSnapshotFingerprint(await this.#workspace.snapshot());
      const finalVerification: TestingTaskVerificationResult[] = [];
      if (reasons.length === 0) {
        for (const task of plan.tasks) {
          const result = await this.#verifier.verify(task, `final/${hash({ task: task.id, snapshotFingerprint })}`, this.#workspace, signal);
          finalVerification.push(result);
          if (result.snapshotFingerprint !== snapshotFingerprint) reasons.push(`final_verification_stale:${task.id}`);
          else if (result.status !== "passed") reasons.push(`final_verification_${result.status}:${task.id}`);
        }
      }
      if (verificationSnapshotFingerprint(await this.#workspace.snapshot()) !== snapshotFingerprint) reasons.push("workspace_changed_during_final_verification");
      // Only deterministic failures of fresh evidence for the exact final bytes are repairable.
      const repairable = reasons.length > 0 && tasks.length === plan.tasks.length && reasons.every((reason) => reason.startsWith("final_verification_failed:"));
      if (repairable) {
        const decision = await this.reopen(lineage, plan, snapshotFingerprint, finalVerification, signal);
        if (decision === null) continue;
        reasons.push(decision);
      }
      const repair = (await lineage.load()).rounds.map(({ round, snapshotFingerprint: invalidated, failedTaskIds, reopened, staleTaskIds }) =>
        ({ round, snapshotFingerprint: invalidated, failedTaskIds, reopenedTaskIds: reopened.map(({ taskId }) => taskId), staleTaskIds }));
      const outcome: TestingPlanExecutionOutcome = { passed: reasons.length === 0, reasons, planFingerprint: schedule.planFingerprint, snapshotFingerprint, tasks, finalVerification, repair };
      await this.store.publish("testing-execution-outcome", outcome, "testing-execution");
      return outcome;
    }
  }

  /** Decide one repair round for an exact invalidated snapshot. Returns null when the
   * affected tasks were reopened, or a durable terminal reason. Nothing is invalidated
   * unless every reopened task still has attempt budget under its original grant. */
  private async reopen(lineage: TestingRepairLineage, plan: PlanIR, snapshotFingerprint: string, finalVerification: readonly TestingTaskVerificationResult[], signal: AbortSignal): Promise<string | null> {
    const state = await lineage.load();
    if (state.terminal !== undefined) {
      if (state.terminal.snapshotFingerprint !== snapshotFingerprint) throw new Error("TESTING_REPAIR_TERMINAL_CHANGED");
      return state.terminal.reason;
    }
    const terminal = async (reason: string) => { await lineage.save({ ...state, terminal: { snapshotFingerprint, reason } }); return reason; };
    // Returning to any invalidated bytes (including a repair that changed nothing) is oscillation.
    if (state.rounds.some((round) => round.snapshotFingerprint === snapshotFingerprint)) return terminal("repair_oscillation");
    if (state.rounds.length >= lineage.maximumRounds) return terminal("repair_rounds_exhausted");
    const failures = finalVerification.filter(({ status, deterministicFailure }) => status === "failed" && deterministicFailure).map(({ taskId, artifactId }) => ({ taskId, artifactId }));
    const written = new Map<string, readonly string[]>();
    for (const task of plan.tasks) written.set(task.id, (await this.#workspace.verificationInput(task.id)).writes.map(({ path }) => path));
    const closure = testingRepairClosure(plan, this.#options.verification, failures, written);
    for (const { taskId } of closure.reopened) {
      const status = await this.ledger(plan, taskId).status();
      if (status.state !== "completed") throw new Error("TESTING_REPAIR_REQUIRES_COMPLETED_TASK");
      if (status.attempts.length >= this.#options.maximumAttempts) return terminal(`repair_attempts_exhausted:${taskId}`);
    }
    if (signal.aborted) throw new Error("TESTING_EXECUTION_CANCELLED");
    const round: TestingRepairRound = { round: state.rounds.length + 1, snapshotFingerprint, failedTaskIds: failures.map(({ taskId }) => taskId).sort(),
      reopened: closure.reopened, staleTaskIds: closure.staleTaskIds, state: "reopening" };
    // Commit reopen intent before touching attempt ledgers, so restart completes it.
    await lineage.save({ ...state, rounds: [...state.rounds, round] });
    await this.completeReopening(lineage, plan);
    return null;
  }

  /** Idempotently finish a committed reopen before any writer is dispatched. */
  private async completeReopening(lineage: TestingRepairLineage, plan: PlanIR): Promise<void> {
    const state = await lineage.load(); const round = state.rounds.at(-1);
    if (round?.state !== "reopening") return;
    // Failing tasks first: their own ledger validates the full execution evidence.
    const ordered = [...round.reopened].sort((a, b) => Number(b.taskId === b.causeTaskId) - Number(a.taskId === a.causeTaskId) || a.taskId.localeCompare(b.taskId));
    for (const { taskId, causeTaskId, verificationArtifactId } of ordered) {
      const ledger = this.ledger(plan, taskId);
      const status = await ledger.status();
      if (status.state === "pending") continue;
      if (taskId === causeTaskId) await ledger.invalidateFinal(verificationArtifactId, round.snapshotFingerprint);
      else await ledger.invalidateForRelated(verificationArtifactId, round.snapshotFingerprint);
    }
    await lineage.save({ ...state, rounds: [...state.rounds.slice(0, -1), { ...round, state: "reopened" }] });
  }

  private ledger(plan: PlanIR, taskId: string): TestingTaskAttempts {
    const task = plan.tasks.find(({ id }) => id === taskId);
    if (task === undefined) throw new Error("TESTING_REPAIR_TASK_ABSENT");
    return new TestingTaskAttempts(this.store, task, this.#options.verification, this.#options.maximumAttempts);
  }
}
function hash(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
