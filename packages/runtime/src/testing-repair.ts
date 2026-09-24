import type { PlanIR } from "@arbitra/schemas/plan.js";
import type { TestingVerificationPolicy } from "@arbitra/schemas/testing-verification.js";
import type { RunStore } from "./run-store.js";

/** One reopen decision taken against an exact invalidated workspace snapshot. */
export interface TestingRepairRound {
  readonly round: number;
  readonly snapshotFingerprint: string;
  readonly failedTaskIds: readonly string[];
  /** Tasks given a new bounded writer attempt, each with the final failure that caused it. */
  readonly reopened: readonly { readonly taskId: string; readonly causeTaskId: string; readonly verificationArtifactId: string }[];
  /** Closure members whose earlier evidence is superseded and must pass final verification again. */
  readonly staleTaskIds: readonly string[];
  readonly state: "reopening" | "reopened";
}
interface Lineage {
  readonly version: 1;
  readonly bindingFingerprint: string;
  readonly maximumRounds: number;
  readonly rounds: readonly TestingRepairRound[];
  readonly terminal?: { readonly snapshotFingerprint: string; readonly reason: string };
}
const KIND = "testing-repair-lineage";
export const DEFAULT_TESTING_REPAIR_ROUNDS = 3;

/** Durable repair lineage for one Testing execution. Rounds and the terminal
 * decision survive restart; the round limit is part of the execution binding. */
export class TestingRepairLineage {
  constructor(private readonly store: RunStore, private readonly bindingFingerprint: string, readonly maximumRounds: number) {
    if (!Number.isSafeInteger(maximumRounds) || maximumRounds < 0 || maximumRounds > 5) throw new Error("INVALID_TESTING_REPAIR_ROUND_LIMIT");
  }

  async load(): Promise<Lineage> {
    const descriptor = (await this.store.listArtifacts()).find(({ kind }) => kind === KIND);
    const empty: Lineage = { version: 1, bindingFingerprint: this.bindingFingerprint, maximumRounds: this.maximumRounds, rounds: [] };
    if (descriptor === undefined) return empty;
    const lineage = await this.store.artifacts.get<Lineage>(descriptor.ref);
    if (lineage.version !== 1 || lineage.bindingFingerprint !== this.bindingFingerprint || lineage.maximumRounds !== this.maximumRounds) throw new Error("TESTING_REPAIR_CONFIGURATION_CHANGED");
    return lineage;
  }

  async save(lineage: Lineage): Promise<void> { await this.store.publish(KIND, lineage, "testing-execution"); }
}

/** The dependency/conflict closure of deterministic final failures. A related task is
 * reopened for writing only if it declared a conflict with a failing task or its
 * recorded writes reach that task's write scope or check sources; other closure members
 * (dependents, scope sharers) are marked stale and re-verified. Reopened tasks keep
 * their original authorized write request; no scope is derived from the failure. */
export function testingRepairClosure(plan: PlanIR, policy: TestingVerificationPolicy, failures: readonly { taskId: string; artifactId: string }[],
  writtenPaths: ReadonlyMap<string, readonly string[]>): { reopened: TestingRepairRound["reopened"]; staleTaskIds: string[] } {
  const tasks = new Map(plan.tasks.map((task) => [task.id, task]));
  const failed = new Set(failures.map(({ taskId }) => taskId));
  const reopened = new Map<string, TestingRepairRound["reopened"][number]>();
  const closure = new Set<string>();
  const sources = (taskId: string) => {
    const task = tasks.get(taskId); if (task === undefined) throw new Error("TESTING_REPAIR_TASK_ABSENT");
    const checks = task.verification.commands.flatMap(({ command }) => {
      const binding = policy.bindings.find((entry) => entry.command === command);
      return policy.execution.checks.filter(({ id }) => id === binding?.checkId).flatMap(({ sourcePaths }) => sourcePaths);
    });
    return new Set([...task.scope.likelyFiles, ...checks]);
  };
  for (const failure of [...failures].sort((a, b) => a.taskId.localeCompare(b.taskId))) {
    const task = tasks.get(failure.taskId); if (task === undefined) throw new Error("TESTING_REPAIR_TASK_ABSENT");
    reopened.set(task.id, { taskId: task.id, causeTaskId: task.id, verificationArtifactId: failure.artifactId });
    const inputs = sources(task.id);
    const dependents = new Set<string>(); const queue = [task.id];
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      for (const { from, to } of plan.taskGraph) if (from === next && !dependents.has(to)) { dependents.add(to); queue.push(to); }
    }
    for (const other of [...tasks.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      if (other.id === task.id || failed.has(other.id)) continue;
      const conflict = task.dependencies.conflictsWith.includes(other.id) || other.dependencies.conflictsWith.includes(task.id);
      const reaches = (writtenPaths.get(other.id) ?? []).some((path) => inputs.has(path));
      const sharesScope = other.scope.likelyFiles.some((path) => task.scope.likelyFiles.includes(path));
      if (!conflict && !reaches && !sharesScope && !dependents.has(other.id)) continue;
      closure.add(other.id);
      if ((conflict || reaches) && !reopened.has(other.id)) reopened.set(other.id, { taskId: other.id, causeTaskId: task.id, verificationArtifactId: failure.artifactId });
    }
  }
  const staleTaskIds = [...closure].filter((id) => !reopened.has(id)).sort();
  return { reopened: [...reopened.values()].sort((a, b) => a.taskId.localeCompare(b.taskId)), staleTaskIds };
}
