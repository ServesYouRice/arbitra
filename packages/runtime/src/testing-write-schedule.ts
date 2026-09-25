import { createHash } from "node:crypto";
import { canonicalJson } from "@arbitra/core/config/config-store.js";
import { planIRSchema, type PlanIR } from "@arbitra/schemas/plan.js";
import { WritePartitions, type TrustedWritePartition, type WriteLease, type WriteRequest } from "@arbitra/security/write-partitions";
import { validateTraceability } from "@arbitra/workflow/nodes/planner/traceability.js";
import { isTestingWritePath } from "./testing-context.js";
import type { TestSystemReport } from "@arbitra/workflow/nodes/test-inventory.js";

/** Supplied by trusted operator configuration, separately from the model's plan. */
export interface TestingWriteAuthorization {
  readonly partitions: readonly TrustedWritePartition[];
  readonly tasks: readonly { readonly taskId: string; readonly partitionId: string; readonly exclusive: boolean }[];
  readonly maximumParallelTasks: number;
}
export interface TestingWriteSchedule {
  readonly planFingerprint: string;
  readonly authorizationFingerprint: string;
  readonly batches: readonly (readonly WriteRequest[])[];
}

/** Preflight the entire plan before creating any writable executor. Batches are
 * scheduling proposals, not leases: dispatch must acquire fresh live leases and
 * recover prior executors before reusing their scopes after a process restart. */
export function testingWriteSchedule(value: unknown, inventory: TestSystemReport, authorization: TestingWriteAuthorization): TestingWriteSchedule {
  const plan = planIRSchema.parse(value);
  if (plan.mode !== "testing" || plan.unresolvedQuestions.some(({ blocking }) => blocking) || validateTraceability(plan, []).length > 0) throw new Error("TESTING_EXECUTION_PLAN_INVALID");
  if (!Number.isSafeInteger(authorization.maximumParallelTasks) || authorization.maximumParallelTasks < 1 || authorization.maximumParallelTasks > 16) throw new Error("INVALID_WRITABLE_CONCURRENCY");
  const tasks = new Map(plan.tasks.map((task) => [task.id, task]));
  const grants = new Map(authorization.tasks.map((task) => [task.taskId, task]));
  if (grants.size !== authorization.tasks.length || grants.size !== tasks.size || [...grants.keys()].some((id) => !tasks.has(id))) {
    const ungranted = [...tasks.keys()].filter((id) => !grants.has(id)); const unknown = [...grants.keys()].filter((id) => !tasks.has(id));
    throw new Error(`TESTING_WRITE_AUTHORIZATION_INCOMPLETE: planned tasks without a write grant [${ungranted.join(", ")}]; grants naming no planned task [${unknown.join(", ")}]. Grant exactly the planned task IDs in workflow.testing.execution.authorization.tasks; no worktree was created.`);
  }
  const guard = new WritePartitions(authorization.partitions);
  const requests = new Map<string, WriteRequest>();
  for (const task of plan.tasks) {
    const grant = grants.get(task.id);
    if (grant === undefined) throw new Error("TESTING_WRITE_AUTHORIZATION_INCOMPLETE");
    if (task.scope.likelyFiles.some((path) => !isTestingWritePath(path, inventory))) throw new Error("TESTING_EXECUTION_PRODUCTION_WRITE_FORBIDDEN");
    const request: WriteRequest = Object.freeze({ taskId: task.id, partitionId: grant.partitionId, paths: Object.freeze([...task.scope.likelyFiles]), filesNotToTouch: Object.freeze([...task.filesNotToTouch]), exclusive: grant.exclusive });
    // Validate all authority up front; a late unauthorized task cannot leave earlier writes behind.
    const lease = guard.acquire(request); guard.release(lease);
    requests.set(task.id, request);
  }
  const completed = new Set<string>();
  const batches: (readonly WriteRequest[])[] = [];
  while (completed.size < tasks.size) {
    const batch: WriteRequest[] = []; const leases: WriteLease[] = [];
    for (const task of [...tasks.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      if (completed.has(task.id) || !dependencies(plan, task.id).every((id) => completed.has(id)) || batch.length >= authorization.maximumParallelTasks) continue;
      if (batch.some(({ taskId }) => task.dependencies.conflictsWith.includes(taskId) || tasks.get(taskId)?.dependencies.conflictsWith.includes(task.id))) continue;
      const request = requests.get(task.id);
      if (request === undefined) throw new Error("TESTING_WRITE_REQUEST_ABSENT");
      try { leases.push(guard.acquire(request)); batch.push(request); }
      catch (error) { if (!(error instanceof Error) || !error.message.startsWith("WRITE_SCOPE_BUSY:")) throw error; }
    }
    if (batch.length === 0) throw new Error("TESTING_WRITE_SCHEDULE_DEADLOCK");
    for (const lease of leases) guard.release(lease);
    for (const task of batch) completed.add(task.taskId);
    batches.push(Object.freeze(batch));
  }
  return Object.freeze({ planFingerprint: fingerprint(plan), authorizationFingerprint: fingerprint(authorization), batches: Object.freeze(batches) });
}

function dependencies(plan: PlanIR, taskId: string): string[] { return plan.taskGraph.filter(({ to }) => to === taskId).map(({ from }) => from); }
function fingerprint(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
