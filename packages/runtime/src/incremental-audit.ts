import { createHash } from "node:crypto";
import { posix } from "node:path";
import { canonicalJson } from "@arbitra/core/config/config-store.js";
import { expandImpactedSurfaces, type ImpactedModule, type ImpactedSurfaceReport } from "@arbitra/core/preflight/impacted-surfaces.js";
import { approximateModules, resolvedImports } from "@arbitra/core/preflight/modules.js";
import { rankHotspots } from "@arbitra/core/preflight/hotspots.js";
import { CANONICAL_HARNESS_PROFILE } from "@arbitra/harness/profile.js";
import type { PinnedProtocol } from "@arbitra/protocols/registry.js";
import { runConfigSchema, type RunConfig } from "@arbitra/schemas/config.js";
import type { SourceFinding } from "@arbitra/schemas/finding.js";
import type { WorkflowGraphReference } from "@arbitra/schemas/workflow-graphs.js";
import { incrementalAuditSchema, type IncrementalAuditRequest } from "@arbitra/schemas/incremental.js";
import { providerExecutionSchema } from "@arbitra/schemas/provider-execution.js";
import { RepositoryPathGuard } from "@arbitra/security/path-guard";
import type { ActivityReplaySource } from "./model-activities.js";
import { readReplayableOutput, type ProtocolPin } from "./replay-contracts.js";
import type { RepositoryGit, RepositorySnapshot } from "./repository.js";
import type { RunStore, StoredRunContext } from "./run-store.js";

/*
 * Incremental and repeat Audit runs (P14).
 *
 * An incremental run is an ordinary new Audit run that names a completed base run. Before
 * it dispatches a discovery unit (one auditor over one scope or line window) it compares
 * the unit's complete input identity with the identity the base recorded for the same
 * unit. Only a byte-identical unit may reuse the base's saved model outputs, and then only
 * outputs whose per-activity replay identity is also unchanged. Everything else, and
 * everything uncertain, is fresh work. The base run is only ever read.
 */

export const SNAPSHOT_IDENTITY_KIND = "snapshot-identity";
export const INCREMENTAL_CONTRACT_KIND = "incremental-contract";
const UNIT_RECORD_PREFIX = "discovery-unit-";
const UNIT_DECISION_PREFIX = "incremental-unit-";
const UNIT_RESULT_PREFIX = "incremental-unit-result-";
const ACTIVITY_RECORD_PREFIX = "incremental-activity-";

/** Build and dependency manifests. A manifest in any ancestor directory of a unit file is part of that unit's identity. */
export const MANIFEST_FILE_NAMES: readonly string[] = Object.freeze([
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "yarn.lock", "bun.lockb",
  "tsconfig.json", "jsconfig.json", "deno.json", "pyproject.toml", "requirements.txt", "setup.cfg", "setup.py", "Pipfile", "Pipfile.lock", "poetry.lock",
  "go.mod", "go.sum", "Cargo.toml", "Cargo.lock", "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "Gemfile", "Gemfile.lock",
  "composer.json", "composer.lock", "Package.swift", "Package.resolved", "mix.exs", "mix.lock",
]);
const UNREADABLE = "unreadable";

/** The durable identity of one run's source snapshot, recorded before any stage runs. */
export interface SnapshotIdentity {
  readonly schemaVersion: 1;
  readonly repositoryDigest: string;
  readonly gitHead: string | null;
  /** SHA-256 of each snapshot file's exact bytes. */
  readonly files: Readonly<Record<string, string>>;
  /** SHA-256 of each manifest in an ancestor directory of a snapshot file, or `unreadable`. */
  readonly manifests: Readonly<Record<string, string>>;
}

export async function captureSnapshotIdentity(snapshot: RepositorySnapshot, repositoryDigest: string, git: RepositoryGit): Promise<SnapshotIdentity> {
  const guard = await RepositoryPathGuard.create(snapshot.root);
  const directories = new Set<string>([""]);
  for (const { path } of snapshot.files) for (let directory = posix.dirname(path); directory !== "." && directory !== ""; directory = posix.dirname(directory)) directories.add(directory);
  const manifests: Record<string, string> = {};
  for (const directory of [...directories].sort()) for (const name of MANIFEST_FILE_NAMES) {
    const path = directory === "" ? name : `${directory}/${name}`;
    try { manifests[path] = sha256(await guard.readBytes(path)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") continue;
      // Present but unreadable (for example a symlink leaving the repository): its bytes
      // cannot be compared, so no unit depending on it can be reused.
      manifests[path] = UNREADABLE;
    }
  }
  let gitHead: string | null = null;
  try { gitHead = (await git.run(snapshot.root, ["rev-parse", "--verify", "HEAD^{commit}"])).trim() || null; } catch { gitHead = null; }
  return Object.freeze({ schemaVersion: 1, repositoryDigest, gitHead, files: Object.freeze(Object.fromEntries(snapshot.files.map((file) => [file.path, fileHash(file.lines)]))), manifests: Object.freeze(manifests) });
}

/** One discovery activity: an auditor over one scope, or one exact line window of a file. */
export interface DiscoveryUnit {
  readonly auditorId: string;
  readonly scopeId: string | null;
  readonly activityId: string;
  readonly paths: readonly string[];
  readonly window?: { readonly startLine: number; readonly endLine: number };
  readonly protocol?: PinnedProtocol;
  readonly maximumInputTokens?: number;
  readonly effort?: string;
}

/** Receives each discovery unit before its model call and after its findings are validated. */
export interface DiscoveryUnitHooks {
  begin(unit: DiscoveryUnit): Promise<void>;
  complete(unit: DiscoveryUnit, accepted: readonly SourceFinding[]): Promise<void>;
}

export function unitKey(unit: { readonly auditorId: string; readonly scopeId: string | null }): string { return `${unit.auditorId}-${unit.scopeId ?? "whole"}`; }

/** Every input a discovery unit depended on, per component, so a decision can name what changed. */
export interface UnitIdentity {
  /** The unit's inspection footprint: the exact bytes of every file it was given or could read. */
  readonly files: Readonly<Record<string, string>>;
  /** Transitive repository-internal imports of those files that lie outside the unit. */
  readonly imports: Readonly<Record<string, string>>;
  readonly manifests: Readonly<Record<string, string>>;
  readonly scope: string;
  readonly protocol: string;
  readonly model: string;
  readonly harness: string;
  readonly policy: string;
  readonly identity: string;
}

export interface UnitEnvironment {
  readonly snapshot: SnapshotIdentity;
  readonly imports: ReadonlyMap<string, readonly string[]>;
  readonly config: RunConfig;
}

export function unitEnvironment(snapshot: RepositorySnapshot, identity: SnapshotIdentity, config: RunConfig): UnitEnvironment {
  return { snapshot: identity, config, imports: resolvedImports(snapshot.files.map(({ path, lines }) => ({ path, content: lines.join("\n") }))) };
}

export function discoveryUnitIdentity(unit: DiscoveryUnit, environment: UnitEnvironment): UnitIdentity {
  const { snapshot, config } = environment;
  const own = new Set(unit.paths);
  const files = Object.fromEntries([...unit.paths].sort().map((path) => [path, snapshot.files[path] ?? "absent"]));
  const closure = new Set<string>(); const pending = [...unit.paths];
  while (pending.length > 0) {
    const path = pending.pop() as string;
    for (const target of environment.imports.get(path) ?? []) if (!own.has(target) && !closure.has(target)) { closure.add(target); pending.push(target); }
  }
  const imports = Object.fromEntries([...closure].sort().map((path) => [path, snapshot.files[path] ?? "absent"]));
  const ancestors = new Set<string>([""]);
  for (const path of unit.paths) for (let directory = posix.dirname(path); directory !== "." && directory !== ""; directory = posix.dirname(directory)) ancestors.add(directory);
  const manifests = Object.fromEntries(Object.entries(snapshot.manifests).filter(([path]) => ancestors.has(posix.dirname(path) === "." ? "" : posix.dirname(path))).sort(([a], [b]) => a.localeCompare(b)));
  const execution = providerExecutionSchema.parse(config.workflow["modelExecution"]);
  const endpointId = execution.modelEndpoints[unit.auditorId];
  const protocolId = unit.protocol?.protocolId ?? "production-audit";
  const components = {
    files, imports, manifests,
    scope: digest({ scope: config.scope, window: unit.window ?? null, paths: [...unit.paths].sort() }),
    protocol: digest({ protocol: unit.protocol === undefined ? null : { id: unit.protocol.protocolId, version: unit.protocol.protocolVersion, hash: unit.protocol.protocolHash }, override: config.promptOverrides[protocolId] ?? null }),
    model: digest({ modelProfileId: unit.auditorId, profile: config.models[unit.auditorId] ?? null, endpoint: execution.endpoints.find(({ id }) => id === endpointId) ?? null, maximumOutputTokens: execution.maximumOutputTokens }),
    harness: digest({ harness: config.harness, profile: CANONICAL_HARNESS_PROFILE }),
    policy: digest({ auditDepth: config.auditDepth, effort: unit.effort ?? null, maximumInputTokens: unit.maximumInputTokens ?? null, security: config.security, contextPolicies: config.contextPolicies }),
  };
  return Object.freeze({ ...components, identity: digest(components) });
}

export interface CitedRange { readonly sourceFindingId: string; readonly path: string; readonly startLine: number; readonly endLine: number; readonly sha256: string; readonly text: string }

/** What a run records about each discovery unit it completed, so a later run can compare. */
export interface DiscoveryUnitRecord {
  readonly schemaVersion: 1;
  readonly unitKey: string;
  readonly auditorId: string;
  readonly scopeId: string | null;
  readonly activityId: string;
  readonly paths: readonly string[];
  readonly window: { readonly startLine: number; readonly endLine: number } | null;
  readonly identity: UnitIdentity;
  readonly citedRanges: readonly CitedRange[];
  /** The harness inspection footprint: files the model read through tools, and search scopes. */
  readonly inspection: { readonly recorded: boolean; readonly readPaths: readonly string[]; readonly searchScopes: readonly string[] };
  readonly findingsKind: string;
  readonly sourceFindingIds: readonly string[];
}

export type UnitDecision = { readonly decision: "reuse" | "regenerate"; readonly reasons: readonly string[] };

/**
 * Compare a unit's current identity with the base's record of the same unit. Unknown never
 * means equal: a missing record or footprint is a reason to regenerate.
 */
export function decideUnit(current: UnitIdentity, base: DiscoveryUnitRecord | null, context: { readonly baseHasUnitRecords: boolean; readonly files: ReadonlyMap<string, readonly string[]>; readonly imports: ReadonlyMap<string, readonly string[]> }): UnitDecision {
  if (base === null) return { decision: "regenerate", reasons: [context.baseHasUnitRecords ? "base_unit_absent" : "base_unit_identity_unavailable"] };
  const reasons: string[] = [];
  if (!base.inspection.recorded) reasons.push("base_footprint_unavailable");
  for (const path of base.inspection.readPaths) if (!base.paths.includes(path)) reasons.push(`footprint_outside_unit:${path}`);
  const importTargets = new Set(Object.keys(current.files).flatMap((path) => [...context.imports.get(path) ?? []]));
  for (const path of changedKeys(base.identity.files, current.files)) {
    reasons.push(`changed:footprint:${path}`);
    if (importTargets.has(path)) reasons.push(`changed:imports:${path}`);
  }
  for (const range of base.citedRanges) {
    const lines = context.files.get(range.path);
    if (lines === undefined || range.endLine > lines.length || fileHash(lines.slice(range.startLine - 1, range.endLine)) !== range.sha256) reasons.push(`changed:cited_lines:${range.path}:${range.startLine}-${range.endLine}`);
  }
  for (const path of changedKeys(base.identity.imports, current.imports)) reasons.push(`changed:imports:${path}`);
  for (const path of changedKeys(base.identity.manifests, current.manifests)) reasons.push(`changed:manifests:${path}`);
  for (const [path, hash] of Object.entries(current.manifests)) if (hash === UNREADABLE) reasons.push(`manifest_unverifiable:${path}`);
  for (const component of ["scope", "protocol", "model", "harness", "policy"] as const) if (base.identity[component] !== current[component]) reasons.push(`changed:${component}`);
  const unique = [...new Set(reasons)];
  return { decision: unique.length === 0 ? "reuse" : "regenerate", reasons: unique };
}

/** Downstream stages recomputed over the union of reused and fresh findings unless their whole input identity matches. */
export const INCREMENTAL_AUDIT_STAGES: readonly { readonly stage: string; readonly prefixes: readonly string[]; readonly protocols: readonly string[] }[] = Object.freeze([
  { stage: "clustering", prefixes: ["semantic-clustering"], protocols: ["semantic-clustering"] },
  { stage: "peer-review", prefixes: ["peer-review", "peer-conflict"], protocols: ["peer-review", "peer-conflict-resolution"] },
  { stage: "verification", prefixes: ["verification"], protocols: ["targeted-verification"] },
  { stage: "planning", prefixes: ["planner", "critic"], protocols: ["planner", "plan-critic"] },
]);

export interface IncrementalStageDecision { readonly stage: string; readonly decision: "reuse" | "regenerate"; readonly reasons: readonly string[]; readonly identity: string; readonly baseIdentity: string | null }

interface StageInputs { readonly config: RunConfig; readonly repositoryDigest: string; readonly manifests: Readonly<Record<string, string>> | null; readonly criticEnabled: boolean; readonly pin: (id: string) => Promise<ProtocolPin | null> }

async function auditStageIdentities(inputs: StageInputs): Promise<readonly { stage: string; identity: string; components: Record<string, string> }[]> {
  const { config } = inputs;
  const execution = providerExecutionSchema.parse(config.workflow["modelExecution"]);
  const result: { stage: string; identity: string; components: Record<string, string> }[] = [];
  let upstream: string | null = null;
  for (const definition of INCREMENTAL_AUDIT_STAGES) {
    const pins: Record<string, ProtocolPin | null> = {};
    for (const id of definition.protocols) pins[id] = await inputs.pin(id);
    const components: Record<string, string> = {
      repository: digest(inputs.repositoryDigest),
      manifests: digest(inputs.manifests),
      scope: digest(config.scope),
      harness: digest({ harness: config.harness, profile: CANONICAL_HARNESS_PROFILE }),
      models: digest({ models: config.models, endpoints: execution.endpoints, modelEndpoints: execution.modelEndpoints, roles: execution.roles ?? null, maximumOutputTokens: execution.maximumOutputTokens }),
      protocols: digest({ pins, overrides: definition.protocols.map((id) => config.promptOverrides[id] ?? null) }),
      policy: digest({ consensusPolicy: config.consensusPolicy, maxConsensusRounds: config.maxConsensusRounds, verification: config.verification, auditDepth: config.auditDepth, security: config.security, contextPolicies: config.contextPolicies, criticEnabled: inputs.criticEnabled,
        maximumClusteringPairs: execution.maximumClusteringPairs ?? null, maximumContextTokens: execution.maximumContextTokens ?? null, maximumDiscoveryTokens: execution.maximumDiscoveryTokens ?? null, preset: config.workflow["preset"] ?? null }),
      upstream: digest(upstream),
    };
    const identity = digest({ stage: definition.stage, components });
    result.push({ stage: definition.stage, identity, components });
    upstream = identity;
  }
  return result;
}

export interface LineageEntry {
  readonly sourceFindingId: string;
  readonly auditorId: string;
  /** Exact-content re-anchoring only; nothing is matched approximately. */
  readonly status: "unchanged" | "moved" | "absent" | "ambiguous" | "unverifiable";
  readonly locations: readonly { readonly path: string; readonly startLine: number; readonly endLine: number; readonly status: LineageEntry["status"]; readonly to?: { readonly path: string; readonly startLine: number; readonly endLine: number } }[];
}

/** The immutable decision record an incremental run is created with, and resumed from. */
export interface IncrementalContract {
  readonly schemaVersion: 1;
  readonly baseRunId: string;
  readonly baseState: string;
  readonly graph?: ExecutedGraphIdentity;
  readonly baseGraph?: ExecutedGraphIdentity | null;
  readonly strategy: "incremental" | "full_fallback";
  readonly fallbackReasons: readonly string[];
  readonly baseRepositoryDigest: string;
  readonly repositoryDigest: string;
  readonly baseGitHead: string | null;
  readonly gitHead: string | null;
  readonly changedPaths: { readonly added: readonly string[]; readonly removed: readonly string[]; readonly modified: readonly string[] };
  readonly changedManifests: { readonly added: readonly string[]; readonly removed: readonly string[]; readonly modified: readonly string[] };
  /** Paths Git reports changed between the base commit and the working tree; informational, never authoritative. */
  readonly gitChangedPaths: readonly string[] | null;
  readonly affectedSurfaces: ImpactedSurfaceReport;
  readonly hotspots: readonly { readonly path: string; readonly rank: number; readonly score: number }[] | null;
  readonly stages: readonly IncrementalStageDecision[];
  /**
   * Peer-review views are shuffled by a per-run seed. When the peer-review stage identity
   * matches the base, the base's seed is kept so identical views, and their saved reviews,
   * can be reused. Null means this run's own seed.
   */
  readonly peerReviewSeed?: string | null;
  readonly baseFindingLineage: readonly LineageEntry[] | null;
}

export function incrementalRequestOf(config: RunConfig): IncrementalAuditRequest | undefined {
  const value = config.workflow["incremental"];
  return value === undefined ? undefined : incrementalAuditSchema.parse(value);
}

/** The same overlay for the CLI flag and the HTTP body: the request becomes part of the run's stored configuration. */
export function withIncrementalBase(config: RunConfig, request: unknown): RunConfig {
  if (request === undefined) return config;
  const parsed = incrementalAuditSchema.safeParse(request);
  if (!parsed.success) throw Object.assign(new Error(`INVALID_INCREMENTAL_REQUEST:${parsed.error.issues.map(({ path, message }) => `${path.join(".") || "$"}: ${message}`).join("; ")}`), { statusCode: 400 });
  return runConfigSchema.parse({ ...config, workflow: { ...config.workflow, incremental: parsed.data } });
}

export interface ExecutedGraphIdentity { readonly reference: WorkflowGraphReference | null; readonly version: string }

export interface IncrementalPlanInput {
  readonly base: RunStore;
  readonly baseState: string;
  readonly baseContext: StoredRunContext;
  readonly repository: string;
  readonly config: RunConfig;
  readonly criticEnabled: boolean;
  readonly snapshot: RepositorySnapshot;
  readonly identity: SnapshotIdentity;
  readonly git: RepositoryGit;
  /** The graph this run executes: its saved-graph reference (null for a preset) and content version. */
  readonly graph: ExecutedGraphIdentity;
  /** The graph the base executed, or null when its stored definition is unavailable. */
  readonly baseGraph: ExecutedGraphIdentity | null;
  readonly targetPin: (id: string) => Promise<ProtocolPin>;
  readonly basePin: (id: string) => Promise<ProtocolPin | null>;
}

/** Decide, before the run exists, whether safe reuse can be established at all, and for which downstream stages. */
export async function planIncrementalAudit(input: IncrementalPlanInput): Promise<IncrementalContract> {
  const { base, baseContext, identity } = input;
  const baseConfig = baseContext.modelConfiguration;
  if (baseConfig === undefined) throw new Error("INCREMENTAL_BASE_CONFIGURATION_ABSENT");
  const fallbackReasons: string[] = [];
  if (input.baseState !== "COMPLETED") fallbackReasons.push(`base_run_not_completed:${input.baseState}`);
  if (baseContext.repository !== input.repository) fallbackReasons.push("base_repository_differs");
  if (input.baseGraph === null) fallbackReasons.push("base_workflow_graph_unavailable");
  else if (canonicalJson(input.baseGraph) !== canonicalJson(input.graph)) fallbackReasons.push("workflow_graph_changed");
  const baseIdentity = await readKind<SnapshotIdentity>(base, SNAPSHOT_IDENTITY_KIND);
  if (baseIdentity === null) fallbackReasons.push("base_snapshot_identity_unavailable");
  else if (baseIdentity.repositoryDigest !== baseContext.repositoryDigest) fallbackReasons.push("base_snapshot_identity_inconsistent");
  if (baseIdentity?.gitHead != null) {
    if (identity.gitHead === null) fallbackReasons.push("git_identity_unavailable");
    else if (baseIdentity.gitHead !== identity.gitHead) {
      // A base commit that is no longer an ancestor means history was rewritten; reuse is not established.
      try { await input.git.run(input.snapshot.root, ["merge-base", "--is-ancestor", baseIdentity.gitHead, identity.gitHead]); }
      catch { fallbackReasons.push("git_history_rewritten"); }
    }
  }
  const changedPaths = keyChanges(baseIdentity?.files ?? {}, identity.files);
  const changedManifests = keyChanges(baseIdentity?.manifests ?? {}, identity.manifests);
  let gitChangedPaths: string[] | null = null;
  if (baseIdentity?.gitHead != null && identity.gitHead !== null && !fallbackReasons.includes("git_history_rewritten")) {
    try { gitChangedPaths = (await input.git.run(input.snapshot.root, ["diff", "--name-only", "-z", baseIdentity.gitHead, "--"])).split("\0").filter((path) => path !== "").sort(); } catch { gitChangedPaths = null; }
  }
  const changed = [...changedPaths.added, ...changedPaths.removed, ...changedPaths.modified, ...changedManifests.added, ...changedManifests.removed, ...changedManifests.modified];
  const affectedSurfaces = expandImpactedSurfaces(changed, impactedModules(input.snapshot, identity));
  let hotspots: { path: string; rank: number; score: number }[] | null = null;
  if (identity.gitHead !== null) {
    try {
      const log = await input.git.run(input.snapshot.root, ["log", "-n", "500", "--no-renames", "--format=%x1e%H%x1f%an%x1f%aI%x1f%s%x1f", "--name-only"]);
      const changedSet = new Set(changed);
      hotspots = rankHotspots(log).filter(({ path }) => changedSet.has(path)).map(({ path, rank, score }) => ({ path, rank, score }));
    } catch { hotspots = null; }
  }
  const target = await auditStageIdentities({ config: input.config, repositoryDigest: identity.repositoryDigest, manifests: identity.manifests, criticEnabled: input.criticEnabled, pin: input.targetPin });
  const prior = await auditStageIdentities({ config: baseConfig, repositoryDigest: baseContext.repositoryDigest, manifests: baseIdentity?.manifests ?? null, criticEnabled: baseContext.criticEnabled, pin: input.basePin });
  const stages = target.map((stage): IncrementalStageDecision => {
    const before = prior.find((item) => item.stage === stage.stage);
    const reasons = fallbackReasons.length > 0 ? ["full_audit_fallback"] : Object.entries(stage.components).filter(([name, value]) => before?.components[name] !== value).map(([name]) => `changed:${name}`);
    return Object.freeze({ stage: stage.stage, decision: reasons.length === 0 ? "reuse" : "regenerate", reasons: Object.freeze(reasons), identity: stage.identity, baseIdentity: before?.identity ?? null });
  });
  const records = await baseUnitRecords(base);
  const lineage = records.length === 0 ? null : findingLineage(records, input.snapshot);
  const baseContract = await readKind<IncrementalContract>(base, INCREMENTAL_CONTRACT_KIND);
  const peerReviewSeed = stages.find(({ stage }) => stage === "peer-review")?.decision === "reuse" ? baseContract?.peerReviewSeed ?? base.runId : null;
  return Object.freeze({ schemaVersion: 1, peerReviewSeed, graph: input.graph, baseGraph: input.baseGraph, baseRunId: base.runId, baseState: input.baseState, strategy: fallbackReasons.length === 0 ? "incremental" : "full_fallback", fallbackReasons: Object.freeze(fallbackReasons),
    baseRepositoryDigest: baseContext.repositoryDigest, repositoryDigest: identity.repositoryDigest, baseGitHead: baseIdentity?.gitHead ?? null, gitHead: identity.gitHead,
    changedPaths, changedManifests, gitChangedPaths, affectedSurfaces, hotspots, stages: Object.freeze(stages), baseFindingLineage: lineage });
}

function impactedModules(snapshot: RepositorySnapshot, identity: SnapshotIdentity): readonly ImpactedModule[] {
  const files = snapshot.files.map(({ path, lines }) => ({ path, content: lines.join("\n") }));
  const imports = resolvedImports(files);
  const modules = approximateModules(files);
  const grouped = new Set(modules.flatMap(({ files: paths }) => paths));
  const all = [...modules.map(({ id, files: paths }) => ({ id, files: paths })), ...snapshot.files.filter(({ path }) => !grouped.has(path)).map(({ path }) => ({ id: path, files: [path] }))];
  return all.map(({ id, files: paths }) => ({ id, files: paths, relations: [
    ...paths.flatMap((from) => (imports.get(from) ?? []).map((to) => ({ from, to, kind: "import" as const }))),
    ...Object.keys(identity.manifests).flatMap((manifest) => {
      const directory = posix.dirname(manifest) === "." ? "" : posix.dirname(manifest);
      return paths.filter((path) => directory === "" || path.startsWith(`${directory}/`)).map((to) => ({ from: manifest, to, kind: "manifest" as const }));
    }),
  ] }));
}

/** Where each base finding's cited lines are now, by exact content only. */
export function findingLineage(records: readonly DiscoveryUnitRecord[], snapshot: RepositorySnapshot): readonly LineageEntry[] {
  const files = new Map(snapshot.files.map(({ path, lines }) => [path, lines]));
  const byFinding = new Map<string, { auditorId: string; ranges: CitedRange[] }>();
  for (const record of records) for (const range of record.citedRanges) {
    const entry = byFinding.get(range.sourceFindingId) ?? { auditorId: record.auditorId, ranges: [] };
    entry.ranges.push(range); byFinding.set(range.sourceFindingId, entry);
  }
  const order: LineageEntry["status"][] = ["unverifiable", "absent", "ambiguous", "moved", "unchanged"];
  return [...byFinding.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([sourceFindingId, { auditorId, ranges }]) => {
    const locations = ranges.map((range) => {
      const same = files.get(range.path);
      if (same !== undefined && range.endLine <= same.length && fileHash(same.slice(range.startLine - 1, range.endLine)) === range.sha256) return { path: range.path, startLine: range.startLine, endLine: range.endLine, status: "unchanged" as const };
      // Stored text may have been redacted; then its hash no longer proves the content.
      const wanted = range.text.split("\n");
      if (fileHash(wanted) !== range.sha256) return { path: range.path, startLine: range.startLine, endLine: range.endLine, status: "unverifiable" as const };
      const matches: { path: string; startLine: number; endLine: number }[] = [];
      for (const [path, lines] of files) for (let start = 0; start + wanted.length <= lines.length && matches.length < 2; start += 1) {
        if (wanted.every((line, offset) => lines[start + offset] === line)) matches.push({ path, startLine: start + 1, endLine: start + wanted.length });
      }
      const [first] = matches;
      if (matches.length === 1 && first !== undefined) return { path: range.path, startLine: range.startLine, endLine: range.endLine, status: "moved" as const, to: first };
      return { path: range.path, startLine: range.startLine, endLine: range.endLine, status: matches.length === 0 ? "absent" as const : "ambiguous" as const };
    });
    const status = order.find((candidate) => locations.some((location) => location.status === candidate)) ?? "unchanged";
    return Object.freeze({ sourceFindingId, auditorId, status, locations: Object.freeze(locations) });
  });
}

interface UnitDecisionRecord {
  readonly unitKey: string; readonly auditorId: string; readonly scopeId: string | null; readonly activityId: string; readonly paths: readonly string[];
  readonly baseRunId: string; readonly decision: "reuse" | "regenerate"; readonly reasons: readonly string[];
  readonly reusedFrom: { readonly runId: string; readonly unitArtifactId: string; readonly findingsArtifactId: string | null } | null;
}

interface ActivityRecord {
  readonly activityId: string; readonly unitKey: string | null; readonly stage: string | null; readonly baseRunId: string;
  readonly decision: "reused" | "regenerated"; readonly reason?: string; readonly sourceArtifactId?: string;
  readonly savedUsage?: { readonly inputTokens: number | null; readonly outputTokens: number | null } | null;
}

/**
 * Serves base outputs to an incremental run. Discovery outputs are served only for a unit
 * whose recorded decision is `reuse`, and only to that same unit's activities, so a fresh
 * auditor never sees another auditor's (or the base's) findings in round zero.
 */
export class IncrementalSeed implements ActivityReplaySource {
  readonly #units = new Map<string, UnitDecisionRecord>();
  constructor(readonly base: RunStore, private readonly target: RunStore, readonly contract: IncrementalContract) {
    if (base.runId !== contract.baseRunId || target.runId === base.runId) throw new Error("INCREMENTAL_SEED_RUN_MISMATCH");
  }

  setUnitDecision(record: UnitDecisionRecord): void { this.#units.set(record.activityId, record); }

  async lookup(request: { readonly activityId: string; readonly key: string; readonly replayIdentity: string }) {
    const unitActivity = discoveryUnitActivity(request.activityId);
    const unit = unitActivity === null ? undefined : this.#units.get(unitActivity);
    const stage = unitActivity === null ? INCREMENTAL_AUDIT_STAGES.find(({ prefixes }) => prefixes.some((prefix) => request.activityId === prefix || request.activityId.startsWith(`${prefix}/`)))?.stage ?? null : null;
    const scope = { unitKey: unit?.unitKey ?? null, stage };
    const miss = async (reason: string) => { await this.#record(request, scope, { decision: "regenerated", reason }); return null; };
    if (unitActivity !== null) {
      if (unit === undefined) return miss("unit_decision_absent");
      if (unit.decision !== "reuse") return miss("unit_invalidated");
    } else {
      if (stage === null) return miss("activity_outside_incremental_contract");
      if (this.contract.stages.find((item) => item.stage === stage)?.decision !== "reuse") return miss("stage_invalidated");
    }
    const saved = await readReplayableOutput(this.base, request.key, request.replayIdentity);
    if ("reason" in saved) return miss(saved.reason);
    const trace = await readKind<{ terminal?: { tokenUsage?: { inputTokens?: number | null; outputTokens?: number | null } | null } }>(this.base, `${request.key}-trace`);
    const usage = trace?.terminal?.tokenUsage;
    await this.#record(request, scope, { decision: "reused", sourceArtifactId: saved.sourceArtifactId, savedUsage: usage == null ? null : { inputTokens: usage.inputTokens ?? null, outputTokens: usage.outputTokens ?? null } });
    return { value: saved.value, sourceRunId: this.base.runId, sourceArtifactId: saved.sourceArtifactId };
  }

  async reject(request: { readonly activityId: string; readonly key: string }, reason: string): Promise<void> {
    const unitActivity = discoveryUnitActivity(request.activityId);
    await this.#record(request, { unitKey: unitActivity === null ? null : this.#units.get(unitActivity)?.unitKey ?? null, stage: null }, { decision: "regenerated", reason });
  }

  async #record(request: { readonly activityId: string; readonly key: string }, scope: { unitKey: string | null; stage: string | null }, outcome: Pick<ActivityRecord, "decision" | "reason" | "sourceArtifactId" | "savedUsage">): Promise<void> {
    const record: ActivityRecord = { activityId: request.activityId, ...scope, baseRunId: this.base.runId, ...outcome };
    await this.target.publish(`${ACTIVITY_RECORD_PREFIX}${request.key}`, record, request.activityId);
  }
}

/** `<auditor>[/<scope>]/discovery` for a discovery activity or one of its harness turns. */
export function discoveryUnitActivity(activityId: string): string | null {
  const unit = activityId.replace(/\/turn-(0|[1-9][0-9]*)$/u, "");
  return unit.endsWith("/discovery") ? unit : null;
}

/**
 * Records every discovery unit's identity (so any completed run can serve as a base) and,
 * in an incremental run, decides and records each unit's reuse before it dispatches.
 */
export class DiscoveryUnits implements DiscoveryUnitHooks {
  readonly #environment: UnitEnvironment;
  readonly #files: ReadonlyMap<string, readonly string[]>;
  readonly #identities = new Map<string, UnitIdentity>();
  readonly #decisions = new Map<string, UnitDecisionRecord>();
  #baseRecords: Promise<readonly DiscoveryUnitRecord[]> | undefined;

  constructor(private readonly store: RunStore, config: RunConfig, snapshot: RepositorySnapshot, identity: SnapshotIdentity, private readonly seed?: IncrementalSeed) {
    this.#environment = unitEnvironment(snapshot, identity, config);
    this.#files = new Map(snapshot.files.map(({ path, lines }) => [path, lines]));
  }

  async begin(unit: DiscoveryUnit): Promise<void> {
    const current = discoveryUnitIdentity(unit, this.#environment);
    this.#identities.set(unit.activityId, current);
    const seed = this.seed;
    if (seed === undefined) return;
    const kind = `${UNIT_DECISION_PREFIX}${unitKey(unit)}`;
    // A resumed run keeps the decision it recorded; it never re-decides against the base.
    const existing = await readKind<UnitDecisionRecord>(this.store, kind);
    if (existing !== null) { this.#decisions.set(unit.activityId, existing); seed.setUnitDecision(existing); return; }
    let decision: UnitDecision;
    let reusedFrom: UnitDecisionRecord["reusedFrom"] = null;
    if (seed.contract.strategy === "full_fallback") decision = { decision: "regenerate", reasons: ["full_audit_fallback", ...seed.contract.fallbackReasons] };
    else {
      this.#baseRecords ??= baseUnitRecords(seed.base);
      const records = await this.#baseRecords;
      const base = records.find((record) => record.unitKey === unitKey(unit) && record.activityId === unit.activityId) ?? null;
      decision = decideUnit(current, base, { baseHasUnitRecords: records.length > 0, files: this.#files, imports: this.#environment.imports });
      if (decision.decision === "reuse" && base !== null) {
        const artifacts = await seed.base.listArtifacts();
        const unitArtifact = artifacts.find(({ kind: item }) => item === `${UNIT_RECORD_PREFIX}${base.unitKey}`);
        const findings = artifacts.find(({ kind: item }) => item === base.findingsKind);
        if (unitArtifact === undefined) decision = { decision: "regenerate", reasons: ["base_unit_identity_unavailable"] };
        else reusedFrom = { runId: seed.base.runId, unitArtifactId: unitArtifact.artifactId, findingsArtifactId: findings?.artifactId ?? null };
      }
    }
    const record: UnitDecisionRecord = { unitKey: unitKey(unit), auditorId: unit.auditorId, scopeId: unit.scopeId, activityId: unit.activityId, paths: [...unit.paths], baseRunId: seed.base.runId, ...decision, reusedFrom };
    await this.store.publish(kind, record, unit.auditorId);
    this.#decisions.set(unit.activityId, record);
    seed.setUnitDecision(record);
  }

  async complete(unit: DiscoveryUnit, accepted: readonly SourceFinding[]): Promise<void> {
    const identity = this.#identities.get(unit.activityId) ?? discoveryUnitIdentity(unit, this.#environment);
    const citedRanges = new Map<string, CitedRange>();
    for (const finding of accepted) for (const location of finding.locations) {
      const lines = this.#files.get(location.path);
      if (lines === undefined) continue;
      const cited = lines.slice(location.startLine - 1, location.endLine);
      const range = { sourceFindingId: finding.sourceFindingId, path: location.path, startLine: location.startLine, endLine: location.endLine, sha256: fileHash(cited), text: cited.join("\n") };
      citedRanges.set(canonicalJson([range.sourceFindingId, range.path, range.startLine, range.endLine]), range);
    }
    const harness = await readKind<{ inspection?: { reads?: readonly { path: string }[]; searches?: readonly { scope: string }[] } }>(this.store, `harness-${createHash("sha256").update(unit.activityId).digest("hex")}`);
    const inspection = harness?.inspection === undefined ? { recorded: false, readPaths: [], searchScopes: [] }
      : { recorded: true, readPaths: [...new Set((harness.inspection.reads ?? []).map(({ path }) => path))].sort(), searchScopes: [...new Set((harness.inspection.searches ?? []).map(({ scope }) => scope))].sort() };
    const findingsKind = unit.scopeId === null ? `findings-${unit.auditorId}` : `findings-${unit.auditorId}-${unit.scopeId}`;
    const record: DiscoveryUnitRecord = { schemaVersion: 1, unitKey: unitKey(unit), auditorId: unit.auditorId, scopeId: unit.scopeId, activityId: unit.activityId, paths: [...unit.paths], window: unit.window ?? null, identity,
      citedRanges: [...citedRanges.values()], inspection, findingsKind, sourceFindingIds: accepted.map(({ sourceFindingId }) => sourceFindingId) };
    await this.store.publish(`${UNIT_RECORD_PREFIX}${unitKey(unit)}`, record, unit.auditorId);
    const decision = this.#decisions.get(unit.activityId);
    if (this.seed === undefined || decision === undefined) return;
    // Provenance of each finding a reused unit produced, and a consistency check against the base's own findings.
    let baseFindings: readonly SourceFinding[] | null = null;
    if (decision.reusedFrom?.findingsArtifactId != null) {
      try { baseFindings = JSON.parse((await this.seed.base.readArtifact(decision.reusedFrom.findingsArtifactId)).content) as readonly SourceFinding[]; } catch { baseFindings = null; }
    }
    const baseIds = new Set((baseFindings ?? []).map(({ sourceFindingId }) => sourceFindingId));
    await this.store.publish(`${UNIT_RESULT_PREFIX}${unitKey(unit)}`, {
      unitKey: unitKey(unit), decision: decision.decision,
      findings: accepted.map(({ sourceFindingId }) => ({ sourceFindingId, ...(decision.decision === "reuse" && baseIds.has(sourceFindingId) && decision.reusedFrom !== null ? { reusedFrom: { runId: decision.reusedFrom.runId, artifactId: decision.reusedFrom.findingsArtifactId } } : {}) })),
      findingsMatchBase: baseFindings === null ? null : canonicalJson(baseFindings) === canonicalJson(accepted),
    }, unit.auditorId);
  }
}

async function baseUnitRecords(base: RunStore): Promise<readonly DiscoveryUnitRecord[]> {
  const records: DiscoveryUnitRecord[] = [];
  for (const descriptor of (await base.listArtifacts()).filter(({ kind }) => kind.startsWith(UNIT_RECORD_PREFIX))) {
    try {
      const record = await base.artifacts.get<DiscoveryUnitRecord>(descriptor.ref);
      if (record.schemaVersion === 1 && `${UNIT_RECORD_PREFIX}${record.unitKey}` === descriptor.kind) records.push(record);
    } catch { /* An unreadable record is simply unavailable: its unit is regenerated. */ }
  }
  return records;
}

/** The inspectable reuse, saved work and coverage of an incremental run, derived from its artifacts. */
export async function incrementalReport(store: RunStore) {
  const contract = await readKind<IncrementalContract>(store, INCREMENTAL_CONTRACT_KIND);
  if (contract === null) return null;
  const artifacts = await store.listArtifacts();
  const read = async <T>(prefix: string): Promise<T[]> => Promise.all(artifacts.filter(({ kind }) => kind.startsWith(prefix)).map(({ ref }) => store.artifacts.get<T>(ref)));
  const decisions = (await read<UnitDecisionRecord>(UNIT_DECISION_PREFIX)).filter((record) => typeof record.activityId === "string" && Array.isArray(record.reasons));
  const records = await read<DiscoveryUnitRecord>(UNIT_RECORD_PREFIX);
  const activities = await read<ActivityRecord>(ACTIVITY_RECORD_PREFIX);
  const identity = await readKind<SnapshotIdentity>(store, SNAPSHOT_IDENTITY_KIND);
  const reused = activities.filter(({ decision }) => decision === "reused");
  const regenerated = activities.filter(({ decision }) => decision === "regenerated");
  const known = reused.filter(({ savedUsage }) => savedUsage != null && savedUsage.inputTokens !== null && savedUsage.outputTokens !== null);
  const byReason: Record<string, number> = {};
  for (const { reason } of regenerated) byReason[reason ?? "unknown"] = (byReason[reason ?? "unknown"] ?? 0) + 1;
  const snapshotPaths = Object.keys(identity?.files ?? {}).sort();
  const auditors = [...new Set(records.map(({ auditorId }) => auditorId))].sort();
  const coverage = await Promise.all(auditors.map(async (auditorId) => {
    const covered = new Set(records.filter((record) => record.auditorId === auditorId).flatMap(({ paths }) => paths));
    const validation = await readKind<{ truncated?: boolean; unexaminedDueToBudget?: readonly string[] }>(store, `discovery-validation-${auditorId}`);
    return { auditorId, uncoveredPaths: snapshotPaths.filter((path) => !covered.has(path)), truncated: validation?.truncated ?? null, unexaminedDueToBudget: validation?.unexaminedDueToBudget ?? null };
  }));
  const reusedUnitLimitations = (await Promise.all(decisions.filter(({ decision }) => decision === "reuse").map(async ({ unitKey: key, auditorId, scopeId }) => {
    const validation = await readKind<{ truncated?: boolean; unexaminedDueToBudget?: readonly string[]; limitations?: readonly string[] }>(store, scopeId === null ? `discovery-validation-${auditorId}` : `discovery-validation-${auditorId}-${scopeId}`);
    return validation !== null && (validation.truncated === true || (validation.unexaminedDueToBudget?.length ?? 0) > 0) ? [{ unitKey: key, truncated: validation.truncated === true, unexaminedDueToBudget: validation.unexaminedDueToBudget ?? [] }] : [];
  }))).flat();
  const unitsReused = decisions.filter(({ decision }) => decision === "reuse").length;
  return {
    baseRunId: contract.baseRunId, baseState: contract.baseState, strategy: contract.strategy, fallbackReasons: contract.fallbackReasons,
    changedPaths: contract.changedPaths, changedManifests: contract.changedManifests, gitChangedPaths: contract.gitChangedPaths, affectedSurfaces: contract.affectedSurfaces, hotspots: contract.hotspots,
    stages: contract.stages.map(({ stage, decision, reasons }) => ({ stage, decision, reasons,
      reusedActivities: reused.filter((record) => record.stage === stage).length, regeneratedActivities: regenerated.filter((record) => record.stage === stage).length })),
    units: decisions.map(({ unitKey: key, auditorId, scopeId, paths, decision, reasons, reusedFrom }) => ({ unitKey: key, auditorId, scopeId, paths, decision, reasons, reusedFrom })).sort((a, b) => a.unitKey.localeCompare(b.unitKey)),
    savedWork: {
      discoveryUnits: { total: decisions.length, reused: unitsReused, regenerated: decisions.length - unitsReused },
      modelCalls: { reused: reused.length, made: regenerated.length },
      // Usage the base provider did not report stays unknown rather than counted as zero.
      tokensSaved: { inputTokens: known.reduce((sum, { savedUsage }) => sum + (savedUsage?.inputTokens ?? 0), 0), outputTokens: known.reduce((sum, { savedUsage }) => sum + (savedUsage?.outputTokens ?? 0), 0), callsWithUnknownUsage: reused.length - known.length },
      regeneratedByReason: byReason,
    },
    coverage: {
      snapshotPaths: snapshotPaths.length,
      byAuditor: coverage,
      reusedUnitLimitations,
      // Units are allocated on the current snapshot exactly as a full run allocates them, so
      // coverage differs from a full run only where a path is uncovered or a reused unit carried a limitation.
      degradedVersusFullRun: coverage.some(({ uncoveredPaths }) => uncoveredPaths.length > 0) || reusedUnitLimitations.length > 0,
    },
    baseFindingLineage: contract.baseFindingLineage,
  };
}

async function readKind<T>(store: RunStore, kind: string): Promise<T | null> {
  const descriptor = (await store.listArtifacts()).find((item) => item.kind === kind);
  if (descriptor === undefined) return null;
  try { return await store.artifacts.get<T>(descriptor.ref); } catch { return null; }
}

export { readKind as readIncrementalArtifact };

function keyChanges(before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>) {
  return {
    added: Object.keys(after).filter((path) => !Object.hasOwn(before, path)).sort(),
    removed: Object.keys(before).filter((path) => !Object.hasOwn(after, path)).sort(),
    modified: Object.keys(after).filter((path) => Object.hasOwn(before, path) && before[path] !== after[path]).sort(),
  };
}

function changedKeys(before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>): readonly string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((path) => before[path] !== after[path]).sort();
}

function fileHash(lines: readonly string[]): string { return sha256(lines.join("\n")); }
function sha256(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function digest(value: unknown): string { return sha256(canonicalJson(value ?? null)); }
