import { createHash } from "node:crypto";

export interface IndependenceProfile {
  readonly auditorId: string; readonly baseUrl: string; readonly resolvedModelId: string;
  readonly fingerprint: string | null; readonly independenceGroup: string | null;
}
export interface FindingSupport { readonly findingKey: string; readonly auditorId: string }
export type IndependenceDegradationReason = "shared_advisor" | "shared_critic" | "shared_summary" | "peer_findings";
export interface IndependenceSupportReport {
  readonly findingKey: string; readonly supportCount: number; readonly auditorCount: number;
  readonly independentGroupsRepresented: number; readonly servedIdentitiesRepresented: number;
  readonly display: string;
}
export interface IndependenceReport {
  readonly degraded: boolean; readonly reason: IndependenceDegradationReason | null;
  readonly configuredAuditors: number; readonly distinctServedIdentities: number;
  readonly groups: readonly { readonly group: string; readonly auditorIds: readonly string[] }[];
  readonly support: readonly IndependenceSupportReport[];
}

export function servedIdentityOf(profile: IndependenceProfile): string {
  const host = new URL(profile.baseUrl).host.toLocaleLowerCase("en-US");
  return createHash("sha256").update(JSON.stringify([host, profile.resolvedModelId, profile.fingerprint])).digest("hex");
}

export function independenceReport(profiles: readonly IndependenceProfile[], findings: readonly FindingSupport[], reason: IndependenceDegradationReason | null = null): IndependenceReport {
  const byAuditor = new Map(profiles.map((profile) => [profile.auditorId, profile]));
  if (byAuditor.size !== profiles.length) throw new Error("DUPLICATE_AUDITOR_ID");
  const identityRepresentatives = new Map<string, IndependenceProfile>();
  for (const profile of profiles) if (!identityRepresentatives.has(servedIdentityOf(profile))) identityRepresentatives.set(servedIdentityOf(profile), profile);
  const groups = new Map<string, string[]>();
  for (const profile of profiles) {
    const group = profile.independenceGroup ?? `singleton:${servedIdentityOf(profile)}`;
    const members = groups.get(group) ?? []; members.push(profile.auditorId); groups.set(group, members);
  }
  const supports = new Map<string, Set<string>>();
  for (const finding of findings) {
    if (!byAuditor.has(finding.auditorId)) throw new Error(`UNKNOWN_FINDING_AUDITOR:${finding.auditorId}`);
    const auditors = supports.get(finding.findingKey) ?? new Set<string>(); auditors.add(finding.auditorId); supports.set(finding.findingKey, auditors);
  }
  const support = [...supports].sort(([a], [b]) => a.localeCompare(b)).map(([findingKey, auditors]) => {
    const identities = new Set<string>(); const representedGroups = new Set<string>();
    for (const auditorId of auditors) { const profile = byAuditor.get(auditorId)!; identities.add(servedIdentityOf(profile)); representedGroups.add(profile.independenceGroup ?? `singleton:${servedIdentityOf(profile)}`); }
    return Object.freeze({ findingKey, supportCount: auditors.size, auditorCount: profiles.length, independentGroupsRepresented: representedGroups.size, servedIdentitiesRepresented: identities.size, display: `Support: ${auditors.size}/${profiles.length} auditors\nIndependent groups represented: ${representedGroups.size}` });
  });
  return Object.freeze({ degraded: reason !== null, reason, configuredAuditors: profiles.length, distinctServedIdentities: identityRepresentatives.size, groups: Object.freeze([...groups].sort(([a], [b]) => a.localeCompare(b)).map(([group, auditorIds]) => Object.freeze({ group, auditorIds: Object.freeze([...auditorIds].sort()) }))), support: Object.freeze(support) });
}
