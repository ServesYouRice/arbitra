import { createHash } from "node:crypto";
import { canonicalJson } from "@arbitra/core/config/config-store.js";
import type { RunConfig } from "@arbitra/schemas/config.js";
import type { TaskIR } from "@arbitra/schemas/task-ir.js";
import type { TestingVerificationPolicy } from "@arbitra/schemas/testing-verification.js";
import type { WritePartitions, WriteRequest, WriteLease } from "@arbitra/security/write-partitions";
import type { ModelActivities } from "./model-activities.js";
import { modelTestingWriter } from "./model-testing-writer.js";
import type { RunStore } from "./run-store.js";
import { TestingTaskAttempts } from "./testing-task-attempts.js";
import type { TestingTaskVerifier } from "./testing-task-verifier.js";
import type { TestingWorkspace } from "./testing-workspace.js";
import type { VerificationExecutionRecord } from "./verification-execution.js";
import type { AdvisorPolicy } from "@arbitra/schemas/advisor.js";
import { validateAdvisorPolicy } from "./model-advisors.js";

/** Shared task-loop input. The run coordinator must preflight the complete
 * plan, prepare the workspace and prevent other writers during verification.
 * Completing a task does not replace verification of the final whole workspace. */
export interface TestingTaskRunInput {
  readonly store: RunStore; readonly config: RunConfig; readonly activities: ModelActivities;
  readonly task: TaskIR; readonly policy: TestingVerificationPolicy; readonly request: WriteRequest;
  readonly partitions: WritePartitions; readonly workspace: TestingWorkspace; readonly verifier: TestingTaskVerifier;
  readonly models: Readonly<Record<"fast" | "balanced" | "frontier", string>>;
  readonly maximumAttempts?: number; readonly signal: AbortSignal;
  /** Operator advisor policy; absent means task advisor requests are not served. */
  readonly advisors?: AdvisorPolicy;
}

export async function runTestingTask(input: TestingTaskRunInput) {
  const result = (await runTestingBatch([input]))[0];
  if (result === undefined) throw new Error("TESTING_BATCH_RESULT_ABSENT");
  return result;
}

async function prepareTask(input: TestingTaskRunInput) {
  const { store, config, task, policy, request, partitions, models } = input;
  if (request.taskId !== task.id || partitions.active().length !== 0) throw new Error("TESTING_TASK_RUNNER_REQUIRES_IDLE_WORKSPACE");
  if (request.paths.length !== task.scope.likelyFiles.length || request.paths.some((path) => !task.scope.likelyFiles.includes(path) || task.filesNotToTouch.includes(path))) throw new Error("TESTING_TASK_WRITE_SCOPE_CHANGED");
  const ranks = { fast: 0, balanced: 1, frontier: 2 };
  for (const capability of [task.routing.capability, "frontier"] as const) {
    const profileId = models[capability];
    const profile = Object.hasOwn(config.models, profileId) ? config.models[profileId] : undefined;
    if (profile === undefined || !profile.supports.tools || ranks[profile.capabilityTier] < ranks[capability]) throw new Error("TESTING_TASK_MODEL_CONFIGURATION_INVALID");
  }
  validateAdvisorPolicy(config, input.advisors);
  const maximumAttempts = input.maximumAttempts ?? 4;
  const identity = createHash("sha256").update(task.id).digest("hex");
  const kind = `testing-task-runner-${identity}`;
  const fingerprint = createHash("sha256").update(canonicalJson({ config, task, policy, request, models, maximumAttempts, ...(input.advisors === undefined ? {} : { advisors: input.advisors }) })).digest("hex");
  const prior = (await store.listArtifacts()).find((entry) => entry.kind === kind);
  if (prior === undefined) await store.publish(kind, { fingerprint }, "testing-execution");
  else if ((await store.artifacts.get<{ fingerprint: string }>(prior.ref)).fingerprint !== fingerprint) throw new Error("TESTING_TASK_RUNNER_CONFIGURATION_CHANGED");
  return new TestingTaskAttempts(store, task, policy, maximumAttempts);
}

/** All writers settle before leases are released or any verification starts.
 * Call only with a batch approved by whole-plan write scheduling. */
export async function runTestingBatch(inputs: readonly TestingTaskRunInput[]) {
  const first = inputs[0];
  if (first === undefined || inputs.length > 16 || new Set(inputs.map(({ task }) => task.id)).size !== inputs.length) throw new Error("TESTING_BATCH_INVALID");
  if (inputs.some((input) => input.store !== first.store || input.activities !== first.activities || input.workspace !== first.workspace || input.partitions !== first.partitions || input.verifier !== first.verifier || input.signal !== first.signal)) throw new Error("TESTING_BATCH_SHARED_COORDINATOR_REQUIRED");
  const ledgers: TestingTaskAttempts[] = [];
  for (const input of inputs) ledgers.push(await prepareTask(input));
  await first.verifier.recover(first.signal);
  while (true) {
    if (first.signal.aborted) throw new Error("TESTING_TASK_RUNNER_CANCELLED");
    const statuses = await Promise.all(ledgers.map((ledger) => ledger.status()));
    if (statuses.some(({ state }) => state === "blocked") || statuses.every(({ state }) => state === "completed")) return statuses;
    const jobs = [];
    for (const [index, input] of inputs.entries()) {
      const ledger = ledgers[index]; if (ledger === undefined) throw new Error("TESTING_BATCH_LEDGER_ABSENT");
      const attempt = await ledger.reserve(); if (attempt === null) continue;
      const previous = statuses[index]?.attempts.filter((entry) => entry.state === "verified").at(-1);
      const feedbackId = attempt.repairVerificationArtifactId ?? previous?.verificationArtifactId;
      const feedback = feedbackId === undefined ? null : await verificationFeedback(input.store, feedbackId);
      jobs.push({ input, ledger, attempt, feedback });
    }
    const leases: WriteLease[] = [];
    let results: PromiseSettledResult<Awaited<ReturnType<typeof modelTestingWriter>>>[];
    try {
      for (const { input } of jobs) leases.push(first.partitions.acquire(input.request));
      results = await Promise.allSettled(jobs.map(({ input, attempt, feedback }, index) => {
        const lease = leases[index]; if (lease === undefined) throw new Error("TESTING_BATCH_LEASE_ABSENT");
        return modelTestingWriter(input.store, input.config, input.activities, input.task, attempt, input.workspace, input.partitions, lease,
          { modelProfileId: input.models[attempt.capability], feedback, signal: input.signal, ...(input.advisors === undefined ? {} : { advisors: input.advisors }) });
      }));
    } finally { for (const lease of leases) first.partitions.release(lease); }
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    for (const [index, job] of jobs.entries()) {
      const result = results[index]; if (result?.status !== "fulfilled") throw new Error("TESTING_BATCH_RESULT_ABSENT");
      const verified = await first.verifier.verify(job.input.task, job.attempt.id, first.workspace, first.signal, result.value.limitations);
      await job.ledger.recordVerification(job.attempt.id, verified.artifactId);
    }
  }
}

async function verificationFeedback(store: RunStore, artifactId: string) {
  const verification = JSON.parse((await store.readArtifact(artifactId)).content) as { checks: { executionId: string | null }[] };
  const descriptors = await store.listArtifacts();
  const diagnostics = [];
  for (const check of verification.checks) {
    if (check.executionId === null) continue;
    const descriptor = descriptors.find(({ kind }) => kind === `verification-execution-${check.executionId}`);
    if (descriptor === undefined) continue;
    const record = await store.artifacts.get<VerificationExecutionRecord>(descriptor.ref);
    if (record.result !== undefined) diagnostics.push({ artifactId: descriptor.artifactId, checkId: record.checkId,
      stdout: excerpt(record.result.stdout), stderr: excerpt(record.result.stderr) });
  }
  return { trust: "untrusted_data", artifactId, verification, diagnostics };
}
function excerpt(value: string) { return { text: value.length <= 8000 ? value : `${value.slice(0, 4000)}\n[truncated]\n${value.slice(-4000)}`, truncated: value.length > 8000 }; }
