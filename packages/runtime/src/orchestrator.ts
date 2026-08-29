import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { ConfigStore } from "@arbitra/core/config/config-store.js";
import type { NodeExecutionContext, RunnerGraph, RunHandle } from "@arbitra/core/runner/workflow-runner.js";
import { WorkflowRunner } from "@arbitra/core/runner/workflow-runner.js";
import type { RunEvent, RunState } from "@arbitra/core/runner/events.js";
import { runConfigSchema, type RunConfig } from "@arbitra/schemas/config.js";
import { DEFAULT_AUDITORS, type AuditFinding } from "./auditors.js";
import type { CanonicalIssueSet } from "@arbitra/workflow/nodes/canonical-issues.js";
import { AUDIT_DEEP_GRAPH, graphForPreset } from "./graphs.js";
import { canonicalise, converge, critique, discover, plan, preflight, readStage, verify, type AuditContext, type ConvergenceResult, type Plan } from "./pipeline.js";
import { snapshotRepository } from "./repository.js";
import { listRunIds, RunStore, type ArtifactDescriptor } from "./run-store.js";

export interface OrchestratorOptions {
  /** Where runs and saved configurations live. Defaults to `<repository>/.runs`. */
  readonly stateDirectory?: string;
  readonly repository?: string;
  readonly newRunId?: () => string;
}

export interface RunResource {
  readonly runId: string;
  readonly state: string;
  readonly resumable: boolean;
  readonly checkpoints: readonly never[];
  readonly preservedArtifacts: number;
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

  constructor(options: OrchestratorOptions = {}) {
    this.repository = resolve(options.repository ?? process.cwd());
    const state = resolve(options.stateDirectory ?? resolve(this.repository, ".runs"));
    this.#runsDirectory = resolve(state, "runs");
    this.configurations = new ConfigStore<RunConfig>(resolve(state, "configurations"), runConfigSchema);
    // arbitra-determinism: allow -- run identity is minted at the composition boundary
    this.#newRunId = options.newRunId ?? ((): string => `run-${randomUUID()}`);
  }

  validate(value: unknown): { readonly valid: boolean; readonly errors?: readonly string[] } {
    const parsed = runConfigSchema.safeParse(value);
    return parsed.success ? { valid: true } : { valid: false, errors: parsed.error.issues.map(({ path, message }) => `${path.join(".") || "$"}: ${message}`) };
  }

  /**
   * A pre-flight cost estimate. Scripted auditors make no provider calls, so the estimate
   * reports zero spend and says why, rather than inventing a number.
   */
  async estimate(config: RunConfig): Promise<unknown> {
    const snapshot = await snapshotRepository(this.repository);
    const graph = graphForPreset(presetOf(config));
    return Object.freeze({
      estimate: Object.freeze({
        files: snapshot.files.length,
        lines: snapshot.files.reduce((total, file) => total + file.lines.length, 0),
        nodes: graph.nodes.length,
        auditors: DEFAULT_AUDITORS.length,
        providerCalls: 0,
        costUsd: 0,
        currency: null,
        basis: "scripted_auditors_make_no_provider_calls",
      }),
      gate: "clear",
    });
  }

  /** Start a run and return as soon as it is created; it continues in the background. */
  async start(config: RunConfig): Promise<RunResource> {
    const runId = this.#newRunId();
    const store = new RunStore(this.#runsDirectory, runId);
    const snapshot = await snapshotRepository(this.repository);
    const context: AuditContext = Object.freeze({
      snapshot,
      store,
      auditors: DEFAULT_AUDITORS,
      policy: Object.freeze({ name: config.consensusPolicy, quorum: 2, minimumIndependentGroupsForHighRisk: 2 }),
      maximumRounds: config.maxConsensusRounds,
      criticEnabled: true,
    });
    const handle = this.#runner(store, context).start(graphForPreset(presetOf(config)), { runId });
    this.#live.set(runId, handle);
    void handle.result.catch(() => undefined);
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

  async resume(runId: string): Promise<RunResource> {
    const store = new RunStore(this.#runsDirectory, runId);
    const snapshot = await snapshotRepository(this.repository);
    const context: AuditContext = Object.freeze({
      snapshot, store, auditors: DEFAULT_AUDITORS,
      policy: Object.freeze({ name: "risk_weighted" as const, quorum: 2, minimumIndependentGroupsForHighRisk: 2 }),
      maximumRounds: 2, criticEnabled: true,
    });
    const handle = this.#runner(store, context).resume(runId);
    this.#live.set(runId, handle);
    void handle.result.catch(() => undefined);
    return Object.freeze({ runId, state: handle.state, resumable: true, checkpoints: Object.freeze([]), preservedArtifacts: (await store.listArtifacts()).length });
  }

  async status(runId: string): Promise<RunResource> {
    const live = this.#live.get(runId);
    const store = new RunStore(this.#runsDirectory, runId);
    const events = await store.loadEvents();
    const last = [...events].reverse().find((event): event is Extract<RunEvent, { t: "run_transition" }> => event.t === "run_transition");
    const state = live?.state ?? last?.state ?? "CREATED";
    if (last === undefined && live === undefined) throw new Error(`RUN_ABSENT:${runId}`);
    return Object.freeze({ runId, state, resumable: state !== "COMPLETED", checkpoints: Object.freeze([]), preservedArtifacts: (await store.listArtifacts()).length });
  }

  cancel(runId: string): RunResource {
    const handle = this.#live.get(runId);
    handle?.cancel("cancelled_by_operator");
    return Object.freeze({ runId, state: handle?.state ?? "CANCELLED", resumable: true, checkpoints: Object.freeze([]), preservedArtifacts: 0 });
  }

  /**
   * The SSE feed. A live run streams from the runner; a finished one replays its recorded
   * events so a late subscriber sees the same history rather than an empty stream.
   */
  async *events(runId: string): AsyncIterable<RunEvent> {
    const store = new RunStore(this.#runsDirectory, runId);
    for (const event of await store.loadEvents()) yield event;
    const live = this.#live.get(runId);
    if (live === undefined) return;
    const seen = new Set((await store.loadEvents()).map((event) => JSON.stringify(event)));
    for await (const event of live.events) if (!seen.has(JSON.stringify(event))) yield event;
  }

  async artifacts(runId: string): Promise<readonly PublicArtifact[]> {
    return (await new RunStore(this.#runsDirectory, runId).listArtifacts()).map(withoutRef);
  }

  async artifact(runId: string, artifactId: string): Promise<unknown> {
    const { descriptor, content } = await new RunStore(this.#runsDirectory, runId).readArtifact(artifactId);
    return Object.freeze({ ...withoutRef(descriptor), content, truncated: false, continuationArtifactId: null });
  }

  async runIds(): Promise<readonly string[]> { return listRunIds(this.#runsDirectory); }

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
      ...(summary.unresolvedCount !== undefined && summary.unresolvedCount > 0 ? ["unresolved_issues"] : []),
      ...(summary.coverageComplete === false ? ["degraded_coverage"] : []),
    ];
    return Object.freeze({ gateStatus: reasons.length === 0 ? "passed" : "failed", reasons: Object.freeze(reasons) });
  }

  #runner(store: RunStore, context: AuditContext): WorkflowRunner {
    // Stages hand off through the artifact store rather than through closure state, so a
    // resumed run can start at any node with every earlier stage's output still readable.
    return new WorkflowRunner({
      journal: store.journalPort(),
      artifacts: store.artifacts,
      definitions: store.definitions(),
      loadRecords: () => store.loadRecords(),
      executors: {
        deterministic: async () => preflight(context),
        model: async ({ node }: NodeExecutionContext) => {
          if (node.id === "planner") {
            const produced = await plan(context, await readStage<CanonicalIssueSet>(store, "canonical-issues"));
            return { tasks: produced.tasks.length, acceptedIssues: produced.acceptedIssueIds.length };
          }
          if (node.id === "critic") {
            const reviewed = await critique(context, await readStage<Plan>(store, "plan-ir"), await readStage<CanonicalIssueSet>(store, "canonical-issues"));
            return { items: reviewed?.items.length ?? 0, blocking: reviewed?.items.filter(({ blocking }) => blocking).length ?? 0 };
          }
          const discovered = discover(context, node.id);
          await store.publish(`findings-${node.id}`, discovered, node.id);
          return { auditorId: node.id, findingCount: discovered.length };
        },
        loop: async () => {
          const convergence = await converge(context, await this.#collectFindings(store, context));
          return { candidates: convergence.consensus.candidates.length, accepted: convergence.consensus.candidates.filter(({ outcome }) => outcome === "accepted").length };
        },
        subgraph: async () => {
          const convergence = await readStage<ConvergenceResult>(store, "consensus-state");
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
