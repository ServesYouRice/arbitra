import type { ModelProfile } from "@arbitra/schemas/model-profile.js";
import type { ProviderExecution } from "@arbitra/schemas/provider-execution.js";

export type AuditRoles = NonNullable<ProviderExecution["roles"]>;

/** Who answers a severe rejection a second time: the configured role, else the critic, else another auditor. */
export function secondOpinionProfile(roles: AuditRoles, auditorIds: readonly string[]): string | undefined {
  const { verifier } = roles;
  const chosen = roles.secondOpinion ?? (roles.critic !== undefined && roles.critic !== verifier ? roles.critic : auditorIds.find((id) => id !== verifier));
  return chosen === verifier ? undefined : chosen;
}

/** Who decides whether two findings are one issue: the merger, else the verifier. */
export function mergerProfile(roles: AuditRoles): string { return roles.merger ?? roles.verifier; }

/**
 * Who checks an issue against the code: a critical or high one always the verifier, the strongest checker; one below
 * high the medium verifier when the run names one (a cheap audit checks medium issues with Sonnet), else the verifier.
 */
export function checkerProfile(roles: AuditRoles, severity: string): string {
  return severity === "critical" || severity === "high" ? roles.verifier : roles.mediumVerifier ?? roles.verifier;
}

/**
 * Who answers the plan's blocking questions on its own (`workflow.answerCheck`): a model of another vendor than the
 * planner's, its vendor being the profile's `provider`. The configured role, else the critic, else the second opinion,
 * else a finder, whichever is first of another vendor; undefined when the lineup has none, or when the configured
 * role is the planner's vendor.
 */
export function answerCheckerProfile(roles: AuditRoles, auditorIds: readonly string[], models: Readonly<Record<string, Pick<ModelProfile, "provider">>>): string | undefined {
  const vendor = (id: string | undefined) => id === undefined || !Object.hasOwn(models, id) ? undefined : models[id]?.provider;
  const planner = vendor(roles.planner);
  const other = (id: string | undefined): id is string => vendor(id) !== undefined && vendor(id) !== planner;
  if (roles.answerChecker !== undefined) return other(roles.answerChecker) ? roles.answerChecker : undefined;
  return [roles.critic, secondOpinionProfile(roles, auditorIds), ...auditorIds].find(other);
}
