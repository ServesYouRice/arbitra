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
