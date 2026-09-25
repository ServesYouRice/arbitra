import { createHash } from "node:crypto";
import { canonicalJson } from "@arbitra/core/config/config-store.js";
import type { RunConfig, RunScope } from "@arbitra/schemas/config.js";
import { featureExecutionSchema } from "@arbitra/schemas/feature-execution.js";
import { providerExecutionSchema } from "@arbitra/schemas/provider-execution.js";
import { testingExecutionSchema } from "@arbitra/schemas/testing.js";
import type { ActivityReplaySource } from "./model-activities.js";
import type { RunStore } from "./run-store.js";

export type ModelReplayMode = "feature" | "testing";

/**
 * One replayable stage of a Feature or Testing run. A stage owns the model activities
 * whose IDs it matches and is bound to the identity components below. Stages form a
 * chain: a changed upstream stage invalidates every stage after it.
 */
interface StageDefinition {
  readonly stage: string;
  readonly matches: (activityId: string) => boolean;
  /** Stages with side effects are never reused; their evidence must be fresh. */
  readonly reusable: boolean;
  readonly protocols: readonly string[];
  readonly roles: (config: RunConfig) => readonly string[];
  readonly settings: (config: RunConfig) => unknown;
  /** Absent from a configuration that does not run the stage. */
  readonly present?: (config: RunConfig) => boolean;
}

const under = (...prefixes: readonly string[]) => (activityId: string): boolean => prefixes.some((prefix) => activityId === prefix || activityId.startsWith(`${prefix}/`));
const feature = (config: RunConfig) => featureExecutionSchema.parse(config.workflow["feature"]);
const testing = (config: RunConfig) => testingExecutionSchema.parse(config.workflow["testing"]);

/** The Feature replay contract: requirements → exploration → review → revision → planning. */
export const FEATURE_REPLAY_STAGES: readonly StageDefinition[] = Object.freeze([
  { stage: "requirements", matches: under("feature/requirements"), reusable: true, protocols: ["feature-requirements"],
    roles: (config) => [feature(config).roles.requirements], settings: (config) => ({ request: feature(config).request, mode: feature(config).mode }) },
  { stage: "exploration", matches: under("feature/exploration"), reusable: true, protocols: ["feature-exploration"],
    roles: (config) => [feature(config).roles.exploration], settings: () => null },
  { stage: "review", matches: under("feature/review"), reusable: true, protocols: ["feature-review"],
    roles: (config) => feature(config).roles.reviewers, settings: () => null },
  { stage: "requirements-revision", matches: under("feature/requirements-revision"), reusable: true, protocols: ["feature-requirements-revision"],
    roles: (config) => [feature(config).roles.requirements], settings: (config) => ({ maximumRequirementsRevisions: feature(config).maximumRequirementsRevisions }) },
  { stage: "planning", matches: under("feature/planner", "feature/critic", "feature/planner-revision"), reusable: true, protocols: ["planner", "plan-critic"],
    roles: (config) => [feature(config).roles.planner, ...(feature(config).roles.critic === undefined ? [] : [feature(config).roles.critic as string])], settings: () => null },
]);

/**
 * The Testing replay contract: analysis → planning → execution. Planning is bound to the
 * write authorization it planned against. Execution writes files and runs checks, so it is
 * never reused: an execution replay always gets a new worktree and fresh evidence.
 */
export const TESTING_REPLAY_STAGES: readonly StageDefinition[] = Object.freeze([
  // Analysis activities are keyed by the complete Testing settings, including any execution
  // grant, so the contract binds the stage to all of them rather than claiming reuse it
  // could not deliver.
  { stage: "analysis", matches: under("testing/risk", "testing/selection"), reusable: true, protocols: ["testing-risk", "testing-audit"],
    roles: (config) => [testing(config).roles.analyst], settings: (config) => testing(config) },
  { stage: "planning", matches: under("testing/planner"), reusable: true, protocols: ["planner"],
    roles: (config) => [testing(config).roles.planner], settings: (config) => {
      const settings = testing(config);
      return { goal: settings.goal, authorization: settings.mode === "execute" ? settings.execution.authorization : null };
    } },
  { stage: "execution", matches: under("testing/writer"), reusable: false, protocols: ["testing-writer"], present: (config) => testing(config).mode === "execute",
    roles: (config) => { const settings = testing(config); return settings.mode === "execute" ? Object.values(settings.execution.models) : []; },
    settings: (config) => { const settings = testing(config); return settings.mode === "execute" ? settings.execution : null; } },
]);

export function replayStages(mode: ModelReplayMode): readonly StageDefinition[] { return mode === "feature" ? FEATURE_REPLAY_STAGES : TESTING_REPLAY_STAGES; }

export interface ProtocolPin { readonly protocolVersion: string; readonly protocolHash: string }

/** Everything outside the configuration that a stage identity is bound to. */
export interface ReplayEnvironment {
  readonly repositoryDigest: string;
  readonly scope: RunScope;
  /** A protocol pinned for the run, or null when the run has no intact pinned copy. */
  readonly protocol: (id: string) => Promise<ProtocolPin | null>;
  /**
   * The pin to assume for a protocol the source never pinned. A run that never pinned a
   * protocol has no output produced under it, so no activity can be reused through it;
   * assuming the replay's pin keeps an unused protocol from invalidating a whole stage.
   */
  readonly unpinned?: (id: string) => Promise<ProtocolPin>;
}

export interface StageIdentity {
  readonly stage: string;
  readonly identity: string;
  /** Hashes of each identity component, so a decision can name what changed. */
  readonly components: Readonly<Record<string, string>>;
  /** Stage protocols the run has no intact pinned copy of. */
  readonly missing: readonly string[];
}

export async function stageIdentities(mode: ModelReplayMode, config: RunConfig, environment: ReplayEnvironment): Promise<readonly StageIdentity[]> {
  const execution = providerExecutionSchema.parse(config.workflow["modelExecution"]);
  const result: StageIdentity[] = [];
  let upstream: string | null = null;
  for (const definition of replayStages(mode)) {
    if (definition.present !== undefined && !definition.present(config)) continue;
    const missing: string[] = [];
    const protocols: Record<string, ProtocolPin | null> = {};
    for (const id of definition.protocols) {
      let pin = await environment.protocol(id);
      if (pin === null) {
        missing.push(id);
        if (environment.unpinned !== undefined) pin = await environment.unpinned(id);
      }
      protocols[id] = pin === null ? null : { protocolVersion: pin.protocolVersion, protocolHash: pin.protocolHash };
    }
    const models = definition.roles(config).map((id) => {
      const endpointId = execution.modelEndpoints[id];
      return { id, profile: config.models[id] ?? null, endpoint: execution.endpoints.find((endpoint) => endpoint.id === endpointId) ?? null };
    });
    const components: Record<string, string> = {
      repository: digest(environment.repositoryDigest),
      scope: digest(environment.scope),
      harness: digest(config.harness),
      settings: digest(definition.settings(config)),
      models: digest({ models, maximumOutputTokens: execution.maximumOutputTokens }),
      protocols: digest({ protocols, overrides: definition.protocols.map((id) => config.promptOverrides[id] ?? null) }),
      upstream: digest(upstream),
    };
    const identity = digest({ mode, stage: definition.stage, components });
    result.push(Object.freeze({ stage: definition.stage, identity, components: Object.freeze(components), missing: Object.freeze(missing) }));
    upstream = identity;
  }
  return Object.freeze(result);
}

export interface StageDecision {
  readonly stage: string;
  readonly decision: "reuse" | "regenerate";
  readonly reasons: readonly string[];
  readonly sourceIdentity: string | null;
  readonly identity: string;
  /** Protocols the source never pinned; no source output can be reused through them. */
  readonly sourceUnpinnedProtocols: readonly string[];
}

/** Compare a replay run's stage identities with its source run's. Unknown never means equal. */
export function decideStages(mode: ModelReplayMode, source: readonly StageIdentity[], target: readonly StageIdentity[]): readonly StageDecision[] {
  return Object.freeze(target.map((stage) => {
    const definition = replayStages(mode).find((item) => item.stage === stage.stage);
    const prior = source.find((item) => item.stage === stage.stage);
    const reasons: string[] = [];
    if (definition?.reusable !== true) reasons.push("side_effecting_stage_requires_fresh_evidence");
    if (prior === undefined) reasons.push("source_stage_absent");
    else for (const [component, value] of Object.entries(stage.components)) if (prior.components[component] !== value) reasons.push(`changed:${component}`);
    return Object.freeze({ stage: stage.stage, decision: reasons.length === 0 ? "reuse" as const : "regenerate" as const, reasons: Object.freeze(reasons),
      sourceIdentity: prior?.identity ?? null, identity: stage.identity, sourceUnpinnedProtocols: Object.freeze([...prior?.missing ?? []]) });
  }));
}

/** The immutable decision record a replay run is created with, and resumed from. */
export interface ReplayContract {
  readonly schemaVersion: 1;
  readonly sourceRunId: string;
  readonly mode: ModelReplayMode;
  readonly sourceRepositoryDigest: string;
  readonly repositoryDigest: string;
  readonly stages: readonly StageDecision[];
  readonly execution: { readonly mode: "none" } | { readonly mode: "plan" } | { readonly mode: "execute"; readonly authorizationDigest: string; readonly authority: "replay_request" };
  readonly requirements: { readonly decision: "reapprove" } | { readonly decision: "reuse_approved"; readonly artifactId: string };
}

export const REPLAY_CONTRACT_KIND = "replay-contract";

/**
 * The contract a Feature/Testing replay run was created with, or null for any other run.
 * A missing or corrupt copy fails explicitly: a replay is never resumed or reported
 * without the decisions it was created under.
 */
export async function readReplayContract(store: RunStore): Promise<ReplayContract | null> {
  const descriptor = (await store.listArtifacts()).find(({ kind }) => kind === REPLAY_CONTRACT_KIND);
  if (descriptor === undefined) return null;
  const unreadable = () => Object.assign(new Error(`REPLAY_CONTRACT_UNREADABLE:${store.runId}`), { statusCode: 409 });
  let contract: Partial<ReplayContract> | null;
  try { contract = await store.artifacts.get<Partial<ReplayContract> | null>(descriptor.ref); }
  catch { throw unreadable(); }
  if (typeof contract !== "object" || contract === null || contract.schemaVersion !== 1 || (contract.mode !== "feature" && contract.mode !== "testing") || typeof contract.sourceRunId !== "string" || !Array.isArray(contract.stages)) throw unreadable();
  return contract as ReplayContract;
}

/**
 * Serves source outputs to a replay run. Every lookup, reuse or miss is recorded in the
 * replay run as `replay-activity-<key>`, so the replay's provenance is inspectable. The
 * source run is only read.
 */
export class ReplaySeed implements ActivityReplaySource {
  constructor(private readonly source: RunStore, private readonly target: RunStore, readonly contract: ReplayContract) {
    if (source.runId !== contract.sourceRunId || target.runId === source.runId) throw new Error("REPLAY_SEED_RUN_MISMATCH");
  }

  async lookup(request: { readonly activityId: string; readonly key: string; readonly replayIdentity: string }) {
    const definition = replayStages(this.contract.mode).find(({ matches }) => matches(request.activityId));
    const decision = definition === undefined ? undefined : this.contract.stages.find(({ stage }) => stage === definition.stage);
    const miss = async (reason: string) => { await this.record(request, decision?.stage ?? null, { decision: "regenerated", reason }); return null; };
    if (definition === undefined || decision === undefined) return miss("activity_outside_replay_contract");
    if (decision.decision !== "reuse") return miss("stage_invalidated");
    const saved = await readReplayableOutput(this.source, request.key, request.replayIdentity);
    if ("reason" in saved) return miss(saved.reason);
    await this.record(request, decision.stage, { decision: "reused", sourceArtifactId: saved.sourceArtifactId });
    return { value: saved.value, sourceRunId: this.source.runId, sourceArtifactId: saved.sourceArtifactId };
  }

  async reject(request: { readonly activityId: string; readonly key: string }, reason: string): Promise<void> {
    const definition = replayStages(this.contract.mode).find(({ matches }) => matches(request.activityId));
    await this.record(request, definition?.stage ?? null, { decision: "regenerated", reason });
  }

  private async record(request: { readonly activityId: string; readonly key: string }, stage: string | null, outcome: { readonly decision: "reused"; readonly sourceArtifactId: string } | { readonly decision: "regenerated"; readonly reason: string }): Promise<void> {
    await this.target.publish(`replay-activity-${request.key}`, { activityId: request.activityId, stage, sourceRunId: this.source.runId, ...outcome }, request.activityId);
  }
}

/**
 * A saved model output from another run, usable only when it was produced under exactly
 * the requested replay identity. A missing or corrupt artifact is never trusted.
 */
export async function readReplayableOutput(source: RunStore, key: string, replayIdentity: string): Promise<{ readonly value: unknown; readonly sourceArtifactId: string } | { readonly reason: string }> {
  const descriptor = (await source.listArtifacts()).find(({ kind }) => kind === key);
  if (descriptor === undefined) return { reason: "source_activity_absent" };
  let saved: { value?: unknown; replayIdentity?: unknown };
  try { saved = await source.artifacts.get<{ value?: unknown; replayIdentity?: unknown }>(descriptor.ref); }
  catch { return { reason: "source_artifact_unreadable" }; }
  if (typeof saved !== "object" || saved === null || !("value" in saved)) return { reason: "source_artifact_unreadable" };
  if (typeof saved.replayIdentity !== "string") return { reason: "source_activity_identity_unavailable" };
  if (saved.replayIdentity !== replayIdentity) return { reason: "activity_identity_changed" };
  return { value: saved.value, sourceArtifactId: descriptor.artifactId };
}

export interface ReplayActivityRecord { readonly activityId: string; readonly stage: string | null; readonly sourceRunId: string; readonly decision: "reused" | "regenerated"; readonly sourceArtifactId?: string; readonly reason?: string }

/** The inspectable provenance of a Feature/Testing replay run, derived from its artifacts. */
export async function replayReport(store: RunStore) {
  const contract = await readReplayContract(store);
  if (contract === null) return null;
  const artifacts = await store.listArtifacts();
  const records = await Promise.all(artifacts.filter(({ kind }) => kind.startsWith("replay-activity-")).map(({ ref }) => store.artifacts.get<ReplayActivityRecord>(ref)));
  const byActivity = (items: readonly ReplayActivityRecord[]) => items.map(({ activityId, sourceArtifactId, reason }) => ({ activityId, ...(sourceArtifactId === undefined ? {} : { sourceArtifactId }), ...(reason === undefined ? {} : { reason }) })).sort((a, b) => a.activityId.localeCompare(b.activityId));
  return {
    sourceRunId: contract.sourceRunId, mode: contract.mode, execution: contract.execution, requirements: contract.requirements,
    stages: contract.stages.map(({ stage, decision, reasons }) => {
      const own = records.filter((record) => record.stage === stage);
      return { stage, decision, reasons, reused: byActivity(own.filter(({ decision: outcome }) => outcome === "reused")), regenerated: byActivity(own.filter(({ decision: outcome }) => outcome === "regenerated")) };
    }),
    unassigned: byActivity(records.filter(({ stage }) => stage === null)),
  };
}

function digest(value: unknown): string { return createHash("sha256").update(canonicalJson(value ?? null)).digest("hex"); }
