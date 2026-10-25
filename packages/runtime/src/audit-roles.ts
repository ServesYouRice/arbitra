import type { ProviderExecution } from "@arbitra/schemas/provider-execution.js";

export type AuditRoles = NonNullable<ProviderExecution["roles"]>;

/** Who answers a severe rejection a second time: the configured role, else the critic, else another auditor. */
export function secondOpinionProfile(roles: AuditRoles, auditorIds: readonly string[]): string | undefined {
  const { verifier } = roles;
  const chosen = roles.secondOpinion ?? (roles.critic !== undefined && roles.critic !== verifier ? roles.critic : auditorIds.find((id) => id !== verifier));
  return chosen === verifier ? undefined : chosen;
}
