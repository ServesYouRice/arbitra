import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ConfigStore } from "@arbitra/core/config/config-store.js";
import type { NodeExecutionContext, RunnerGraph, RunHandle } from "@arbitra/core/runner/workflow-runner.js";
import { WorkflowRunner } from "@arbitra/core/runner/workflow-runner.js";
import { diffRuns, type ComparableRun, type ReplayOverrides } from "@arbitra/core/replay/index.js";
import type { RunEvent, RunState } from "@arbitra/core/runner/events.js";
import { runConfigSchema, type RunConfig } from "@arbitra/schemas/config.js";
import { DEFAULT_AUDITORS, type AuditFinding } from "./auditors.js";
import type { CanonicalIssueSet } from "@arbitra/workflow/nodes/canonical-issues.js";
import { AUDIT_DEEP_GRAPH, auditorIdsFor, PRESET_GRAPHS, withCritic } from "./graphs.js";
import { assertNoPreflightErrors, configurationDiagnostics, environmentDiagnostics, graphForConfiguration, PreflightError, type ConfigurationPreflightOptions, type PreflightDiagnostic } from "./preflight.js";
import { DockerTestSandbox } from "./test-sandbox.js";
import { canonicalise, converge, critique, discover, plan, preflight, readStage, verify, type AuditContext, type ConvergenceResult, type Plan } from "./pipeline.js";
import { defaultGit, snapshotRepository, type RepositorySnapshot } from "./repository.js";
import { listRunIds, RunStore, type ArtifactDescriptor, type StoredRunContext } from "./run-store.js";
import { ModelAuditPipeline, validateModelAudit, type AuditUnitOptions } from "./model-pipeline.js";
import { captureSnapshotIdentity, INCREMENTAL_CONTRACT_KIND, incrementalReport, incrementalRequestOf, IncrementalSeed, planIncrementalAudit, readIncrementalArtifact, SNAPSHOT_IDENTITY_KIND, type IncrementalContract, type SnapshotIdentity } from "./incremental-audit.js";
import type { TestSandbox } from "./test-sandbox.js";
import type { TransportFactoryOptions } from "@arbitra/providers/registry.js";
import type { PlanIR } from "@arbitra/schemas/plan.js";
import { loadActivityTraces } from "@arbitra/persistence/trace.js";
import { indexedTraceEntry, indexedTracePage } from "./trace-browser.js";
import { evaluationMetrics } from "./evaluation-metrics.js";
import { FeaturePipeline, validateModelFeature, type FeatureOutcome } from "./feature-pipeline.js";
import { TestingPipeline, validateModelTesting, type TestingOutcome } from "./testing-pipeline.js";
import type { TestingPlanExecutionOutcome } from "./testing-plan-executor.js";
import { testingExecutionSchema } from "@arbitra/schemas/testing.js";
import { requirementsApprovalSchema } from "@arbitra/schemas/feature-execution.js";
import { requirementsDraftSchema } from "@arbitra/schemas/requirements.js";
import { RequirementsCheckpoint } from "./requirements-checkpoint.js";
import { ModelProtocols } from "./model-protocols.js";
import { readRequirementsProposal } from "./requirements-revision.js";
import { GraphCheckpoints, validateGraphCheckpoints, type CheckpointView, type GatePolicyRegistry } from "@arbitra/core/runner/graph-checkpoints.js";
import { checkpointPolicySchema, checkpointResponseSchema, type CheckpointPolicy } from "@arbitra/schemas/checkpoint-policy.js";
import { graphCheckpointStore } from "./graph-checkpoint-store.js";
import { canonicalJson } from "@arbitra/core/config/config-store.js";
import { replayRequestSchema, type FeatureReplayRequest, type ReplayRequest, type TestingReplayRequest } from "@arbitra/schemas/replay.js";
import { featureExecutionSchema } from "@arbitra/schemas/feature-execution.js";
import { ProtocolRegistry } from "@arbitra/protocols/registry.js";
import { bundledProtocolControlPlane } from "@arbitra/protocols/bundled.js";
import { hashProtocolBytes } from "@arbitra/protocols/versioning.js";
import { decideStages, readReplayContract, REPLAY_CONTRACT_KIND, ReplaySeed, replayReport, stageIdentities, type ProtocolPin, type ReplayContract, type StageDecision } from "./replay-contracts.js";

/** A replay's new run, with the per-stage reuse decisions for Feature and Testing. */
export interface ReplayResource {
  readonly runId: string;
  readonly sourceRunId: string;
  readonly mode: "audit" | "feature" | "testing";
  readonly state: RunState;
  readonly stages?: readonly StageDecision[];
  readonly execution?: ReplayContract["execution"];
}
import { testingOperatorView, testingVerifiedChangeSet } from "./testing-operator-view.js";
import { WorkflowGraphStore, type WorkflowGraphVersionRecord } from "@arbitra/persistence/workflow-graph-store.js";
import { workflowGraphReferenceSchema, workflowGraphSaveRequestSchema, workflowGraphValidateRequestSchema, type WorkflowGraphAuthorization, type WorkflowGraphReference } from "@arbitra/schemas/workflow-graphs.js";
import { authoredTemplates, boundedRounds, runnerGraphOf, validateAuthoredGraph, type AuthoredGraphValidation } from "./authored-graphs.js";
import type { WorkflowGraph } from "@arbitra/workflow/graph-schema.js";

/** A run's executed graph identity: the saved version it references and the version of what actually ran. */
export interface RunWorkflowGraphIdentity extends WorkflowGraphReference { readonly executedVersion: string }

export interface OrchestratorOptions {
  /** Where runs and saved configurations live. Defaults to `<repository>/.runs`. */
  readonly stateDirectory?: string;
  readonly repository?: string;
  readonly newRunId?: () => string;
  readonly providerOptions?: TransportFactoryOptions;
  readonly testSandbox?: TestSandbox;
  /**
   * Additional audit-mode graphs dispatched by preset ID. They cannot replace a shipped
   * preset. Their gate/human nodes use the generic checkpoint behavior below.
   */
  readonly graphs?: Readonly<Record<string, RunnerGraph>>;
  /** Additional deterministic gate policies. Built-in policy IDs cannot be replaced. */
  readonly gatePolicies?: GatePolicyRegistry;
  /** The clock recorded on saved workflow graph versions (ISO-8601). */
  readonly now?: () => string;
}

export interface PreflightReport {
  readonly valid: boolean;
  readonly ready: boolean;
  readonly mode: RunConfig["mode"] | null;
  readonly preset: string | null;
  /** False for a scripted Audit (no model profiles); null when the schema is invalid. */
  readonly modelBacked: boolean | null;
  readonly diagnostics: readonly PreflightDiagnostic[];
}

export type RequirementsCheckpointResource = { readonly artifactId: string; readonly kind: "requirements"; readonly pendingAmbiguityIds: readonly string[]; readonly revisionProposalArtifactId?: string };
export type RunCheckpointResource = RequirementsCheckpointResource | CheckpointView;

export interface RunResource {
  readonly runId: string;
  readonly state: string;
  readonly resumable: boolean;
  readonly checkpoints: readonly RunCheckpointResource[];
  /** How generic human nodes resolve for this run; absent when the run has no such policy. */
  readonly checkpointMode?: CheckpointPolicy["mode"];
  readonly preservedArtifacts: number;
  readonly workflow?: RunnerGraph;
  /** Present when the run executes a saved operator-authored graph. */
  readonly workflowGraph?: RunWorkflowGraphIdentity;
}

/**
 * The composition root.
 *
 * Both interfaces call this one object: `apps/cli` through `orchestratorCore`, and
 * `apps/server` through `controlPlaneCore`. There is no second orchestration path.
 */
export class Orchestrator {
  readonly repository: string;
  readonly configurations: ConfigStore<RunConfig>;
  /** Operator-authored graphs: content-addressed, immutable per version. */
  readonly workflowGraphs: WorkflowGraphStore;

  readonly #runsDirectory: string;
  readonly #newRunId: () => string;
  readonly #live = new Map<string, RunHandle>();
  readonly #resuming = new Set<string>();
  readonly #providerOptions: TransportFactoryOptions;
  readonly #testSandbox: TestSandbox | undefined;
  readonly #graphs: Readonly<Record<string, RunnerGraph>>;
  readonly #gatePolicies: GatePolicyRegistry;

  constructor(options: OrchestratorOptions = {}) {
    this.repository = resolve(options.repository ?? process.cwd());
    const state = resolve(options.stateDirectory ?? resolve(this.repository, ".runs"));
    this.#runsDirectory = resolve(state, "runs");
    this.configurations = new ConfigStore<RunConfig>(resolve(state, "configurations"), runConfigSchema);
    // arbitra-determinism: allow -- wall-clock save time is read only at the composition boundary
    this.workflowGraphs = new WorkflowGraphStore(resolve(state, "workflows"), { now: options.now ?? ((): string => new Date().toISOString()) });
    // arbitra-determinism: allow -- run identity is minted at the composition boundary
    this.#newRunId = options.newRunId ?? ((): string => `run-${randomUUID()}`);
    this.#providerOptions = options.providerOptions ?? {};
    this.#testSandbox = options.testSandbox;
    for (const id of Object.keys(options.graphs ?? {})) {
      if (Object.hasOwn(PRESET_GRAPHS, id)) throw new Error(`DUPLICATE_WORKFLOW_PRESET:${id}`);
      if (options.graphs?.[id]?.id !== id) throw new Error(`WORKFLOW_PRESET_ID_MISMATCH:${id}`);
    }
    this.#graphs = Object.freeze({ ...options.graphs });
    const builtIn: GatePolicyRegistry = {
      // The same reasons the public quality gate reports, over the artifacts written so far.
      quality_gate: async ({ runId }) => {
        const reasons = await this.#qualityReasons(runId, false);
        return { passed: reasons.length === 0, reasons };
      },
    };
    for (const id of Object.keys(options.gatePolicies ?? {})) if (Object.hasOwn(builtIn, id)) throw new Error(`DUPLICATE_GATE_POLICY:${id}`);
    this.#gatePolicies = Object.freeze({ ...options.gatePolicies, ...builtIn });
  }

  validate(value: unknown): { readonly valid: boolean; readonly errors?: readonly string[] } {
    const parsed = runConfigSchema.safeParse(value);
    return parsed.success ? { valid: true } : { valid: false, errors: parsed.error.issues.map(({ path, message }) => `${path.join(".") || "$"}: ${message}`) };
  }

  /**
   * A pre-flight cost estimate. Scripted auditors make no provider calls, so the estimate
   * reports zero spend and says why, rather than inventing a number.
   */
  async estimate(config: RunConfig, repository = this.repository): Promise<unknown> {
    const validated = this.configurations.validate(config);
    const { graph } = await this.#assertRunnable(validated);
    const snapshot = await snapshotRepository(resolve(repository), 400, { scope: validated.scope, ...testingSnapshotOptions(validated) });
    return Object.freeze({
      estimate: Object.freeze({
        files: snapshot.files.length,
        lines: snapshot.files.reduce((total, file) => total + file.lines.length, 0),
        nodes: graph.nodes.length,
        auditors: auditorIdsFor(graph).length,
        providerCalls: Object.keys(validated.models).length > 0 ? null : 0,
        costUsd: Object.keys(validated.models).length > 0 ? null : 0,
        currency: null,
        basis: Object.keys(validated.models).length > 0 ? "configured_models_cost_unknown_without_pricing_and_outputs" : "scripted_auditors_make_no_provider_calls",
      }),
      gate: "clear",
    });
  }

  /**
   * Everything checkable before a run exists: schema, roles, capabilities, effort,
   * write authority, credentials (presence only) and local sandbox prerequisites.
   * `valid` covers the configuration; `ready` additionally covers the environment.
   */
  async preflight(value: unknown): Promise<PreflightReport> {
    let config: RunConfig;
    try { config = this.configurations.validate(value); }
    catch (failure) {
      return Object.freeze({ valid: false, ready: false, mode: null, preset: null, modelBacked: null, diagnostics: Object.freeze(schemaDiagnostics(failure)) });
    }
    const saved = await this.#savedGraph(config);
    const configuration = [...saved.diagnostics, ...configurationDiagnostics(config, this.#preflightOptions(config, saved.graph))];
    const environment = await environmentDiagnostics(config, this.#environmentOptions());
    const valid = !configuration.some(({ severity }) => severity === "error");
    const preset = presetOf(config) ?? (valid ? (saved.graph ?? graphForConfiguration(config, this.#graphs)).id : null);
    return Object.freeze({ valid, ready: valid && !environment.some(({ severity }) => severity === "error"), mode: config.mode, preset,
      modelBacked: config.mode !== "audit" || Object.keys(config.models).length > 0, diagnostics: Object.freeze([...configuration, ...environment]) });
  }

  #preflightOptions(config: RunConfig, savedGraph?: RunnerGraph): ConfigurationPreflightOptions {
    return { graphs: this.#graphs, ...(savedGraph === undefined ? {} : { savedGraph }), checkpoints: (graph) => validateGraphCheckpoints(graph, checkpointPolicyOf(config), this.#gatePolicies) };
  }

  #environmentOptions() {
    return { credential: this.#providerOptions.credential ?? ((name: string) => process.env[name]), sandbox: this.#testSandbox ?? new DockerTestSandbox(), liveDispatch: this.#providerOptions.client === undefined };
  }

  /** Start a run and return as soon as it is created; it continues in the background. */
  async start(config: RunConfig, repository = this.repository): Promise<RunResource> {
    const validated = this.configurations.validate(config);
    const { graph, authored } = await this.#assertRunnable(validated);
    // Fail before a run, snapshot or provider call exists rather than at first dispatch.
    const environment = await environmentDiagnostics(validated, { ...this.#environmentOptions(), includeWarnings: false });
    if (environment.some(({ severity }) => severity === "error")) throw new PreflightError(environment);
    const incremental = incrementalRequestOf(validated);
    const base = incremental === undefined ? undefined : await this.#incrementalBase(incremental.baseRunId);
    const runId = this.#newRunId();
    const store = new RunStore(this.#runsDirectory, runId);
    const selectedRepository = resolve(repository);
    const snapshot = await snapshotRepository(selectedRepository, 400, { scope: validated.scope, ...testingSnapshotOptions(validated) });
    const modelConfiguration = Object.keys(validated.models).length > 0 ? validated : undefined;
    const checkpointPolicy = checkpointPolicyOf(validated);
    // A saved graph's identity is fixed in the run context, and its loop's explicit
    // maximum caps the consensus rounds the configuration allows.
    const storedContext: StoredRunContext = Object.freeze({ repository: selectedRepository, repositoryDigest: snapshotDigest(snapshot), scope: validated.scope, consensusPolicy: validated.consensusPolicy,
      maximumRounds: authored === undefined ? validated.maxConsensusRounds : boundedRounds(graph, validated.maxConsensusRounds), criticEnabled: graph.nodes.some(({ id }) => id === "critic"),
      ...(modelConfiguration === undefined ? {} : { modelConfiguration }), ...(checkpointPolicy === undefined ? {} : { checkpointPolicy }), ...(authored === undefined ? {} : { workflowGraph: authored }) });
    const identity = modelConfiguration?.mode === "audit" ? await captureSnapshotIdentity(snapshot, storedContext.repositoryDigest, defaultGit) : undefined;
    // Reuse is decided against the base before the run exists; the run then only reads it.
    const contract = base === undefined || identity === undefined || modelConfiguration === undefined ? undefined : await planIncrementalAudit({
      base: base.store, baseState: base.state, baseContext: base.context, repository: selectedRepository, config: modelConfiguration, criticEnabled: storedContext.criticEnabled, snapshot, identity, git: defaultGit,
      // Reuse is bound to the executed graph: a saved graph reuses only from a base that ran the same graph.
      graph: { reference: authored ?? null, version: WorkflowGraphStore.versionOf(graph) }, baseGraph: await this.#executedGraphIdentity(base.store, base.context),
      targetPin: (id) => registryProtocolPin(modelConfiguration.protocols, id),
      // A protocol the base never pinned produced no base output, so assuming the new pin cannot enable reuse.
      basePin: async (id) => await storedProtocolPin(base.store, id) ?? registryProtocolPin(modelConfiguration.protocols, id),
    });
    if (runId === contract?.baseRunId) throw new Error("INCREMENTAL_MUST_CREATE_NEW_RUN");
    await store.saveContext(storedContext);
    if (identity !== undefined) await store.publish(SNAPSHOT_IDENTITY_KIND, identity);
    if (contract !== undefined) await store.publish(INCREMENTAL_CONTRACT_KIND, contract);
    const units: AuditUnitOptions | undefined = identity === undefined ? undefined : { identity, ...(contract === undefined || base === undefined ? {} : { seed: new IncrementalSeed(base.store, store, contract) }) };
    const context: AuditContext = Object.freeze({
      snapshot,
      store,
      auditors: auditorsFor(graph, modelConfiguration),
      auditorKind: modelConfiguration === undefined ? "scripted_auditors" : "model_auditors",
      policy: Object.freeze({ name: storedContext.consensusPolicy, quorum: 2, minimumIndependentGroupsForHighRisk: 2 }),
      maximumRounds: storedContext.maximumRounds,
      criticEnabled: storedContext.criticEnabled,
    });
    const handle = this.#runner(store, context, undefined, modelConfiguration, checkpointPolicy, undefined, units).start(graph, { runId });
    this.#track(runId, handle);
    return Object.freeze({ runId, state: handle.state, resumable: true, checkpoints: Object.freeze([]), preservedArtifacts: 0 });
  }

  /** The graph a base run executed, or null when its stored definition is unavailable. */
  async #executedGraphIdentity(store: RunStore, context: StoredRunContext): Promise<{ readonly reference: WorkflowGraphReference | null; readonly version: string } | null> {
    try { return { reference: context.workflowGraph ?? null, version: WorkflowGraphStore.versionOf((await store.definitions().load(store.runId)).graph) }; }
    catch { return null; }
  }

  /**
   * The base of an incremental Audit. A request that cannot mean an incremental Audit fails
   * before a run exists; a base that is merely not reusable (not completed, rewritten
   * history, missing identities) is recorded and the run falls back to fresh work.
   */
  async #incrementalBase(baseRunId: string): Promise<{ readonly store: RunStore; readonly context: StoredRunContext; readonly state: string }> {
    const store = new RunStore(this.#runsDirectory, baseRunId);
    let context: StoredRunContext;
    try { context = await store.loadContext(); }
    catch (error) {
      if (error instanceof Error && error.message === `RUN_CONTEXT_ABSENT:${baseRunId}`) throw Object.assign(new Error(`INCREMENTAL_BASE_ABSENT:${baseRunId}`), { statusCode: 404 });
      throw error;
    }
    const mode = context.modelConfiguration === undefined ? "scripted_audit" : context.modelConfiguration.mode;
    if (mode !== "audit") throw Object.assign(new Error(`INCREMENTAL_BASE_MODE_MISMATCH:${mode}`), { statusCode: 409 });
    const state = this.#live.has(baseRunId) || this.#resuming.has(baseRunId) ? "RUNNING" : (await this.status(baseRunId)).state;
    return { store, context, state };
  }

  /** Start a run and wait for it to finish. The CLI path; the UI uses `start`. */
  async run(config: RunConfig): Promise<{ readonly runId: string; readonly state: RunState; readonly summary: unknown }> {
    const resource = await this.start(config);
    const handle = this.#live.get(resource.runId);
    if (handle === undefined) throw new Error(`RUN_HANDLE_ABSENT:${resource.runId}`);
    const state = await handle.result;
    return Object.freeze({ runId: resource.runId, state, summary: await this.summary(resource.runId) });
  }

  async wait(runId: string): Promise<RunResource> {
    const live = this.#live.get(runId);
    if (live !== undefined) await live.result;
    return this.status(runId);
  }

  /**
   * Create a new run from a saved one and wait for it. Each mode has its own replay
   * contract (see `startReplay`); the source run is only read.
   */
  async replay(sourceRunId: string, request: ReplayOverrides | ReplayRequest): Promise<{ readonly runId: string; readonly state: RunState }> {
    const started = await this.startReplay(sourceRunId, request);
    const handle = this.#live.get(started.runId);
    return Object.freeze({ runId: started.runId, state: handle === undefined ? (await this.status(started.runId)).state as RunState : await handle.result });
  }

  /**
   * Start a replay and return once the new run exists. Audit reuses round-zero discovery
   * under new consensus policy. Feature and Testing reuse each saved stage only while its
   * recorded identity (source, scope, requirements, models, protocols, harness,
   * authorization and verification) still matches; everything else is regenerated and
   * charged to the new run. Replay never resumes the source: that is `resume`.
   */
  async startReplay(sourceRunId: string, value: unknown): Promise<ReplayResource> {
    const request = parseReplayRequest(value);
    if (this.#live.has(sourceRunId) || this.#resuming.has(sourceRunId)) throw Object.assign(new Error(`REPLAY_SOURCE_RUNNING:${sourceRunId}`), { statusCode: 409 });
    this.#resuming.add(sourceRunId);
    try {
      await this.status(sourceRunId);
      const source = new RunStore(this.#runsDirectory, sourceRunId);
      const original = await source.loadContext();
      const sourceMode = original.modelConfiguration?.mode ?? "audit";
      if (request.mode === "audit") {
        if (sourceMode === "feature") throw Object.assign(new Error("FEATURE_AUDIT_REPLAY_NOT_SUPPORTED"), { statusCode: 409 });
        if (sourceMode === "testing") throw Object.assign(new Error("TESTING_AUDIT_REPLAY_NOT_SUPPORTED"), { statusCode: 409 });
        const { consensusPolicy, maximumRounds, criticEnabled } = request;
        return await this.#startAuditReplay(sourceRunId, source, original, { consensusPolicy, maximumRounds, criticEnabled });
      }
      if (request.mode !== sourceMode) throw Object.assign(new Error(`REPLAY_MODE_MISMATCH:${sourceMode}:${request.mode}`), { statusCode: 409 });
      return await this.#startModelReplay(sourceRunId, source, original, request);
    } finally { this.#resuming.delete(sourceRunId); }
  }

  async #startModelReplay(sourceRunId: string, source: RunStore, original: StoredRunContext, request: FeatureReplayRequest | TestingReplayRequest): Promise<ReplayResource> {
    const sourceConfig = original.modelConfiguration;
    if (sourceConfig === undefined) throw new Error("REPLAY_SOURCE_CONFIGURATION_ABSENT");
    let config = this.configurations.validate(request.configuration ?? sourceConfig);
    if (config.mode !== request.mode) throw Object.assign(new Error(`REPLAY_CONFIGURATION_MODE_MISMATCH:${config.mode}`), { statusCode: 400 });
    let execution: ReplayContract["execution"] = { mode: "none" };
    if (request.mode === "testing") {
      config = testingReplayConfiguration(config, request.execution);
      execution = request.execution.mode === "plan" ? { mode: "plan" } : { mode: "execute", authority: "replay_request", authorizationDigest: createHash("sha256").update(canonicalJson(request.execution.authorization)).digest("hex") };
    }
    const { graph } = await this.#assertRunnable(config);
    // Regenerated stages dispatch models and may run checks: same environment gate as `start`.
    const environment = await environmentDiagnostics(config, { ...this.#environmentOptions(), includeWarnings: false });
    if (environment.some(({ severity }) => severity === "error")) throw new PreflightError(environment);
    const checkpointPolicy = checkpointPolicyOf(config);
    const snapshot = await snapshotRepository(original.repository, 400, { scope: config.scope, ...testingSnapshotOptions(config) });
    const repositoryDigest = snapshotDigest(snapshot);
    const mode = request.mode;
    const targetPins = new Map<string, ProtocolPin>();
    const target = await stageIdentities(mode, config, { repositoryDigest, scope: config.scope, protocol: async (id) => {
      const pin = await registryProtocolPin(config.protocols, id); targetPins.set(id, pin); return pin;
    } });
    const sourceIdentities = await stageIdentities(mode, sourceConfig, { repositoryDigest: original.repositoryDigest, scope: original.scope,
      protocol: (id) => storedProtocolPin(source, id), unpinned: async (id) => targetPins.get(id) ?? registryProtocolPin(config.protocols, id) });
    const stages = decideStages(mode, sourceIdentities, target);
    const requirements: ReplayContract["requirements"] = request.mode === "feature" && request.requirements?.decision === "reuse_approved"
      ? { decision: "reuse_approved", artifactId: request.requirements.artifactId } : { decision: "reapprove" };
    const approved = requirements.decision === "reuse_approved" ? await approvedRequirements(source, sourceConfig, config, snapshot, stages, requirements.artifactId) : undefined;

    const runId = this.#newRunId();
    if (runId === sourceRunId) throw new Error("REPLAY_MUST_CREATE_NEW_RUN");
    const store = new RunStore(this.#runsDirectory, runId);
    await store.saveContext({ repository: original.repository, repositoryDigest, scope: config.scope, replaySourceRunId: sourceRunId, consensusPolicy: config.consensusPolicy,
      maximumRounds: config.maxConsensusRounds, criticEnabled: graph.nodes.some(({ id }) => id === "critic"), modelConfiguration: config, ...(checkpointPolicy === undefined ? {} : { checkpointPolicy }) });
    // Pin the exact protocol bytes the decisions were made against into the new run.
    const protocols = new ModelProtocols(store, config.protocols);
    for (const [id, pin] of targetPins) {
      const pinned = await protocols.resolve(id);
      if (pinned.protocolVersion !== pin.protocolVersion || pinned.protocolHash !== pin.protocolHash) throw new Error(`REPLAY_PROTOCOL_PIN_CHANGED:${id}`);
    }
    const contract: ReplayContract = Object.freeze({ schemaVersion: 1, sourceRunId, mode, sourceRepositoryDigest: original.repositoryDigest, repositoryDigest, stages, execution, requirements });
    await store.publish(REPLAY_CONTRACT_KIND, contract);
    if (approved !== undefined) await approved.copyTo(store);
    const seed = new ReplaySeed(source, store, contract);
    const context: AuditContext = Object.freeze({ snapshot, store, auditors: [], auditorKind: "model_auditors", policy: Object.freeze({ name: config.consensusPolicy, quorum: 2, minimumIndependentGroupsForHighRisk: 2 }), maximumRounds: config.maxConsensusRounds, criticEnabled: false });
    const handle = this.#runner(store, context, undefined, config, checkpointPolicy, seed).start(graph, { runId });
    this.#track(runId, handle);
    return Object.freeze({ runId, sourceRunId, mode, state: handle.state, stages, execution });
  }

  async #startAuditReplay(sourceRunId: string, source: RunStore, original: StoredRunContext, overrides: ReplayOverrides): Promise<ReplayResource> {
    const snapshot = await snapshotRepository(original.repository, 400, { scope: original.scope });
    if (snapshotDigest(snapshot) !== original.repositoryDigest) throw new Error(`RUN_REPOSITORY_CHANGED:${sourceRunId}`);
    const definition = await source.definitions().load(sourceRunId);
    const replayGraph = withCritic(definition.graph, overrides.criticEnabled);
    if (original.workflowGraph !== undefined) {
      // A replay of a saved graph executes that exact version; it cannot edit it.
      await this.#verifyExecutedGraph(original.workflowGraph, definition.graph);
      if (replayGraph !== definition.graph) throw Object.assign(new Error("REPLAY_SAVED_GRAPH_IMMUTABLE:criticEnabled"), { statusCode: 409 });
    }
    validateGraphCheckpoints(replayGraph, original.checkpointPolicy, this.#gatePolicies);
    if (original.modelConfiguration !== undefined) validateModelAudit(original.modelConfiguration, auditorIdsFor(replayGraph), overrides.criticEnabled);
    const auditors = auditorsFor(definition.graph, original.modelConfiguration);
    const findings = Object.fromEntries(await Promise.all(auditors.map(async ({ auditorId }) => [auditorId, await readStage<readonly AuditFinding[]>(source, `findings-${auditorId}`)] as const)));
    const runId = this.#newRunId();
    if (runId === sourceRunId) throw new Error("REPLAY_MUST_CREATE_NEW_RUN");
    const store = new RunStore(this.#runsDirectory, runId);
    await store.saveContext({ ...original, replaySourceRunId: sourceRunId, consensusPolicy: overrides.consensusPolicy, maximumRounds: overrides.maximumRounds, criticEnabled: overrides.criticEnabled });
    await store.publish("replay-source", { sourceRunId, overrides, reusedArtifacts: (await source.listArtifacts()).filter(({ kind }) => auditors.some(({ auditorId }) => kind === `findings-${auditorId}`)).map(({ artifactId, ref }) => ({ artifactId, hash: ref.hash })) });
    if (original.modelConfiguration !== undefined) {
      for (const artifact of (await source.listArtifacts()).filter(({ kind }) => kind.startsWith("model-protocol-"))) {
        await store.publish(artifact.kind, JSON.parse((await source.readArtifact(artifact.artifactId)).content));
      }
      for (const { auditorId } of auditors) await store.publish(`discovery-validation-${auditorId}`, await readStage(source, `discovery-validation-${auditorId}`), auditorId);
    }
    const context: AuditContext = Object.freeze({ snapshot, store, auditors, auditorKind: original.modelConfiguration === undefined ? "scripted_auditors" : "model_auditors", policy: Object.freeze({ name: overrides.consensusPolicy, quorum: 2, minimumIndependentGroupsForHighRisk: 2 }), maximumRounds: overrides.maximumRounds, criticEnabled: overrides.criticEnabled });
    const handle = this.#runner(store, context, findings, original.modelConfiguration, original.checkpointPolicy).start(replayGraph, { ...definition.config, runId });
    this.#track(runId, handle);
    return Object.freeze({ runId, sourceRunId, mode: "audit" as const, state: handle.state });
  }

  /** The inspectable reuse/regeneration provenance of a Feature or Testing replay run. */
  async replayReport(runId: string) {
    return replayReport(new RunStore(this.#runsDirectory, runId));
  }

  async diff(runA: string, runB: string) {
    const comparable = async (runId: string): Promise<ComparableRun> => {
      await this.status(runId);
      const store = new RunStore(this.#runsDirectory, runId);
      const issues = await readStage<CanonicalIssueSet>(store, "canonical-issues");
      return { runId, issues: issues.issues.map((issue) => ({ id: issue.candidateId, status: issue.disposition, severity: issue.severity, verification: issue.verificationOutcome })), metrics: { ...issues.summary } };
    };
    const [a, b] = await Promise.all([comparable(runA), comparable(runB)]);
    return diffRuns(a, b);
  }

  async resume(runId: string): Promise<RunResource> {
    if (this.#live.has(runId) || this.#resuming.has(runId)) throw new Error(`RUN_ALREADY_LIVE:${runId}`);
    this.#resuming.add(runId);
    try { return await this.#resume(runId); }
    finally { this.#resuming.delete(runId); }
  }

  async #resume(runId: string): Promise<RunResource> {
    const previous = await this.status(runId);
    if (!previous.resumable) throw new Error(`RUN_NOT_RESUMABLE:${runId}`);
    const store = new RunStore(this.#runsDirectory, runId);
    const storedContext = await store.loadContext();
    const snapshot = await snapshotRepository(storedContext.repository, 400, { scope: storedContext.scope, ...testingSnapshotOptions(storedContext.modelConfiguration) });
    if (snapshotDigest(snapshot) !== storedContext.repositoryDigest) throw new Error(`RUN_REPOSITORY_CHANGED:${runId}`);
    const definition = await store.definitions().load(runId);
    // A saved graph resumes as the exact version the run started with, never a later one.
    if (storedContext.workflowGraph !== undefined) await this.#verifyExecutedGraph(storedContext.workflowGraph, definition.graph);
    // The stored definition and stored policy are authoritative; a later configuration
    // edit cannot turn an unresolved checkpoint into an approval.
    validateGraphCheckpoints(definition.graph, storedContext.checkpointPolicy, this.#gatePolicies);
    const context: AuditContext = Object.freeze({
      snapshot, store, auditors: auditorsFor(definition.graph, storedContext.modelConfiguration),
      auditorKind: storedContext.modelConfiguration === undefined ? "scripted_auditors" : "model_auditors",
      policy: Object.freeze({ name: storedContext.consensusPolicy, quorum: 2, minimumIndependentGroupsForHighRisk: 2 }),
      maximumRounds: storedContext.maximumRounds, criticEnabled: storedContext.criticEnabled,
    });
    const sourceStore = storedContext.replaySourceRunId === undefined ? undefined : new RunStore(this.#runsDirectory, storedContext.replaySourceRunId);
    const modelReplay = sourceStore !== undefined && (storedContext.modelConfiguration?.mode === "feature" || storedContext.modelConfiguration?.mode === "testing");
    const reused = sourceStore === undefined || modelReplay ? undefined : Object.fromEntries(await Promise.all(context.auditors.map(async ({ auditorId }) => [auditorId, await readStage<readonly AuditFinding[]>(sourceStore, `findings-${auditorId}`)] as const)));
    // Resuming a replay run continues that run under the contract it was created with; it
    // never re-decides reuse from the current configuration.
    const seed = modelReplay && sourceStore !== undefined ? new ReplaySeed(sourceStore, store, await resumableReplayContract(store, storedContext)) : undefined;
    const units = storedContext.modelConfiguration?.mode === "audit" && reused === undefined ? await this.#resumeUnits(store, snapshot, storedContext.repositoryDigest) : undefined;
    const handle = this.#runner(store, context, reused, storedContext.modelConfiguration, storedContext.checkpointPolicy, seed, units).resume(runId);
    this.#track(runId, handle);
    return Object.freeze({ runId, state: handle.state, resumable: true, checkpoints: Object.freeze([]), preservedArtifacts: (await store.listArtifacts()).length });
  }

  /** A resumed Audit keeps its recorded snapshot identity and incremental contract; it never re-decides reuse. */
  async #resumeUnits(store: RunStore, snapshot: RepositorySnapshot, repositoryDigest: string): Promise<AuditUnitOptions> {
    let identity = await readIncrementalArtifact<SnapshotIdentity>(store, SNAPSHOT_IDENTITY_KIND);
    if (identity === null) { identity = await captureSnapshotIdentity(snapshot, repositoryDigest, defaultGit); await store.publish(SNAPSHOT_IDENTITY_KIND, identity); }
    const contract = await readIncrementalArtifact<IncrementalContract>(store, INCREMENTAL_CONTRACT_KIND);
    return { identity, ...(contract === null ? {} : { seed: new IncrementalSeed(new RunStore(this.#runsDirectory, contract.baseRunId), store, contract) }) };
  }

  /** Per-unit reuse decisions, saved work and coverage of an incremental Audit run. */
  async incrementalReport(runId: string) {
    await this.#requireRun(runId);
    const report = await incrementalReport(new RunStore(this.#runsDirectory, runId));
    if (report === null) throw Object.assign(new Error(`INCREMENTAL_CONTRACT_ABSENT:${runId}`), { statusCode: 404 });
    return report;
  }

  async status(runId: string): Promise<RunResource> {
    const live = this.#live.get(runId);
    const store = new RunStore(this.#runsDirectory, runId);
    const events = await store.loadEvents();
    const last = [...events].reverse().find((event): event is Extract<RunEvent, { t: "run_transition" }> => event.t === "run_transition");
    const state = live?.state ?? last?.state ?? "CREATED";
    if (last === undefined && live === undefined) throw new Error(`RUN_ABSENT:${runId}`);
    const workflow = last === undefined ? undefined : (await store.definitions().load(runId)).graph;
    const checkpoints: RunCheckpointResource[] = [];
    const stored = last === undefined ? undefined : await store.loadContext();
    // Mode, not graph ID: an authorized saved Audit graph may reuse a preset's ID.
    if (state === "BLOCKED" && workflow?.id === "feature-simple" && stored?.modelConfiguration?.mode === "feature") {
      const current = await this.requirements(runId);
      if (current !== null) checkpoints.push({ artifactId: current.artifactId, kind: "requirements", pendingAmbiguityIds: current.pendingAmbiguityIds,
        ...(current.revisionProposal === undefined ? {} : { revisionProposalArtifactId: current.revisionProposal.artifactId }) });
    }
    const policy = stored?.checkpointPolicy;
    if (workflow !== undefined) checkpoints.push(...await this.#checkpoints(store, policy).list(workflow));
    const workflowGraph = stored?.workflowGraph === undefined || workflow === undefined ? undefined : Object.freeze({ ...stored.workflowGraph, executedVersion: WorkflowGraphStore.versionOf(workflow) });
    return Object.freeze({ runId, state, resumable: state !== "COMPLETED", checkpoints: Object.freeze(checkpoints), ...(policy === undefined ? {} : { checkpointMode: policy.mode }), preservedArtifacts: (await store.listArtifacts()).length, ...(workflow === undefined ? {} : { workflow }), ...(workflowGraph === undefined ? {} : { workflowGraph }) });
  }

  /**
   * Record an operator decision for a generic human checkpoint. The run must be blocked
   * and idle, the version must be current, and each version accepts one decision. The
   * decision is durable; execution continues only through an explicit resume.
   */
  async respondCheckpoint(runId: string, checkpointId: string, value: unknown): Promise<{ readonly accepted: true; readonly runId: string; readonly state: RunState; readonly checkpoint: CheckpointView }> {
    const response = checkpointResponseSchema.parse(value);
    if (this.#live.has(runId) || this.#resuming.has(runId)) throw Object.assign(new Error(`RUN_ALREADY_LIVE:${runId}`), { statusCode: 409 });
    this.#resuming.add(runId);
    try {
      const status = await this.status(runId);
      if (status.state !== "BLOCKED") throw Object.assign(new Error("CHECKPOINT_RESPONSE_REQUIRES_BLOCKED_RUN"), { statusCode: 409 });
      const store = new RunStore(this.#runsDirectory, runId);
      const checkpoints = this.#checkpoints(store, (await store.loadContext()).checkpointPolicy);
      await checkpoints.respond(checkpointId, response.version, response.decision);
      const workflow = (await store.definitions().load(runId)).graph;
      const checkpoint = (await checkpoints.list(workflow)).find((view) => view.checkpointId === checkpointId);
      if (checkpoint === undefined) throw new Error(`CHECKPOINT_NOT_FOUND:${checkpointId}`);
      return Object.freeze({ accepted: true as const, runId, state: status.state as RunState, checkpoint });
    } finally { this.#resuming.delete(runId); }
  }

  #checkpoints(store: RunStore, policy: CheckpointPolicy | undefined): GraphCheckpoints {
    return new GraphCheckpoints(graphCheckpointStore(store), policy, this.#gatePolicies);
  }

  async #assertRunnable(config: RunConfig): Promise<{ readonly graph: RunnerGraph; readonly authored?: WorkflowGraphReference }> {
    const saved = await this.#savedGraph(config);
    assertNoPreflightErrors([...saved.diagnostics, ...configurationDiagnostics(config, this.#preflightOptions(config, saved.graph))]);
    // The composed stages re-check their own settings; keep those checks authoritative.
    assertRuntimeConfiguration(config, this.#graphs, saved.graph);
    const graph = saved.graph ?? graphForConfiguration(config, this.#graphs);
    validateGraphCheckpoints(graph, checkpointPolicyOf(config), this.#gatePolicies);
    return saved.reference === undefined ? { graph } : { graph, authored: saved.reference };
  }

  /**
   * Resolve `workflow.graph` to its saved version and re-validate it against this run's
   * configuration. A missing or invalid version becomes preflight configuration
   * diagnostics at `workflow.graph`, so it is refused before any run exists.
   */
  async #savedGraph(config: RunConfig): Promise<{ readonly graph?: RunnerGraph; readonly reference?: WorkflowGraphReference; readonly diagnostics: readonly PreflightDiagnostic[] }> {
    if (config.workflow["graph"] === undefined) return { diagnostics: [] };
    const failed = (code: string, path: string, message: string) => ({ diagnostics: [Object.freeze({ code, severity: "error" as const, scope: "configuration" as const, path, message })] });
    const reference = workflowGraphReferenceSchema.parse(config.workflow["graph"]);
    const record = await this.workflowGraphs.get(reference.id, reference.version);
    if (record === null) return failed("WORKFLOW_GRAPH_VERSION_ABSENT", "workflow.graph", `Saved graph ${reference.id} has no version ${reference.version}. Save the graph first and reference the exact version the save returned.`);
    if ((record.graph as { id?: unknown }).id !== reference.id) return failed("WORKFLOW_GRAPH_ID_MISMATCH", "workflow.graph.id", `Version ${reference.version} is not a version of graph ${reference.id}.`);
    const validation = this.#validateGraph(record.graph, record.authorizations as readonly WorkflowGraphAuthorization[], config);
    if (!validation.valid) {
      return { diagnostics: validation.diagnostics.map(({ code, path, message }) => Object.freeze({ code, severity: "error" as const, scope: "configuration" as const, path: `workflow.graph(${reference.id}).${path}`, message })) };
    }
    return { graph: runnerGraphOf(record.graph as WorkflowGraph), reference: Object.freeze({ ...reference }), diagnostics: [] };
  }

  /** The graph a run executed must be byte-for-byte the saved version it references. */
  async #verifyExecutedGraph(reference: WorkflowGraphReference, executed: RunnerGraph): Promise<void> {
    const record = await this.workflowGraphs.get(reference.id, reference.version);
    if (record === null) throw Object.assign(new Error(`WORKFLOW_GRAPH_VERSION_ABSENT:${reference.id}:${reference.version}`), { statusCode: 409 });
    if (WorkflowGraphStore.versionOf(executed) !== reference.version) throw Object.assign(new Error(`RUN_WORKFLOW_GRAPH_MISMATCH:${reference.id}:${reference.version}`), { statusCode: 409 });
  }

  #validateGraph(graph: unknown, authorize: readonly WorkflowGraphAuthorization[], configuration?: RunConfig): AuthoredGraphValidation {
    return validateAuthoredGraph(graph, { gatePolicies: this.#gatePolicies, authorize, reservedIds: [...Object.keys(PRESET_GRAPHS), ...Object.keys(this.#graphs)], ...(configuration === undefined ? {} : { configuration }) });
  }

  /** Saved graphs by ID with their versions, and an editable template of each Audit preset. */
  async listWorkflowGraphs() {
    return Object.freeze({ graphs: await this.workflowGraphs.list(), templates: authoredTemplates() });
  }

  async workflowGraphVersions(graphId: string) {
    const versions = await this.workflowGraphs.versions(graphId);
    if (versions.length === 0) throw Object.assign(new Error(`WORKFLOW_GRAPH_ABSENT:${graphId}`), { statusCode: 404 });
    return Object.freeze({ graphId, versions });
  }

  async workflowGraph(graphId: string, version: string): Promise<WorkflowGraphVersionRecord> {
    const record = await this.workflowGraphs.get(graphId, version);
    if (record === null) throw Object.assign(new Error(`WORKFLOW_GRAPH_VERSION_ABSENT:${graphId}:${version}`), { statusCode: 404 });
    return record;
  }

  /** The server-side validator the editor and CLI call; nothing is written. */
  async validateWorkflowGraph(value: unknown): Promise<AuthoredGraphValidation> {
    const request = parseRequest(workflowGraphValidateRequestSchema, value);
    const configuration = request.configurationId === undefined ? undefined : (await this.configurations.load(request.configurationId)).config;
    return this.#validateGraph(request.graph, request.authorize, configuration);
  }

  /**
   * Save a validated graph as an immutable version. An invalid graph is refused with its
   * diagnostic codes. Only authorizations the graph actually needs are recorded.
   */
  async saveWorkflowGraph(value: unknown): Promise<{ readonly record: WorkflowGraphVersionRecord; readonly created: boolean; readonly validation: AuthoredGraphValidation }> {
    const request = parseRequest(workflowGraphSaveRequestSchema, value);
    const configuration = request.configurationId === undefined ? undefined : (await this.configurations.load(request.configurationId)).config;
    const validation = this.#validateGraph(request.graph, request.authorize, configuration);
    if (!validation.valid) throw Object.assign(new Error(`WORKFLOW_GRAPH_INVALID:${[...new Set(validation.diagnostics.map(({ code }) => code))].join(",")}`), { statusCode: 422 });
    const graph = request.graph as unknown as WorkflowGraph;
    const needed = new Set(validation.privileged.map(({ category }) => category));
    const saved = await this.workflowGraphs.save({ graphId: graph.id, graph, parentVersion: request.parentVersion, authorizations: request.authorize.filter((category) => needed.has(category)) });
    return Object.freeze({ ...saved, validation });
  }

  async requirements(runId: string) {
    const store = new RunStore(this.#runsDirectory, runId);
    const { modelConfiguration: config } = await store.loadContext();
    if (config?.mode !== "feature") throw new Error("FEATURE_RUN_REQUIRED");
    const settings = validateModelFeature(config);
    const protocol = await new ModelProtocols(store, config.protocols).resolve("feature-requirements");
    // Reading the saved contract must work even when source has since changed.
    // Only mutations and execution need the original repository snapshot.
    const current = await new RequirementsCheckpoint(store, { mode: settings.mode, protocolVersion: protocol.protocolVersion, protocolHash: protocol.protocolHash,
      runtime: { async generate() { throw new Error("REQUIREMENTS_READ_CANNOT_GENERATE"); } } }).current();
    if (current === null) return null;
    const pointer = (await store.listArtifacts()).find(({ kind }) => kind === "requirements-revision-proposal-current");
    let revisionProposal;
    if (pointer !== undefined) {
      const saved = await store.artifacts.get<{ artifactId: string; baseArtifactId: string }>(pointer.ref);
      if (saved.baseArtifactId === current.artifactId) revisionProposal = { artifactId: saved.artifactId, ...await readRequirementsProposal(store, saved.artifactId) };
    }
    return { ...current, ...(revisionProposal === undefined ? {} : { revisionProposal }) };
  }

  /** The read-only Testing operator view: stored authority, plan versus execution, repair and handoff. */
  async testing(runId: string) {
    const status = await this.status(runId);
    const { modelConfiguration: config } = await new RunStore(this.#runsDirectory, runId).loadContext();
    if (config?.mode !== "testing") throw Object.assign(new Error("TESTING_RUN_REQUIRED"), { statusCode: 409 });
    return testingOperatorView(new RunStore(this.#runsDirectory, runId), runId, status.state, config);
  }

  /** The exact verified Testing change set, rechecked against its completion record. */
  async testingChangeSet(runId: string) {
    await this.status(runId);
    const store = new RunStore(this.#runsDirectory, runId);
    if ((await store.loadContext()).modelConfiguration?.mode !== "testing") throw Object.assign(new Error("TESTING_RUN_REQUIRED"), { statusCode: 409 });
    return testingVerifiedChangeSet(store, runId);
  }

  async applyRequirementsRevision(runId: string, artifactId: string) {
    return this.#changeRequirements(runId, (pipeline) => pipeline.applyRequirementsRevision(artifactId));
  }

  async approveRequirements(runId: string, value: unknown) {
    const approval = requirementsApprovalSchema.parse(value);
    return this.#changeRequirements(runId, async (pipeline) => (await pipeline.requirements(new AbortController().signal)).checkpoint.approve(approval.artifactId, approval.ambiguityIds));
  }

  async reviseRequirements(runId: string, artifactId: string, draft: unknown) {
    const parsed = requirementsDraftSchema.parse(draft);
    return this.#changeRequirements(runId, async (pipeline) => (await pipeline.requirements(new AbortController().signal)).checkpoint.revise(artifactId, parsed));
  }

  async #changeRequirements<T>(runId: string, change: (pipeline: FeaturePipeline) => Promise<T>): Promise<T> {
    if (this.#live.has(runId) || this.#resuming.has(runId)) throw Object.assign(new Error(`RUN_ALREADY_LIVE:${runId}`), { statusCode: 409 });
    this.#resuming.add(runId);
    try {
      if ((await this.status(runId)).state !== "BLOCKED") throw Object.assign(new Error("REQUIREMENTS_EDIT_REQUIRES_BLOCKED_RUN"), { statusCode: 409 });
      return await change(await this.#featurePipeline(runId));
    } catch (error) {
      if (error instanceof Error && error.message === "STALE_REQUIREMENTS_CHECKPOINT") throw Object.assign(error, { statusCode: 409 });
      throw error;
    } finally { this.#resuming.delete(runId); }
  }

  async #featurePipeline(runId: string): Promise<FeaturePipeline> {
    const store = new RunStore(this.#runsDirectory, runId);
    const context = await store.loadContext();
    if (context.modelConfiguration?.mode !== "feature") throw new Error("FEATURE_RUN_REQUIRED");
    const snapshot = await snapshotRepository(context.repository, 400, { scope: context.scope });
    if (snapshotDigest(snapshot) !== context.repositoryDigest) throw new Error(`RUN_REPOSITORY_CHANGED:${runId}`);
    return new FeaturePipeline(store, context.modelConfiguration, snapshot, this.#providerOptions);
  }

  async cancel(runId: string): Promise<RunResource> {
    const handle = this.#live.get(runId);
    if (handle === undefined) {
      const existing = await this.status(runId);
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(existing.state)) return existing;
      throw new Error(`RUN_NOT_LIVE:${runId}`);
    }
    handle.cancel("cancelled_by_operator");
    const state = await handle.result;
    return Object.freeze({ runId, state, resumable: state !== "COMPLETED", checkpoints: Object.freeze([]), preservedArtifacts: (await new RunStore(this.#runsDirectory, runId).listArtifacts()).length });
  }

  /**
   * The SSE feed. A live run streams from the runner; a finished one replays its recorded
   * events so a late subscriber sees the same history rather than an empty stream.
   */
  async *events(runId: string): AsyncIterable<RunEvent> {
    const store = new RunStore(this.#runsDirectory, runId);
    let cursor = 0;
    while (true) {
      // Read the durable sequence for each subscriber. An event's position, not its
      // content, is its identity: resume can legitimately emit the same transition twice.
      const live = this.#live.get(runId);
      const history = await store.loadEvents();
      for (const event of history.slice(cursor)) yield event;
      cursor = history.length;
      if (live === undefined) {
        if (cursor === 0) throw new Error(`RUN_ABSENT:${runId}`);
        return;
      }
      await Promise.race([delay(50), live.result.then(() => undefined, () => undefined)]);
    }
  }

  async artifacts(runId: string): Promise<readonly PublicArtifact[]> {
    return (await new RunStore(this.#runsDirectory, runId).listArtifacts()).map(withoutRef);
  }

  async artifact(runId: string, artifactId: string): Promise<unknown> {
    const { descriptor, content } = await new RunStore(this.#runsDirectory, runId).readArtifact(artifactId);
    return Object.freeze({ ...withoutRef(descriptor), content, truncated: false, continuationArtifactId: null });
  }

  async runIds(): Promise<readonly string[]> { return listRunIds(this.#runsDirectory); }

  async modelTraces(runId: string) {
    await this.#requireRun(runId);
    return loadActivityTraces(this.#runsDirectory, runId);
  }

  async #requireRun(runId: string): Promise<void> {
    try { await new RunStore(this.#runsDirectory, runId).loadContext(); }
    catch (error) {
      if (error instanceof Error && error.message === `RUN_CONTEXT_ABSENT:${runId}`) throw Object.assign(error, { statusCode: 404 });
      throw error;
    }
  }

  /** Served from the persistent per-run trace index; the committed JSONL log stays authoritative. */
  async traces(runId: string, query: unknown = {}) {
    await this.#requireRun(runId);
    return indexedTracePage(this.#runsDirectory, runId, query);
  }

  async trace(runId: string, traceId: string) {
    await this.#requireRun(runId);
    return indexedTraceEntry(this.#runsDirectory, runId, traceId);
  }

  async traceArtifact(runId: string, traceId: string, slot: string) {
    const { trace } = await this.trace(runId, traceId);
    const input = /^input-(0|[1-9][0-9]*)$/u.exec(slot);
    const reference = slot === "output" ? trace.outputArtifactRef : input === null ? undefined : trace.inputArtifactRefs[Number(input[1])];
    if (reference == null) throw Object.assign(new Error("TRACE_ARTIFACT_ABSENT"), { statusCode: 404 });
    const value = await new RunStore(this.#runsDirectory, runId).artifacts.getByRelativePath<unknown>(reference);
    return { reference, content: JSON.stringify(value, null, 2), redacted: true as const };
  }

  async metrics(runId: string) {
    return evaluationMetrics(new RunStore(this.#runsDirectory, runId), await this.modelTraces(runId));
  }

  /** The shape both `report` and the CLI's human output read. */
  async summary(runId: string): Promise<unknown> {
    const store = new RunStore(this.#runsDirectory, runId);
    const descriptors = await store.listArtifacts();
    if ((await store.loadContext()).modelConfiguration?.mode === "testing") {
      const outcome = descriptors.some(({ kind }) => kind === "testing-outcome") ? await readStage<TestingOutcome>(store, "testing-outcome") : null;
      const execution = descriptors.some(({ kind }) => kind === "testing-execution-outcome") ? await readStage<TestingPlanExecutionOutcome>(store, "testing-execution-outcome") : null;
      return { runId, mode: "testing", outcome, execution, artifacts: descriptors.length, ...await replaySummary(store) };
    }
    if ((await store.loadContext()).modelConfiguration?.mode === "feature") {
      const outcome = descriptors.some(({ kind }) => kind === "feature-outcome") ? await readStage<FeatureOutcome>(store, "feature-outcome") : null;
      return { runId, mode: "feature", outcome, requirements: await this.requirements(runId), artifacts: descriptors.length, ...await replaySummary(store) };
    }
    const issues = descriptors.find(({ kind }) => kind === "canonical-issues");
    if (issues === undefined) return Object.freeze({ runId, issues: null, artifacts: descriptors.length });
    const parsed = JSON.parse((await store.readArtifact(issues.artifactId)).content) as {
      summary: { auditorCount: number; sourceFindingCount: number; acceptedCount: number; rejectedCount: number; unresolvedCount: number; singleSourceCount: number };
      coverage: { complete: boolean };
      limitations: readonly string[];
    };
    const incremental = await incrementalReport(store);
    return Object.freeze({ runId, ...parsed.summary, coverageComplete: parsed.coverage.complete, limitations: parsed.limitations, artifacts: descriptors.length,
      ...(incremental === null ? {} : { incremental: { baseRunId: incremental.baseRunId, strategy: incremental.strategy, fallbackReasons: incremental.fallbackReasons, savedWork: incremental.savedWork, coverageDegraded: incremental.coverage.degradedVersusFullRun } }) });
  }

  /**
   * The gate the CLI turns into an exit code. It fails closed: an unresolved issue or
   * incomplete coverage is a failure, never a pass earned by running out of budget.
   */
  async gate(runId: string): Promise<{ readonly gateStatus: "passed" | "failed"; readonly reasons: readonly string[] }> {
    const store = new RunStore(this.#runsDirectory, runId);
    const reasons = [...await this.#qualityReasons(runId, true)];
    // Generic gate/human outcomes are part of the public gate in every mode, so a pending,
    // rejected or failed checkpoint can never be reported as a pass.
    if ((await store.loadEvents()).length > 0) {
      const workflow = (await store.definitions().load(runId)).graph;
      for (const reason of await this.#checkpoints(store, (await store.loadContext()).checkpointPolicy).gateReasons(workflow)) if (!reasons.includes(reason)) reasons.push(reason);
    }
    return Object.freeze({ gateStatus: reasons.length === 0 ? "passed" : "failed", reasons: Object.freeze(reasons) });
  }

  /** Artifact-derived quality reasons; `completion` adds the terminal-state requirement. */
  async #qualityReasons(runId: string, completion: boolean): Promise<readonly string[]> {
    const completed = async (): Promise<readonly string[]> => !completion || (await this.status(runId)).state === "COMPLETED" ? [] : ["run_not_completed"];
    const featureStore = new RunStore(this.#runsDirectory, runId);
    if ((await featureStore.loadContext()).modelConfiguration?.mode === "testing") {
      const artifacts = await featureStore.listArtifacts();
      const outcome = artifacts.some(({ kind }) => kind === "testing-outcome") ? await readStage<TestingOutcome>(featureStore, "testing-outcome") : null;
      const reasons = [...(await completed()), ...(outcome === null ? ["no_testing_plan_result"] : outcome.reasons),
        ...(outcome !== null && outcome.selectedGaps > 0 && !artifacts.some(({ kind }) => kind === "implementation") ? ["no_implementation_handoff"] : [])];
      if (outcome !== null && !outcome.passed && reasons.length === 0) reasons.push("testing_plan_failed");
      const config = (await featureStore.loadContext()).modelConfiguration;
      if (config !== undefined && testingExecutionSchema.parse(config.workflow["testing"]).mode === "execute" && outcome?.selectedGaps !== 0) {
        const execution = artifacts.some(({ kind }) => kind === "testing-execution-outcome") ? await readStage<TestingPlanExecutionOutcome>(featureStore, "testing-execution-outcome") : null;
        if (execution === null) reasons.push("no_testing_execution_result");
        else {
          reasons.push(...execution.reasons);
          if (!execution.passed && execution.reasons.length === 0) reasons.push("testing_execution_failed");
          if (execution.planFingerprint !== outcome?.planFingerprint) reasons.push("testing_execution_plan_mismatch");
        }
        if (!artifacts.some(({ kind }) => kind === "testing-execution-completion")) reasons.push("no_verified_testing_handoff");
      }
      return reasons;
    }
    if ((await featureStore.loadContext()).modelConfiguration?.mode === "feature") {
      const artifacts = await featureStore.listArtifacts();
      const outcome = artifacts.some(({ kind }) => kind === "feature-outcome") ? await readStage<FeatureOutcome>(featureStore, "feature-outcome") : null;
      const reasons = [...(await completed()),
        ...(outcome === null ? ["no_feature_plan_result"] : outcome.reasons),
        ...(!artifacts.some(({ kind }) => kind === "implementation") ? ["no_implementation_handoff"] : [])];
      if (outcome !== null && !outcome.passed && reasons.length === 0) reasons.push("feature_plan_review_failed");
      return reasons;
    }
    const summary = await this.summary(runId) as { issues?: null; unresolvedCount?: number; coverageComplete?: boolean };
    // A run that produced no canonical issue set established no trustworthy result, so it
    // fails rather than passing on the absence of anything to object to.
    if (summary.issues === null) return ["no_canonical_issue_set"];
    const reasons = [
      ...(await completed()),
      ...(summary.unresolvedCount !== undefined && summary.unresolvedCount > 0 ? ["unresolved_issues"] : []),
      ...(summary.coverageComplete === false ? ["degraded_coverage"] : []),
    ];
    const store = new RunStore(this.#runsDirectory, runId);
    const artifacts = await store.listArtifacts();
    if (artifacts.some(({ kind }) => kind === "plan-ir")) {
      const plan = await readStage<{ unresolvedQuestions: readonly { blocking: boolean }[] }>(store, "plan-ir");
      if (plan.unresolvedQuestions.some(({ blocking }) => blocking)) reasons.push("blocking_plan_questions");
    }
    if (artifacts.some(({ kind }) => kind === "critic-feedback")) {
      const feedback = await readStage<{ items: readonly { blocking: boolean }[] }>(store, "critic-feedback");
      if (feedback.items.some(({ blocking }) => blocking)) reasons.push("blocking_critic_feedback");
    }
    if (artifacts.some(({ kind }) => kind === "critic-result")) {
      const review = await readStage<{ degradedReviewCoverage: boolean }>(store, "critic-result");
      if (review.degradedReviewCoverage) reasons.push("degraded_critic_coverage");
    }
    return reasons;
  }

  #runner(store: RunStore, context: AuditContext, reusedFindings: Readonly<Record<string, readonly AuditFinding[]>> | undefined, modelConfiguration: RunConfig | undefined, checkpointPolicy: CheckpointPolicy | undefined, replay?: ReplaySeed, units?: AuditUnitOptions): WorkflowRunner {
    // Every mode gets the same generic gate/human executors; none has an implicit pass.
    const checkpoints = this.#checkpoints(store, checkpointPolicy).executors();
    if (modelConfiguration?.mode === "testing") {
      // A planning replay holds no sandbox at all, so it cannot dispatch checks.
      const planReplay = replay !== undefined && replay.contract.execution.mode !== "execute";
      const testing = new TestingPipeline(store, this.configurations.validate(modelConfiguration), context.snapshot, this.#providerOptions, planReplay ? undefined : this.#testSandbox, replay);
      return new WorkflowRunner({ journal: store.journalPort(), artifacts: store.artifacts, definitions: store.definitions(), loadRecords: () => store.loadRecords(), executors: {
        deterministic: async ({ node }) => {
          if (node.id === "render") return testing.render();
          const result = { mode: "testing", fileCount: context.snapshot.files.length, readOnly: true, testsExecuted: false };
          await store.publish("preflight", result, "preflight"); return result;
        }, subgraph: ({ node, signal }) => {
          if (node.id !== "execute") return testing.run(signal);
          if (planReplay) throw new Error("REPLAY_PLAN_CANNOT_EXECUTE");
          return testing.execute(signal);
        },
        ...checkpoints,
      } });
    }
    if (modelConfiguration?.mode === "feature") {
      const feature = new FeaturePipeline(store, this.configurations.validate(modelConfiguration), context.snapshot, this.#providerOptions, replay);
      return new WorkflowRunner({ journal: store.journalPort(), artifacts: store.artifacts, definitions: store.definitions(), loadRecords: () => store.loadRecords(), executors: {
        deterministic: async ({ node }) => {
          if (node.id === "render") return feature.render();
          const result = { mode: "feature", fileCount: context.snapshot.files.length, sourceOnly: true };
          await store.publish("preflight", result, "preflight"); return result;
        },
        subgraph: ({ signal }) => feature.run(signal),
        ...checkpoints,
      } });
    }
    const models = modelConfiguration === undefined ? undefined : new ModelAuditPipeline(context, this.configurations.validate(modelConfiguration), this.#providerOptions, this.#testSandbox, units);
    // Stages hand off through the artifact store rather than through closure state, so a
    // resumed run can start at any node with every earlier stage's output still readable.
    return new WorkflowRunner({
      journal: store.journalPort(),
      artifacts: store.artifacts,
      definitions: store.definitions(),
      loadRecords: () => store.loadRecords(),
      executors: {
        deterministic: async () => { await models?.prepareProtocols(); return preflight(context); },
        model: async ({ node, signal }: NodeExecutionContext) => {
          if (node.id === "planner") {
            const issues = await readStage<CanonicalIssueSet>(store, "canonical-issues");
            const produced = models === undefined ? await plan(context, issues) : await models.plan(issues, signal);
            return { tasks: produced.tasks.length, acceptedIssues: produced.acceptedIssueIds.length };
          }
          if (node.id === "critic") {
            const issues = await readStage<CanonicalIssueSet>(store, "canonical-issues");
            const reviewed = models === undefined ? await critique(context, await readStage<Plan>(store, "plan-ir"), issues) : await models.critique(await readStage<PlanIR>(store, "plan-ir"), issues, signal);
            return { items: reviewed?.items.length ?? 0, blocking: reviewed?.items.filter(({ blocking }) => blocking).length ?? 0 };
          }
          const discovered = reusedFindings === undefined ? models === undefined ? discover(context, node.id) : await models.discover(node.id, signal) : reusedFindings[node.id];
          if (discovered === undefined) throw new Error(`REPLAY_SOURCE_FINDINGS_UNAVAILABLE:${node.id}`);
          await store.publish(`findings-${node.id}`, discovered, node.id);
          return { auditorId: node.id, findingCount: discovered.length };
        },
        loop: async ({ signal }) => {
          const findings = await this.#collectFindings(store, context);
          const convergence = models === undefined ? await converge(context, findings) : await models.converge(findings, signal);
          return { candidates: convergence.consensus.candidates.length, accepted: convergence.consensus.candidates.filter(({ outcome }) => outcome === "accepted").length };
        },
        subgraph: async ({ signal }) => {
          const convergence = await readStage<ConvergenceResult>(store, "consensus-state");
          if (models !== undefined) {
            const issues = await models.verify(convergence, signal);
            return { issues: issues.issues.length };
          }
          const verification = await verify(context, convergence);
          const issues = await canonicalise(context, convergence, verification);
          return { verified: verification.length, issues: issues.issues.length };
        },
        ...checkpoints,
      },
    });
  }

  async #collectFindings(store: RunStore, context: AuditContext): Promise<Readonly<Record<string, readonly AuditFinding[]>>> {
    const entries = await Promise.all(context.auditors.map(async ({ auditorId }) => [auditorId, await readStage<readonly AuditFinding[]>(store, `findings-${auditorId}`)] as const));
    return Object.fromEntries(entries);
  }

  #track(runId: string, handle: RunHandle): void {
    this.#live.set(runId, handle);
    void handle.result.finally(() => { if (this.#live.get(runId) === handle) this.#live.delete(runId); }).catch(() => undefined);
  }
}

export { AUDIT_DEEP_GRAPH, type RunnerGraph };

/** The store's content-addressed ref stays internal; callers address artifacts by id. */
export type PublicArtifact = Omit<ArtifactDescriptor, "ref">;
function withoutRef(descriptor: ArtifactDescriptor): PublicArtifact {
  return Object.freeze({ artifactId: descriptor.artifactId, kind: descriptor.kind, mediaType: descriptor.mediaType, bytes: descriptor.bytes, redacted: descriptor.redacted, nodeId: descriptor.nodeId });
}

/** The run config's `workflow` section is free-form JSON, so the preset is read defensively. */
function presetOf(config: RunConfig): string | undefined {
  const preset = (config.workflow as { preset?: unknown } | undefined)?.preset;
  return typeof preset === "string" ? preset : undefined;
}

/** Do not misrepresent a scripted audit as an uncomposed model/Feature/Testing run. */
function assertRuntimeConfiguration(config: RunConfig, registered: Readonly<Record<string, RunnerGraph>>, saved?: RunnerGraph): void {
  const resolveGraph = (): RunnerGraph => saved ?? graphForConfiguration(config, registered);
  // Native harnesses serve only the stages in their support matrix (the Testing writer).
  // Audit discovery keeps the canonical baseline; Feature has no native stage.
  if (config.harness.mode !== "canonical") {
    if (config.mode === "audit") throw new Error("NATIVE_HARNESS_DISCOVERY_FORBIDDEN");
    if (config.mode !== "testing") throw new Error(`NATIVE_HARNESS_MODE_UNSUPPORTED:${config.mode}`);
  }
  if (config.mode === "testing") { validateModelTesting(config); resolveGraph(); return; }
  if (config.mode === "feature") { validateModelFeature(config); resolveGraph(); return; }
  if (Object.keys(config.models).length > 0) {
    if (config.workflow["modelExecution"] === undefined) throw new Error("RUNTIME_MODEL_EXECUTION_CONFIGURATION_REQUIRED");
    const graph = resolveGraph();
    validateModelAudit(config, auditorIdsFor(graph), graph.nodes.some(({ id }) => id === "critic"));
  }
  if (config.workflow["preset"] !== undefined && typeof config.workflow["preset"] !== "string") throw new Error("INVALID_WORKFLOW_PRESET");
  resolveGraph();
}

function parseRequest<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw Object.assign(new Error(`INVALID_WORKFLOW_GRAPH_REQUEST:${parsed.error.issues.map(({ path, message }) => `${path.map(String).join(".") || "$"}: ${message}`).join("; ")}`), { statusCode: 400 });
  return parsed.data;
}

function checkpointPolicyOf(config: RunConfig): CheckpointPolicy | undefined {
  const value = config.workflow["checkpoints"];
  return value === undefined ? undefined : checkpointPolicySchema.parse(value);
}

function schemaDiagnostics(failure: unknown): PreflightDiagnostic[] {
  const issues = (failure as { issues?: unknown }).issues;
  if (Array.isArray(issues)) return issues.map((issue: { path?: readonly PropertyKey[]; message?: string }) => Object.freeze({ code: "CONFIG_SCHEMA_INVALID", severity: "error" as const, scope: "configuration" as const, path: (issue.path ?? []).map(String).join(".") || "$", message: issue.message ?? "Invalid value" }));
  const message = failure instanceof Error ? failure.message : String(failure);
  const [code, path] = message.split(":", 2);
  if (code === "RESOLVED_CREDENTIAL_FORBIDDEN") return [Object.freeze({ code, severity: "error" as const, scope: "configuration" as const, path: path?.replace(/^\$\.?/u, "") || "$", message: "A credential value is present in the configuration. Remove it and name an environment variable in an …EnvVar field (for example apiKeyEnvVar) instead." })];
  if (code === "INVALID_CREDENTIAL_ENVIRONMENT_REFERENCE") return [Object.freeze({ code, severity: "error" as const, scope: "configuration" as const, path: path?.replace(/^\$\.?/u, "") || "$", message: "Environment-variable references must be uppercase names such as PROVIDER_API_KEY, never the secret itself." })];
  return [Object.freeze({ code: "CONFIG_INVALID", severity: "error" as const, scope: "configuration" as const, path: "$", message })];
}

function snapshotDigest(snapshot: RepositorySnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot.files)).digest("hex");
}

function testingSnapshotOptions(config: RunConfig | undefined) {
  return config?.mode === "testing" ? { includeTestMetadata: true, additionalPaths: testingExecutionSchema.parse(config.workflow["testing"]).commands.map(({ evidence }) => evidence.path) } : {};
}

function auditorsFor(graph: RunnerGraph, config?: RunConfig) {
  const ids = auditorIdsFor(graph);
  if (config !== undefined) return ids.map((auditorId) => {
    const profile = config.models[auditorId];
    if (profile === undefined) throw new Error(`MODEL_PROFILE_REQUIRED:${auditorId}`);
    return { auditorId, independenceGroup: profile.independenceGroup, ruleIds: [] };
  });
  return DEFAULT_AUDITORS.filter(({ auditorId }) => ids.includes(auditorId));
}

async function replaySummary(store: RunStore): Promise<{ readonly replay?: unknown }> {
  const report = await replayReport(store);
  return report === null ? {} : { replay: report };
}

/** The contract a replay run resumes under; it must be intact and name the run's own source and mode. */
async function resumableReplayContract(store: RunStore, context: StoredRunContext): Promise<ReplayContract> {
  const contract = await readReplayContract(store);
  if (contract === null) throw Object.assign(new Error(`REPLAY_CONTRACT_ABSENT:${store.runId}`), { statusCode: 409 });
  if (contract.sourceRunId !== context.replaySourceRunId || contract.mode !== context.modelConfiguration?.mode) throw Object.assign(new Error(`REPLAY_CONTRACT_MISMATCH:${store.runId}`), { statusCode: 409 });
  return contract;
}

/** Legacy Audit overrides carry no `mode`; every other request names its replay contract. */
function parseReplayRequest(value: unknown): ReplayRequest {
  const candidate = typeof value === "object" && value !== null && !Array.isArray(value) && !Object.hasOwn(value, "mode") ? { mode: "audit", ...value } : value;
  const parsed = replayRequestSchema.safeParse(candidate);
  if (!parsed.success) throw Object.assign(new Error(`INVALID_REPLAY_REQUEST:${parsed.error.issues.map(({ path, message }) => `${path.join(".") || "$"}: ${message}`).join("; ")}`), { statusCode: 400 });
  return parsed.data;
}

/**
 * Testing replay chooses execution explicitly. A planning replay drops execution settings,
 * so its graph has no execute node. An execution replay takes its write authority only from
 * the replay request, never from the source run or a supplied configuration.
 */
function testingReplayConfiguration(config: RunConfig, execution: TestingReplayRequest["execution"]): RunConfig {
  const settings = testingExecutionSchema.parse(config.workflow["testing"]);
  const preset = presetOf(config);
  if (execution.mode === "plan") {
    const { goal, roles, commands } = settings;
    return runConfigSchema.parse({ ...config, workflow: { ...config.workflow, testing: { mode: "plan", goal, roles, commands }, ...(preset === undefined ? {} : { preset: "testing-plan" }) } });
  }
  if (settings.mode !== "execute") throw Object.assign(new Error("REPLAY_EXECUTION_CONFIGURATION_REQUIRED"), { statusCode: 400 });
  return runConfigSchema.parse({ ...config, workflow: { ...config.workflow, testing: { ...settings, execution: { ...settings.execution, authorization: execution.authorization } }, ...(preset === undefined ? {} : { preset: "testing-execute" }) } });
}

/** The protocol a new run would pin, resolved without writing anything. */
async function registryProtocolPin(selections: Readonly<Record<string, unknown>>, id: string): Promise<ProtocolPin> {
  const selected = Object.hasOwn(selections, id) ? selections[id] : "1.0.0";
  if (typeof selected !== "string") throw new Error(`INVALID_PROTOCOL_SELECTION:${id}`);
  const protocol = await new ProtocolRegistry(bundledProtocolControlPlane()).resolve(id, selected);
  return { protocolVersion: protocol.protocolVersion, protocolHash: protocol.protocolHash };
}

/** The protocol a source run pinned, or null when it has no intact pinned copy. */
async function storedProtocolPin(store: RunStore, id: string): Promise<ProtocolPin | null> {
  const descriptor = (await store.listArtifacts()).find(({ kind }) => kind === `model-protocol-${id}`);
  if (descriptor === undefined) return null;
  try {
    const stored = await store.artifacts.get<{ protocolId?: unknown; protocolVersion?: unknown; protocolHash?: unknown; content?: unknown }>(descriptor.ref);
    if (stored.protocolId !== id || typeof stored.protocolVersion !== "string" || typeof stored.protocolHash !== "string" || typeof stored.content !== "string"
      || hashProtocolBytes(new TextEncoder().encode(stored.content)) !== stored.protocolHash) return null;
    return { protocolVersion: stored.protocolVersion, protocolHash: stored.protocolHash };
  } catch { return null; }
}

/**
 * Validate an explicit request to reuse the source run's approved requirements contract.
 * It must name the source's current contract, be fully approved, and be compatible with
 * the new run; otherwise the replay fails rather than silently re-deriving requirements.
 */
async function approvedRequirements(source: RunStore, sourceConfig: RunConfig, config: RunConfig, snapshot: RepositorySnapshot, stages: readonly StageDecision[], artifactId: string) {
  const conflict = (message: string) => Object.assign(new Error(message), { statusCode: 409 });
  const decision = stages.find(({ stage }) => stage === "requirements");
  if (decision?.decision !== "reuse") throw conflict(`REPLAY_REQUIREMENTS_CONTRACT_INCOMPATIBLE:${decision?.reasons.join(",") ?? "stage_absent"}`);
  const pin = await storedProtocolPin(source, "feature-requirements");
  if (pin === null) throw conflict("REPLAY_REQUIREMENTS_ARTIFACT_MISSING:protocol");
  const sourceSettings = featureExecutionSchema.parse(sourceConfig.workflow["feature"]);
  const settings = featureExecutionSchema.parse(config.workflow["feature"]);
  const readOnly = { async generate(): Promise<never> { throw new Error("REQUIREMENTS_READ_CANNOT_GENERATE"); } };
  let current;
  try { current = await new RequirementsCheckpoint(source, { mode: sourceSettings.mode, protocolVersion: pin.protocolVersion, protocolHash: pin.protocolHash, runtime: readOnly }).current(); }
  catch { throw conflict("REPLAY_REQUIREMENTS_ARTIFACT_MISSING:contract"); }
  if (current === null) throw conflict("REPLAY_REQUIREMENTS_CONTRACT_ABSENT");
  if (current.artifactId !== artifactId) throw conflict("REPLAY_REQUIREMENTS_CONTRACT_STALE");
  if (current.pendingAmbiguityIds.length > 0) throw conflict("REPLAY_REQUIREMENTS_NOT_APPROVED");
  // The same input identity the checkpoint itself enforces when it is opened.
  const repositorySummary = { fileCount: snapshot.files.length, snapshotDigest: snapshotDigest(snapshot), modelProfileId: settings.roles.requirements };
  const inputFingerprint = createHash("sha256").update(canonicalJson({ featureRequest: settings.request, repositorySummary, mode: settings.mode })).digest("hex");
  if (inputFingerprint !== current.inputFingerprint) throw conflict("REPLAY_REQUIREMENTS_CONTRACT_INCOMPATIBLE:input_changed");
  const artifacts = await source.listArtifacts();
  const read = async (kind: string): Promise<unknown> => {
    const descriptor = artifacts.find((item) => item.kind === kind);
    if (descriptor === undefined) throw conflict(`REPLAY_REQUIREMENTS_ARTIFACT_MISSING:${kind}`);
    try { return await source.artifacts.get<unknown>(descriptor.ref); }
    catch { throw conflict(`REPLAY_REQUIREMENTS_ARTIFACT_MISSING:${kind}`); }
  };
  const copies: { kind: string; value: unknown }[] = [];
  let next: string | null = current.artifactId;
  for (let depth = 0; next !== null; depth += 1) {
    const id: string = next;
    const version = artifacts.find((item) => item.artifactId === id);
    if (depth > 64 || version === undefined || !version.kind.startsWith("requirements-contract-version-")) throw conflict("REPLAY_REQUIREMENTS_LINEAGE_INVALID");
    const lineageKind = version.kind.replace("requirements-contract-version-", "requirements-contract-lineage-");
    const lineage = await read(lineageKind) as { artifactId?: unknown; parentArtifactId?: unknown };
    if (lineage.artifactId !== id || (lineage.parentArtifactId !== null && typeof lineage.parentArtifactId !== "string")) throw conflict("REPLAY_REQUIREMENTS_LINEAGE_INVALID");
    copies.unshift({ kind: version.kind, value: await read(version.kind) }, { kind: lineageKind, value: lineage });
    next = lineage.parentArtifactId as string | null;
  }
  const ledger = artifacts.some(({ kind }) => kind === "feature-requirements-revisions") ? await read("feature-requirements-revisions") : undefined;
  const approvedArtifactId = current.artifactId;
  return {
    async copyTo(store: RunStore): Promise<void> {
      for (const { kind, value } of copies) await store.publish(kind, value, "requirements");
      if (ledger !== undefined) await store.publish("feature-requirements-revisions", ledger, "feature");
      await store.publish("requirements-checkpoint-head", { artifactId: approvedArtifactId, inputFingerprint, protocolVersion: pin.protocolVersion, protocolHash: pin.protocolHash }, "requirements");
      const head = await new RequirementsCheckpoint(store, { mode: settings.mode, protocolVersion: pin.protocolVersion, protocolHash: pin.protocolHash, runtime: readOnly }).current();
      if (head?.artifactId !== approvedArtifactId || head.pendingAmbiguityIds.length > 0) throw new Error("REPLAY_REQUIREMENTS_COPY_MISMATCH");
      await store.publish("replay-requirements", { sourceRunId: source.runId, artifactId: approvedArtifactId, copiedArtifactKinds: copies.map(({ kind }) => kind) }, "requirements");
    },
  };
}
