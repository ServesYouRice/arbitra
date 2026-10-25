import type { PlanIR } from "@arbitra/schemas/plan.js";

/** What a part of a large plan reads in place of the planner's reasoning about the whole plan. */
export const REASONING_LEFT_OUT = "Left out of this part: the planner's reasoning about the whole plan is read with the complete plan only.";

type Notes = Pick<PlanIR, "implementationStrategy" | "dependencies" | "rolloutConcerns" | "migrationConcerns" | "unresolvedQuestions">;

/**
 * The plan-wide notes (strategy, dependencies, rollout, migration, open questions) a part of a large plan reads: those
 * that name one of the part's own tasks, issues or assertions, and those that name none. Observed live (veritra, a
 * 227-task plan of 1.4 MB): with every note and the planner's reasoning, the rest of the plan beside one task was
 * 370 KB, more than the critic's whole context at the run's bytes a token, and then more than the reviser's.
 */
export function planNotes(plan: PlanIR, issueIds: readonly string[]): (own: ReadonlySet<string>) => Notes {
  const known = [...plan.tasks.map(({ id }) => id), ...issueIds, ...plan.validationContract.validation.map(({ id }) => id)];
  const naming = known.length === 0 ? null : new RegExp([...known].sort((a, b) => b.length - a.length).map((id) => id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|"), "gu");
  const named = <T>(entries: readonly T[], text: (entry: T) => string) => entries.map((entry) => ({ entry, names: new Set(naming === null ? [] : text(entry).match(naming) ?? []) }));
  const all = { implementationStrategy: named(plan.implementationStrategy, String), dependencies: named(plan.dependencies, String), rolloutConcerns: named(plan.rolloutConcerns, String),
    migrationConcerns: named(plan.migrationConcerns, String), unresolvedQuestions: named(plan.unresolvedQuestions, ({ question }) => question) };
  return (own) => {
    const about = <T>(scoped: readonly { entry: T; names: ReadonlySet<string> }[]) => scoped.filter(({ names }) => names.size === 0 || [...names].some((id) => own.has(id))).map(({ entry }) => entry);
    return { implementationStrategy: about(all.implementationStrategy), dependencies: about(all.dependencies), rolloutConcerns: about(all.rolloutConcerns),
      migrationConcerns: about(all.migrationConcerns), unresolvedQuestions: about(all.unresolvedQuestions) };
  };
}
