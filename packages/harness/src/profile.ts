export interface HarnessCapabilities {
  readonly readFiles: boolean; readonly writeFiles: boolean; readonly shell: boolean;
  readonly skills: boolean; readonly hooks: boolean; readonly mcp: boolean; readonly subagents: boolean;
  readonly sandbox: boolean; readonly resumableSessions: boolean; readonly structuredEvents: boolean;
  readonly enforcesExternalPolicy: boolean; readonly managesContextInternally: boolean; readonly reportsUsage: boolean;
}
export interface HarnessPolicy {
  readonly projectInstructions: "disabled" | "enabled";
  readonly network: "none" | "restricted" | "full";
  readonly memory: "none" | "session" | "persistent";
  readonly subagents: boolean; readonly advisor: boolean;
}
export interface HarnessProfile {
  readonly id: string; readonly version: string; readonly kind: string;
  readonly capabilities: HarnessCapabilities; readonly policy: HarnessPolicy;
}
export interface HarnessRequirements { readonly structuredEvents?: boolean; readonly enforcesExternalPolicy?: boolean; readonly reportsUsage?: boolean }
export type HarnessMode = "audit" | "feature" | "testing";

export const ROUND_ZERO_POLICY: HarnessPolicy = Object.freeze({
  projectInstructions: "disabled", network: "none", memory: "none", subagents: false, advisor: false,
});
export const CANONICAL_HARNESS_PROFILE: HarnessProfile = Object.freeze({
  id: "arbitra-canonical", version: "1.0.0", kind: "canonical",
  capabilities: Object.freeze({ readFiles: true, writeFiles: false, shell: false, skills: false, hooks: false, mcp: false, subagents: false, sandbox: false, resumableSessions: false, structuredEvents: true, enforcesExternalPolicy: true, managesContextInternally: false, reportsUsage: true }),
  policy: ROUND_ZERO_POLICY,
});

export function assertHarnessCompatible(profile: HarnessProfile, mode: HarnessMode, requirements: HarnessRequirements = {}): void {
  if (profile.id.trim() === "" || profile.version.trim() === "" || profile.kind.trim() === "") throw new Error("INVALID_HARNESS_PROFILE");
  for (const capability of ["structuredEvents", "enforcesExternalPolicy", "reportsUsage"] as const) {
    if (requirements[capability] === true && !profile.capabilities[capability]) throw new Error(`HARNESS_CAPABILITY_REQUIRED:${capability}`);
  }
  if (mode === "audit" && profile.capabilities.managesContextInternally) throw new Error("AUDIT_INTERNAL_CONTEXT_FORBIDDEN");
}

export function assertRoundZeroPolicy(profile: HarnessProfile): void {
  const p = profile.policy; const c = profile.capabilities;
  if (p.projectInstructions !== "disabled" || p.network !== "none" || p.memory !== "none" || p.subagents || p.advisor
    || c.writeFiles || c.skills || c.subagents) throw new Error("ROUND_ZERO_POLICY_VIOLATION");
}

export interface HarnessCompatibility { readonly harnessId: string; readonly harnessVersion: string; readonly modelProfileId: string; readonly modelProfileVersion: string; readonly tested: boolean }
export function canonicalCompatibility(modelProfileId: string, modelProfileVersion: string): HarnessCompatibility {
  if (modelProfileId.trim() === "" || modelProfileVersion.trim() === "") throw new Error("INVALID_MODEL_HARNESS_COMPATIBILITY");
  return Object.freeze({ harnessId: CANONICAL_HARNESS_PROFILE.id, harnessVersion: CANONICAL_HARNESS_PROFILE.version, modelProfileId, modelProfileVersion, tested: true });
}
