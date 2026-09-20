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
import { AUDIT_DEEP_GRAPH, auditorIdsFor, graphForPreset, withCritic } from "./graphs.js";
import { canonicalise, converge, critique, discover, plan, preflight, readStage, verify, type AuditContext, type ConvergenceResult, type Plan } from "./pipeline.js";
import { snapshotRepository, type RepositorySnapshot } from "./repository.js";
import { listRunIds, RunStore, type ArtifactDescriptor, type StoredRunContext } from "./run-store.js";
import { ModelAuditPipeline, validateModelAudit } from "./model-pipeline.js";
import type { TransportFactoryOptions } from "@arbitra/providers/registry.js";
import type { PlanIR } from "@arbitra/schemas/plan.js";
import { loadActivityTraces } from "@arbitra/persistence/trace.js";
import { evaluationMetrics } from "./evaluation-metrics.js";

export interface OrchestratorOptions {
  /** Where runs and saved configurations live. Defaults to `<repository>/.runs`. */
  readonly stateDirectory?: string;
  readonly repository?: string;
  readonly newRunId?: () => string;
  readonly providerOptions?: TransportFactoryOptions;
}

export interface RunResource {
  readonly runId: string;
  readonly state: string;
  readonly resumable: boolean;
  readonly checkpoints: readonly never[];
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

  constructor(options: OrchestratorOptions = {}) {
    this.repository = resolve(options.repository ?? process.cwd());
    const state = resolve(options.stateDirectory ?? resolve(this.repository, ".runs"));
    this.#runsDirectory = resolve(state, "runs");
    this.configurations = new ConfigStore<RunConfig>(resolve(state, "configurations"), runConfigSchema);
    // arbitra-determinism: allow -- run identity is minted at the composition boundary
    this.#newRunId = options.newRunId ?? ((): string => `run-${randomUUID()}`);
    this.#providerOptions = options.providerOptions ?? {};
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
    assertRuntimeConfiguration(validated);
    const snapshot = await snapshotRepository(resolve(repository), 400, { scope: validated.scope });
    const graph = graphForPreset(presetOf(validated));
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
    assertRuntimeConfiguration(validated);
    const runId = this.#newRunId();
    const store = new RunStore(this.#runsDirectory, runId);
    const selectedRepository = resolve(repository);
    const snapshot = await snapshotRepository(selectedRepository, 400, { scope: validated.scope });
    const graph = graphForPreset(presetOf(validated));
    const modelConfiguration = Object.keys(validated.models).length > 0 ? validated : undefined;
    const storedContext: StoredRunContext = Object.freeze({ repository: selectedRepository, repositoryDigest: snapshotDigest(snapshot), scope: validated.scope, consensusPolicy: validated.consensusPolicy, maximumRounds: validated.maxConsensusRounds, criticEnabled: graph.nodes.some(({ id }) => id === "critic"), ...(modelConfiguration === undefined ? {} : { modelConfiguration }) });
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
    const handle = this.#runner(store, context, undefined, modelConfiguration).start(graph, { runId });
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
    const snapshot = await snapshotRepository(original.repository, 400, { scope: original.scope });
    if (snapshotDigest(snapshot) !== original.repositoryDigest) throw new Error(`RUN_REPOSITORY_CHANGED:${sourceRunId}`);
    const definition = await source.definitions().load(sourceRunId);
    const replayGraph = withCritic(definition.graph, overrides.criticEnabled);
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
    const handle = this.#runner(store, context, findings, original.modelConfiguration).start(replayGraph, { ...definition.config, runId });
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
    const snapshot = await snapshotRepository(storedContext.repository, 400, { scope: storedContext.scope });
    if (snapshotDigest(snapshot) !== storedContext.repositoryDigest) throw new Error(`RUN_REPOSITORY_CHANGED:${runId}`);
    const definition = await store.definitions().load(runId);
    const context: AuditContext = Object.freeze({
      snapshot, store, auditors: auditorsFor(definition.graph, storedContext.modelConfiguration),
      auditorKind: storedContext.modelConfiguration === undefined ? "scripted_auditors" : "model_auditors",
      policy: Object.freeze({ name: storedContext.consensusPolicy, quorum: 2, minimumIndependentGroupsForHighRisk: 2 }),
      maximumRounds: storedContext.maximumRounds, criticEnabled: storedContext.criticEnabled,
    });
    const sourceStore = storedContext.replaySourceRunId === undefined ? undefined : new RunStore(this.#runsDirectory, storedContext.replaySourceRunId);
    const reused = sourceStore === undefined ? undefined : Object.fromEntries(await Promise.all(context.auditors.map(async ({ auditorId }) => [auditorId, await readStage<readonly AuditFinding[]>(sourceStore, `findings-${auditorId}`)] as const)));
    const handle = this.#runner(store, context, reused, storedContext.modelConfiguration).resume(runId);
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
    return Object.freeze({ runId, state, resumable: state !== "COMPLETED", checkpoints: Object.freeze([]), preservedArtifacts: (await store.listArtifacts()).length, ...(workflow === undefined ? {} : { workflow }) });
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
    await new RunStore(this.#runsDirectory, runId).loadContext();
    return loadActivityTraces(this.#runsDirectory, runId);
  }

  async metrics(runId: string) {
    return evaluationMetrics(new RunStore(this.#runsDirectory, runId), await this.modelTraces(runId));
  }

  /** The shape both `report` and the CLI's human output read. */
  async summary(runId: string): Promise<unknown> {
    const store = new RunStore(this.#runsDirectory, runId);
    const descriptors = await store.listArtifacts();
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
    const summary = await this.summary(runId) as { issues?: null; unresolvedCount?: number; coverageComplete?: boolean };
    // A run that produced no canonical issue set established no trustworthy result, so it
    // fails rather than passing on the absence of anything to object to.
    if (summary.issues === null) return Object.freeze({ gateStatus: "failed", reasons: Object.freeze(["no_canonical_issue_set"]) });
    const reasons = [
      ...((await this.status(runId)).state !== "COMPLETED" ? ["run_not_completed"] : []),
      ...(summary.unresolvedCount !== undefined && summary.unresolvedCount > 0 ? ["unresolved_issues"] : []),
      ...(summary.coverageComplete === false ? ["degraded_coverage"] : []),
    ];
    const store = new RunStore(this.#runsDirectory, runId);
    const artifacts = await store.listArtifacts();
    if (artifacts.some(({ kind }) => kind === "critic-feedback")) {
      const feedback = await readStage<{ items: readonly { blocking: boolean }[] }>(store, "critic-feedback");
      if (feedback.items.some(({ blocking }) => blocking)) reasons.push("blocking_critic_feedback");
    }
    if (artifacts.some(({ kind }) => kind === "critic-result")) {
      const review = await readStage<{ degradedReviewCoverage: boolean }>(store, "critic-result");
      if (review.degradedReviewCoverage) reasons.push("degraded_critic_coverage");
    }
    return Object.freeze({ gateStatus: reasons.length === 0 ? "passed" : "failed", reasons: Object.freeze(reasons) });
  }

  #runner(store: RunStore, context: AuditContext, reusedFindings?: Readonly<Record<string, readonly AuditFinding[]>>, modelConfiguration?: RunConfig): WorkflowRunner {
    const models = modelConfiguration === undefined ? undefined : new ModelAuditPipeline(context, this.configurations.validate(modelConfiguration), this.#providerOptions);
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
        gate: async () => ({ passed: true }),
        human: async () => ({ acknowledged: true }),
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
function assertRuntimeConfiguration(config: RunConfig): void {
  if (config.mode !== "audit") throw new Error(`RUNTIME_MODE_NOT_AVAILABLE:${config.mode}`);
  if (config.harness.mode !== "canonical") throw new Error("RUNTIME_NATIVE_HARNESS_NOT_AVAILABLE");
  if (Object.keys(config.models).length > 0) {
    if (config.workflow["modelExecution"] === undefined) throw new Error("RUNTIME_MODEL_EXECUTION_CONFIGURATION_REQUIRED");
    const graph = graphForPreset(presetOf(config));
    validateModelAudit(config, auditorIdsFor(graph), graph.nodes.some(({ id }) => id === "critic"));
  }
  if (config.workflow["preset"] !== undefined && typeof config.workflow["preset"] !== "string") throw new Error("INVALID_WORKFLOW_PRESET");
  graphForPreset(presetOf(config));
}

function snapshotDigest(snapshot: RepositorySnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot.files)).digest("hex");
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
