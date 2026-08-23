import { criticRequired, type CriticRequirementContext } from "./required.js";
import { selectCritic, type CriticProfile } from "./selection.js";

export const CRITIQUE_CATEGORIES = ["missing_issues", "incomplete_requirements", "wrong_dependencies", "unsafe_parallelisation", "migration_hazards", "weak_acceptance_criteria", "weak_verification", "task_sizing", "hidden_architecture_decisions", "incorrect_capability_routing", "regressions", "conflicting_scopes", "missing_rollout_considerations", "invariant_violations"] as const;
export type CritiqueCategory = typeof CRITIQUE_CATEGORIES[number];
export interface CritiqueItem { readonly id: string; readonly category: CritiqueCategory; readonly blocking: boolean; readonly summary: string; readonly taskIds: readonly string[]; readonly issueIds: readonly string[] }
export interface StructuredCritique { readonly items: readonly CritiqueItem[]; readonly summary: string }
export interface RejectedCritiqueItem { readonly item: CritiqueItem; readonly code: "UNACTIONABLE_CRITIQUE_ITEM" | "UNKNOWN_CRITIQUE_MAPPING"; readonly reason: "unactionable_no_task_or_issue" | "unknown_task_or_issue" }
export interface CriticInput { readonly plan: { readonly tasks: readonly { readonly id: string }[] }; readonly validationContract: unknown; readonly canonicalIssues: readonly { readonly candidateId: string }[]; readonly necessaryContext: readonly { readonly ref: string; readonly content: string; readonly trust: "repo" | "derived" | "untrusted_data" }[] }
export interface CriticRequest { readonly criticId: string; readonly protocol: { readonly protocolId: "plan-critic"; readonly protocolVersion: string; readonly protocolHash: string }; readonly input: CriticInput; readonly outputSchema: "StructuredCritique" }
export interface CriticRuntime { critique(request: CriticRequest): Promise<unknown> }
export interface CriticSchema { parse(value: unknown): StructuredCritique }
export interface CriticNodeConfig { readonly protocolVersion: string; readonly protocolHash: string; readonly runtime: CriticRuntime; readonly schema: CriticSchema }
export interface CriticRunContext { readonly requirement: CriticRequirementContext; readonly pool: readonly CriticProfile[]; readonly planner: Pick<CriticProfile, "id" | "capability" | "independenceGroup"> }

export function criticNode(config: CriticNodeConfig) {
  if (!/^[a-f0-9]{64}$/u.test(config.protocolHash) || config.protocolVersion.trim() === "") throw new Error("CRITIC_PROTOCOL_NOT_PINNED");
  return Object.freeze({ async run(input: CriticInput, context: CriticRunContext) {
    const requirement = criticRequired(context.requirement);
    if (!requirement.required) return Object.freeze({ status: "not_required" as const, requirement, degradedReviewCoverage: false, criticCalls: 0 as const });
    const selection = selectCritic(context.pool, context.planner);
    if (selection.kind === "skipped") return Object.freeze({ status: "skipped" as const, requirement, selection, degradedReviewCoverage: true, criticCalls: 0 as const });
    const critique = config.schema.parse(await config.runtime.critique(Object.freeze({ criticId: selection.critic.id, protocol: Object.freeze({ protocolId: "plan-critic" as const, protocolVersion: config.protocolVersion, protocolHash: config.protocolHash }), input, outputSchema: "StructuredCritique" as const })));
    const taskIds = new Set(input.plan.tasks.map(({ id }) => id)); const issueIds = new Set(input.canonicalIssues.map(({ candidateId }) => candidateId));
    const accepted: CritiqueItem[] = []; const rejected: RejectedCritiqueItem[] = [];
    for (const item of critique.items) {
      if (item.taskIds.length === 0 && item.issueIds.length === 0) rejected.push(Object.freeze({ item, code: "UNACTIONABLE_CRITIQUE_ITEM", reason: "unactionable_no_task_or_issue" }));
      else if (item.taskIds.some((id) => !taskIds.has(id)) || item.issueIds.some((id) => !issueIds.has(id))) rejected.push(Object.freeze({ item, code: "UNKNOWN_CRITIQUE_MAPPING", reason: "unknown_task_or_issue" }));
      else accepted.push(item);
    }
    return Object.freeze({ status: "completed" as const, requirement, selection, critique: Object.freeze({ ...critique, items: Object.freeze(accepted) }), rejected: Object.freeze(rejected), degradedReviewCoverage: selection.reducedIndependence, criticCalls: 1 as const });
  } });
}
