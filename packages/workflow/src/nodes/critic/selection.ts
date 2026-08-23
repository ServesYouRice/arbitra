export type CapabilityClass = "fast" | "balanced" | "frontier";

export interface CriticProfile {
  readonly id: string;
  readonly capability: CapabilityClass;
  readonly independenceGroup: string;
  readonly available: boolean;
}

export interface CriticSelection {
  readonly kind: "selected";
  readonly critic: CriticProfile;
  readonly reducedIndependence: boolean;
  readonly rejectedAlternatives: readonly { readonly id: string; readonly reason: string }[];
}

export interface CriticSkip {
  readonly kind: "skipped";
  readonly reason: "no_available_critic_at_or_above_planner_capability";
  readonly degradedReviewCoverage: true;
  readonly rejectedAlternatives: readonly { readonly id: string; readonly reason: string }[];
}

const rank: Readonly<Record<CapabilityClass, number>> = Object.freeze({ fast: 0, balanced: 1, frontier: 2 });

export function selectCritic(
  pool: readonly CriticProfile[],
  planner: Pick<CriticProfile, "id" | "capability" | "independenceGroup">,
): CriticSelection | CriticSkip {
  const rejected = pool.filter((candidate) => candidate.id === planner.id || !candidate.available || rank[candidate.capability] < rank[planner.capability]).map((candidate) => Object.freeze({
    id: candidate.id,
    reason: candidate.id === planner.id ? "same_as_planner" : !candidate.available ? "unavailable" : "capability_below_planner",
  }));
  const eligible = pool.filter((candidate) => candidate.id !== planner.id && candidate.available && rank[candidate.capability] >= rank[planner.capability]).sort((left, right) => {
    const leftIndependent = left.independenceGroup === planner.independenceGroup ? 1 : 0;
    const rightIndependent = right.independenceGroup === planner.independenceGroup ? 1 : 0;
    return leftIndependent - rightIndependent || rank[left.capability] - rank[right.capability] || left.id.localeCompare(right.id);
  });
  const critic = eligible[0];
  if (critic === undefined) return Object.freeze({ kind: "skipped", reason: "no_available_critic_at_or_above_planner_capability", degradedReviewCoverage: true, rejectedAlternatives: Object.freeze(rejected) });
  const nonSelected = eligible.slice(1).map((candidate) => Object.freeze({
    id: candidate.id,
    reason: candidate.independenceGroup === planner.independenceGroup && critic.independenceGroup !== planner.independenceGroup
      ? "not_preferred_independence_group"
      : "not_selected_by_stable_tiebreak",
  }));
  return Object.freeze({ kind: "selected", critic, reducedIndependence: critic.independenceGroup === planner.independenceGroup, rejectedAlternatives: Object.freeze([...rejected, ...nonSelected]) });
}
