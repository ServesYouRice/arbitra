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
import { AUDIT_DEEP_GRAPH, auditorIdsFor, graphForPreset, PRESET_GRAPHS, withCritic } from "./graphs.js";
import { canonicalise, converge, critique, discover, plan, preflight, readStage, verify, type AuditContext, type ConvergenceResult, type Plan } from "./pipeline.js";
import { snapshotRepository, type RepositorySnapshot } from "./repository.js";
import { listRunIds, RunStore, type ArtifactDescriptor, type StoredRunContext } from "./run-store.js";
import { ModelAuditPipeline, validateModelAudit } from "./model-pipeline.js";
import type { TestSandbox } from "./test-sandbox.js";
import type { TransportFactoryOptions } from "@arbitra/providers/registry.js";
import type { PlanIR } from "@arbitra/schemas/plan.js";
import { loadActivityTraces } from "@arbitra/persistence/trace.js";
import { traceEntry, tracePage } from "./trace-browser.js";
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
    const graph = this.#assertRunnable(validated);
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

  /** Start a run and return as soon as it is created; it continues in the background. */
  async start(config: RunConfig, repository = this.repository): Promise<RunResource> {
    const validated = this.configurations.validate(config);
    const graph = this.#assertRunnable(validated);
    const runId = this.#newRunId();
    const store = new RunStore(this.#runsDirectory, runId);
    const selectedRepository = resolve(repository);
    const snapshot = await snapshotRepository(selectedRepository, 400, { scope: validated.scope, ...testingSnapshotOptions(validated) });
    const modelConfiguration = Object.keys(validated.models).length > 0 ? validated : undefined;
    const checkpointPolicy = checkpointPolicyOf(validated);
    const storedContext: StoredRunContext = Object.freeze({ repository: selectedRepository, repositoryDigest: snapshotDigest(snapshot), scope: validated.scope, consensusPolicy: validated.consensusPolicy, maximumRounds: validated.maxConsensusRounds, criticEnabled: graph.nodes.some(({ id }) => id === "critic"), ...(modelConfiguration === undefined ? {} : { modelConfiguration }), ...(checkpointPolicy === undefined ? {} : { checkpointPolicy }) });
    await store.saveContext(storedContext);
    const context: AuditContext = Object.freeze({
      snapshot,
      store,
      auditors: auditorsFor(graph, modelConfiguration),
      auditorKind: modelConfiguration === undefined ? "scripted_auditors" : "model_auditors",
      policy: Object.freeze({ name: storedContext.consensusPolicy, quorum: 2, minimumIndependentGroupsForHighRisk: 2 }),
      maximumRounds: storedContext.maximumRounds,
      criticEnabled: storedContext.criticEnabled,
    });
    const handle = this.#runner(store, context, undefined, modelConfiguration, checkpointPolicy).start(graph, { runId });
    this.#track(runId, handle);
    return Object.freeze({ runId, state: handle.state, resumable: true, checkpoints: Object.freeze([]), preservedArtifacts: 0 });
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

  /** Reuse durable discovery findings, then rerun the downstream workflow under new policy. */
  async replay(sourceRunId: string, overrides: ReplayOverrides): Promise<{ readonly runId: string; readonly state: RunState }> {
    if (this.#live.has(sourceRunId) || this.#resuming.has(sourceRunId)) throw new Error(`REPLAY_SOURCE_RUNNING:${sourceRunId}`);
    await this.status(sourceRunId);
    const source = new RunStore(this.#runsDirectory, sourceRunId);
    const original = await source.loadContext();
    if (original.modelConfiguration?.mode === "feature") throw new Error("FEATURE_AUDIT_REPLAY_NOT_SUPPORTED");
    if (original.modelConfiguration?.mode === "testing") throw new Error("TESTING_AUDIT_REPLAY_NOT_SUPPORTED");
    const snapshot = await snapshotRepository(original.repository, 400, { scope: original.scope });
    if (snapshotDigest(snapshot) !== original.repositoryDigest) throw new Error(`RUN_REPOSITORY_CHANGED:${sourceRunId}`);
    const definition = await source.definitions().load(sourceRunId);
    const replayGraph = withCritic(definition.graph, overrides.criticEnabled);
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
    return Object.freeze({ runId, state: await handle.result });
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
    const reused = sourceStore === undefined ? undefined : Object.fromEntries(await Promise.all(context.auditors.map(async ({ auditorId }) => [auditorId, await readStage<readonly AuditFinding[]>(sourceStore, `findings-${auditorId}`)] as const)));
    const handle = this.#runner(store, context, reused, storedContext.modelConfiguration, storedContext.checkpointPolicy).resume(runId);
    this.#track(runId, handle);
    return Object.freeze({ runId, state: handle.state, resumable: true, checkpoints: Object.freeze([]), preservedArtifacts: (await store.listArtifacts()).length });
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
    if (state === "BLOCKED" && workflow?.id === "feature-simple") {
      const current = await this.requirements(runId);
      if (current !== null) checkpoints.push({ artifactId: current.artifactId, kind: "requirements", pendingAmbiguityIds: current.pendingAmbiguityIds,
        ...(current.revisionProposal === undefined ? {} : { revisionProposalArtifactId: current.revisionProposal.artifactId }) });
    }
    const policy = last === undefined ? undefined : (await store.loadContext()).checkpointPolicy;
    if (workflow !== undefined) checkpoints.push(...await this.#checkpoints(store, policy).list(workflow));
    return Object.freeze({ runId, state, resumable: state !== "COMPLETED", checkpoints: Object.freeze(checkpoints), ...(policy === undefined ? {} : { checkpointMode: policy.mode }), preservedArtifacts: (await store.listArtifacts()).length, ...(workflow === undefined ? {} : { workflow }) });
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

  #assertRunnable(config: RunConfig): RunnerGraph {
    assertRuntimeConfiguration(config, this.#graphs);
    const graph = graphForConfiguration(config, this.#graphs);
    validateGraphCheckpoints(graph, checkpointPolicyOf(config), this.#gatePolicies);
    return graph;
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
    try { await new RunStore(this.#runsDirectory, runId).loadContext(); }
    catch (error) {
      if (error instanceof Error && error.message === `RUN_CONTEXT_ABSENT:${runId}`) throw Object.assign(error, { statusCode: 404 });
      throw error;
    }
    return loadActivityTraces(this.#runsDirectory, runId);
  }

  async traces(runId: string, query: unknown = {}) { return tracePage(await this.modelTraces(runId), query); }

  async trace(runId: string, traceId: string) { return traceEntry(await this.modelTraces(runId), traceId); }

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
      return { runId, mode: "testing", outcome, execution, artifacts: descriptors.length };
    }
    if ((await store.loadContext()).modelConfiguration?.mode === "feature") {
      const outcome = descriptors.some(({ kind }) => kind === "feature-outcome") ? await readStage<FeatureOutcome>(store, "feature-outcome") : null;
      return { runId, mode: "feature", outcome, requirements: await this.requirements(runId), artifacts: descriptors.length };
    }
    const issues = descriptors.find(({ kind }) => kind === "canonical-issues");
    if (issues === undefined) return Object.freeze({ runId, issues: null, artifacts: descriptors.length });
    const parsed = JSON.parse((await store.readArtifact(issues.artifactId)).content) as {
      summary: { auditorCount: number; sourceFindingCount: number; acceptedCount: number; rejectedCount: number; unresolvedCount: number; singleSourceCount: number };
      coverage: { complete: boolean };
      limitations: readonly string[];
    };
    return Object.freeze({ runId, ...parsed.summary, coverageComplete: parsed.coverage.complete, limitations: parsed.limitations, artifacts: descriptors.length });
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

  #runner(store: RunStore, context: AuditContext, reusedFindings: Readonly<Record<string, readonly AuditFinding[]>> | undefined, modelConfiguration: RunConfig | undefined, checkpointPolicy: CheckpointPolicy | undefined): WorkflowRunner {
    // Every mode gets the same generic gate/human executors; none has an implicit pass.
    const checkpoints = this.#checkpoints(store, checkpointPolicy).executors();
    if (modelConfiguration?.mode === "testing") {
      const testing = new TestingPipeline(store, this.configurations.validate(modelConfiguration), context.snapshot, this.#providerOptions, this.#testSandbox);
      return new WorkflowRunner({ journal: store.journalPort(), artifacts: store.artifacts, definitions: store.definitions(), loadRecords: () => store.loadRecords(), executors: {
        deterministic: async ({ node }) => {
          if (node.id === "render") return testing.render();
          const result = { mode: "testing", fileCount: context.snapshot.files.length, readOnly: true, testsExecuted: false };
          await store.publish("preflight", result, "preflight"); return result;
        }, subgraph: ({ node, signal }) => node.id === "execute" ? testing.execute(signal) : testing.run(signal),
        ...checkpoints,
      } });
    }
    if (modelConfiguration?.mode === "feature") {
      const feature = new FeaturePipeline(store, this.configurations.validate(modelConfiguration), context.snapshot, this.#providerOptions);
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
    const models = modelConfiguration === undefined ? undefined : new ModelAuditPipeline(context, this.configurations.validate(modelConfiguration), this.#providerOptions, this.#testSandbox);
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
function assertRuntimeConfiguration(config: RunConfig, registered: Readonly<Record<string, RunnerGraph>>): void {
  if (config.harness.mode !== "canonical") throw new Error("RUNTIME_NATIVE_HARNESS_NOT_AVAILABLE");
  if (config.mode === "testing") { validateModelTesting(config); graphForConfiguration(config, registered); return; }
  if (config.mode === "feature") { validateModelFeature(config); graphForConfiguration(config, registered); return; }
  if (Object.keys(config.models).length > 0) {
    if (config.workflow["modelExecution"] === undefined) throw new Error("RUNTIME_MODEL_EXECUTION_CONFIGURATION_REQUIRED");
    const graph = graphForConfiguration(config, registered);
    validateModelAudit(config, auditorIdsFor(graph), graph.nodes.some(({ id }) => id === "critic"));
  }
  if (config.workflow["preset"] !== undefined && typeof config.workflow["preset"] !== "string") throw new Error("INVALID_WORKFLOW_PRESET");
  graphForConfiguration(config, registered);
}

function checkpointPolicyOf(config: RunConfig): CheckpointPolicy | undefined {
  const value = config.workflow["checkpoints"];
  return value === undefined ? undefined : checkpointPolicySchema.parse(value);
}

function graphForConfiguration(config: RunConfig, registered: Readonly<Record<string, RunnerGraph>>): RunnerGraph {
  if (config.workflow["preset"] !== undefined && typeof config.workflow["preset"] !== "string") throw new Error("INVALID_WORKFLOW_PRESET");
  const testingPreset = config.mode === "testing" && testingExecutionSchema.parse(config.workflow["testing"]).mode === "execute" ? "testing-execute" : "testing-plan";
  const preset = presetOf(config);
  const graph = preset !== undefined && Object.hasOwn(registered, preset) ? registered[preset] as RunnerGraph : graphForPreset(preset ?? (config.mode === "feature" ? "feature-simple" : config.mode === "testing" ? testingPreset : undefined));
  if ((graph.id === "feature-simple") !== (config.mode === "feature")) throw new Error("WORKFLOW_PRESET_MODE_MISMATCH");
  if ((graph.id === "testing-plan" || graph.id === "testing-execute") !== (config.mode === "testing") || config.mode === "testing" && graph.id !== testingPreset) throw new Error("WORKFLOW_PRESET_MODE_MISMATCH");
  return graph;
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
