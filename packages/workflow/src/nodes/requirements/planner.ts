import { requirementsContractSchema } from "@arbitra/schemas/requirements.js";
import { plannerNode, PlannerTraceabilityError, type PlannerInput, type PlannerNodeConfig } from "../planner/node.js";
import type { TraceablePlan, TraceabilityDiagnostic } from "../planner/traceability.js";
import type { RequirementsContract } from "./types.js";

export function featurePlannerNode<TPlan extends TraceablePlan>(config: PlannerNodeConfig<TPlan>) {
  const planner = plannerNode(config);
  return Object.freeze({ async run(input: PlannerInput & { readonly requirements: RequirementsContract }) {
    const requirements = requirementsContractSchema.parse(input.requirements);
    const accepted = new Set(requirements.decision.acceptedDefaults.map(({ ambiguityId }) => ambiguityId));
    if (requirements.decision.mode === "interactive" && requirements.ambiguities.some(({ id, blastRadius }) => blastRadius === "high" && !accepted.has(id))) throw new Error("FEATURE_REQUIREMENTS_CHECKPOINT_UNRESOLVED");
    const result = await planner.run({ ...input, projectContext: { context: input.projectContext, requirements } });
    const diagnostics = validateFeaturePlanTraceability(requirements, result.plan);
    if (diagnostics.length > 0) throw new PlannerTraceabilityError(diagnostics);
    return result;
  } });
}

export function validateFeaturePlanTraceability(requirements: RequirementsContract, plan: TraceablePlan): readonly TraceabilityDiagnostic[] {
  const diagnostics: TraceabilityDiagnostic[] = [];
  const invalid = (path: string, message: string) => diagnostics.push(Object.freeze({ code: "FEATURE_REQUIREMENT_LINK_INVALID" as const, path, message }));
  if (plan.mode !== "feature") invalid("mode", "Feature requirements require a Feature plan.");
  const known = new Set([...requirements.assumptions, ...requirements.acceptance].map(({ id }) => id));
  const links = new Map(plan.traceability.requirementLinks.links.map((link) => [link.requirementId, link]));
  const tasks = new Map(plan.tasks.map((task) => [task.id, task]));
  for (const requirement of requirements.acceptance) {
    const link = links.get(requirement.id);
    if (link === undefined || link.taskIds.length === 0 || link.validationIds.length === 0) invalid("traceability.requirementLinks", `Acceptance ${requirement.id} requires an implementation task and validation.`);
  }
  for (const task of plan.tasks) {
    if (task.addresses.requirements.length === 0) invalid("tasks", `Task ${task.id} must reference an assumption or acceptance criterion.`);
    for (const id of task.addresses.requirements) {
      const link = links.get(id);
      if (!known.has(id) || link === undefined || !link.taskIds.includes(task.id) || !link.validationIds.some((validationId) => task.addresses.validation.includes(validationId))) invalid("tasks", `Task ${task.id} has an unknown or inconsistent requirement link ${id}.`);
    }
  }
  for (const link of links.values()) {
    if (!known.has(link.requirementId)) invalid("traceability.requirementLinks", `Unknown requirement ${link.requirementId}.`);
    for (const taskId of link.taskIds) if (!tasks.get(taskId)?.addresses.requirements.includes(link.requirementId)) invalid("traceability.requirementLinks", `Task ${taskId} does not address requirement ${link.requirementId}.`);
    for (const validationId of link.validationIds) if (!link.taskIds.some((taskId) => tasks.get(taskId)?.addresses.validation.includes(validationId))) invalid("traceability.requirementLinks", `Validation ${validationId} is not addressed by a task implementing ${link.requirementId}.`);
  }
  return Object.freeze(diagnostics);
}
