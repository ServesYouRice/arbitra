import { allocateDiscoveryScopes, type AuditDepth, type AuditorScope, type DiscoveryHotspot, type DiscoveryModule } from "./depth.js";

export const ROUND_ZERO_CONTEXT_POLICY = Object.freeze({
  mode: "selected_artifacts" as const, trust: "derived" as const,
  include: Object.freeze(["snapshot_identity", "preflight", "manifest", "audit_protocol", "assigned_scope"]),
  exclude: Object.freeze(["peer_findings", "shared_advisor", "shared_critic", "shared_summary", "model_generated"]),
});
export type DiscoveryArtifactKind = "snapshot_identity" | "preflight" | "manifest" | "audit_protocol" | "assigned_scope";
export interface DiscoveryArtifact { readonly kind: DiscoveryArtifactKind | string; readonly provenance: "deterministic" | "model" | string; readonly ref: string; readonly tokenEstimate: number }
export interface DiscoveryProtocolPin { readonly protocolId: string; readonly protocolVersion: string; readonly protocolHash: string }
export interface DiscoveryAuditor { readonly auditorId: string; readonly modelProfileId: string }
export interface DiscoveryFinding { readonly sourceFindingId: string; readonly findingKey: string }
export interface DiscoverySourceResult { readonly auditorId: string; readonly findings: readonly DiscoveryFinding[]; readonly truncated: boolean; readonly unexaminedDueToBudget: readonly string[]; readonly limitations: readonly string[] }
export interface DiscoveryRequest { readonly auditor: DiscoveryAuditor; readonly artifacts: readonly DiscoveryArtifact[]; readonly assignedScope: AuditorScope; readonly protocol: DiscoveryProtocolPin; readonly forceStructuredEmission: boolean; readonly forbiddenContextSources: readonly string[] }
export interface DiscoveryAuditorRuntime { run(request: DiscoveryRequest): Promise<DiscoverySourceResult> }
export interface DiscoveryResultStore { persist(auditorId: string, result: DiscoverySourceResult): Promise<string> }
export type SharedReasoningSource = "shared_advisor" | "shared_critic" | "shared_summary" | "peer_findings";
export interface DiscoveryNodeConfig {
  readonly auditors: readonly DiscoveryAuditor[]; readonly depth: AuditDepth; readonly modules: readonly DiscoveryModule[]; readonly hotspots: readonly DiscoveryHotspot[];
  readonly protocol: DiscoveryProtocolPin; readonly nodeTokenBudget: number; readonly structuredEmissionReserveTokens: number; readonly sharedReasoningSource?: SharedReasoningSource;
}
export interface DiscoveryRunRecord { readonly round: 0; readonly protocol: DiscoveryProtocolPin; readonly sourceResultRefs: Readonly<Record<string, string>>; readonly independence: { readonly degraded: boolean; readonly reason: SharedReasoningSource | null }; readonly results: readonly DiscoverySourceResult[] }
export interface DiscoveryNode { readonly contextPolicy: typeof ROUND_ZERO_CONTEXT_POLICY; run(artifacts: readonly DiscoveryArtifact[]): Promise<DiscoveryRunRecord> }

export function discoveryNode(config: DiscoveryNodeConfig, runtime: DiscoveryAuditorRuntime, store: DiscoveryResultStore): DiscoveryNode {
  validateConfig(config);
  return Object.freeze({ contextPolicy: ROUND_ZERO_CONTEXT_POLICY, async run(artifacts: readonly DiscoveryArtifact[]) {
    validateArtifacts(artifacts);
    const inputTokens = artifacts.reduce((sum, artifact) => sum + artifact.tokenEstimate, 0);
    const forceStructuredEmission = inputTokens >= config.nodeTokenBudget - config.structuredEmissionReserveTokens;
    const scopes = allocateDiscoveryScopes(config.depth, config.auditors.map(({ auditorId }) => auditorId), config.modules, config.hotspots);
    const byAuditor = new Map(scopes.map((scope) => [scope.auditorId, scope]));
    const completed = await Promise.all(config.auditors.map(async (auditor) => {
      const assignedScope = byAuditor.get(auditor.auditorId)!;
      const raw = await runtime.run(Object.freeze({ auditor, artifacts: Object.freeze([...artifacts]), assignedScope, protocol: config.protocol, forceStructuredEmission, forbiddenContextSources: ROUND_ZERO_CONTEXT_POLICY.exclude }));
      const result = normalizeResult(raw, auditor.auditorId, assignedScope, forceStructuredEmission);
      const ref = await store.persist(auditor.auditorId, result);
      return { result, ref };
    }));
    const refs = Object.fromEntries(completed.map(({ result, ref }) => [result.auditorId, ref]));
    return Object.freeze({ round: 0 as const, protocol: config.protocol, sourceResultRefs: Object.freeze(refs), independence: Object.freeze({ degraded: config.sharedReasoningSource !== undefined, reason: config.sharedReasoningSource ?? null }), results: Object.freeze(completed.map(({ result }) => result)) });
  } });
}

function validateConfig(config: DiscoveryNodeConfig): void {
  if (config.auditors.length === 0 || new Set(config.auditors.map(({ auditorId }) => auditorId)).size !== config.auditors.length) throw new Error("INVALID_DISCOVERY_AUDITORS");
  if (!/^[a-f0-9]{64}$/u.test(config.protocol.protocolHash)) throw new Error("DISCOVERY_PROTOCOL_NOT_PINNED");
  if (!Number.isSafeInteger(config.nodeTokenBudget) || !Number.isSafeInteger(config.structuredEmissionReserveTokens) || config.nodeTokenBudget <= config.structuredEmissionReserveTokens || config.structuredEmissionReserveTokens < 0) throw new Error("INVALID_DISCOVERY_TOKEN_BUDGET");
}
function validateArtifacts(artifacts: readonly DiscoveryArtifact[]): void {
  const allowed = new Set(ROUND_ZERO_CONTEXT_POLICY.include);
  for (const artifact of artifacts) {
    if (artifact.provenance === "model") throw new Error(`ROUND_ZERO_MODEL_CONTEXT_FORBIDDEN:${artifact.ref}`);
    if (artifact.provenance !== "deterministic" || !allowed.has(artifact.kind as DiscoveryArtifactKind)) throw new Error(`ROUND_ZERO_CONTEXT_FORBIDDEN:${artifact.kind}`);
    if (!Number.isSafeInteger(artifact.tokenEstimate) || artifact.tokenEstimate < 0) throw new Error("INVALID_ARTIFACT_TOKEN_ESTIMATE");
  }
}
function normalizeResult(raw: DiscoverySourceResult, auditorId: string, scope: AuditorScope, force: boolean): DiscoverySourceResult {
  if (raw.auditorId !== auditorId) throw new Error(`DISCOVERY_AUDITOR_MISMATCH:${auditorId}`);
  for (const finding of raw.findings) if (!finding.sourceFindingId.startsWith(`${auditorId}/`)) throw new Error(`UNNAMESPACED_SOURCE_FINDING:${finding.sourceFindingId}`);
  const unexamined = force && raw.unexaminedDueToBudget.length === 0 ? scope.moduleIds : raw.unexaminedDueToBudget;
  return Object.freeze({ ...raw, findings: Object.freeze([...raw.findings]), truncated: force || raw.truncated, unexaminedDueToBudget: Object.freeze([...unexamined]), limitations: Object.freeze([...raw.limitations, ...(force && !raw.limitations.includes("node_token_budget") ? ["node_token_budget"] : [])]) });
}
