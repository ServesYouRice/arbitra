import { planIRSchema, type PlanIR } from "@arbitra/schemas/plan.js";
import { PlannerTraceabilityError, withoutSelfReferences } from "@arbitra/workflow/nodes/planner/node.js";
import { validateTraceability } from "@arbitra/workflow/nodes/planner/traceability.js";
import { validateRequirementsPlanTraceability } from "@arbitra/workflow/nodes/requirements/planner.js";
import type { RequirementsContract } from "@arbitra/workflow/nodes/requirements/index.js";

/**
 * The one-call planner reply, validated as its node will validate it, so a traceability defect
 * is rejected while the reply can still be repaired (maximumOutputRepairs) instead of only
 * failing the finished stage. The node re-validates the returned plan unchanged.
 */
export function traceablePlanSchema(mode: "audit" | "feature" | "testing", requirements: RequirementsContract | null, acceptedIssueIds: readonly string[] = []): { parse(value: unknown): PlanIR } {
  return { parse(value: unknown): PlanIR {
    const plan = planIRSchema.parse(withoutSelfReferences(value));
    // The rendered Feature/Testing handoff requires TASK-001 style IDs (observed live: a Feature plan used
    // TASK-1 and failed only at rendering, after planning was spent).
    const invalidIds = mode === "audit" ? [] : plan.tasks.map(({ id }) => id).filter((id) => !/^TASK-[0-9]{3}$/u.test(id));
    if (invalidIds.length > 0) throw new Error(`PLAN_TASK_ID_INVALID: task IDs must look like TASK-001, TASK-002, ...; found ${invalidIds.slice(0, 10).join(", ")}`);
    const diagnostics = [...validateTraceability(plan, [...acceptedIssueIds].sort()), ...(mode === "audit" || requirements === null ? [] : validateRequirementsPlanTraceability(requirements, plan, mode))];
    if (diagnostics.length > 0) throw new PlannerTraceabilityError(diagnostics);
    return plan;
  } };
}
