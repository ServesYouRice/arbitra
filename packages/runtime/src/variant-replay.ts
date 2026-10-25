import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import type { TransportFactoryOptions } from "@arbitra/providers/registry.js";
import { runConfigSchema, type RunConfig } from "@arbitra/schemas/config.js";
import { auditorIdsFor } from "./graphs.js";
import { SNAPSHOT_IDENTITY_KIND, type SnapshotIdentity } from "./incremental-audit.js";
import { ModelAuditPipeline } from "./model-pipeline.js";
import { readStage } from "./pipeline.js";
import { assertNoPreflightErrors, configurationDiagnostics } from "./preflight.js";
import { SNAPSHOT_FILE_LIMIT, snapshotRepository, type RepositorySnapshot } from "./repository.js";
import { RunStore } from "./run-store.js";

/** The profile a replay adds when it is given a searcher the source configuration does not have. */
const ADDED_SEARCHER = "variant-searcher";

/** The stages the variant search reads, copied from the source run; a run that searched already gives its starting point. */
const COPIED_STAGES = ["variant-search-base", "canonical-issues", "source-findings", "verification-results", "verification-operations"] as const;

export interface VariantReplayOptions {
  /** The finished Audit's run directory (the folder named after its run ID). It is only read. */
  readonly source: string;
  /** The folder the replay's own run store is created in. */
  readonly output: string;
  /** The profile that searches; by default the source configuration's `roles.variantSearcher`. */
  readonly searcher?: string;
  /** A searcher the source did not have: a copy of one of its profiles, on the same endpoint, with another model
   * (Sonnet 5.5 on a Claude Code profile, say). It is added as `variant-searcher` and searches. */
  readonly searcherProfile?: { readonly copyOf: string; readonly modelId: string };
  /** The search's effort (`stageEffort.variantSearch`); by default the source's, else the depth's level. */
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** A configuration in place of the source's, such as one with a searcher profile the source did not have. */
  readonly configuration?: RunConfig;
  /** A checkout of the source's repository, when it is no longer where the run read it. */
  readonly repository?: string;
  readonly providerOptions?: TransportFactoryOptions;
  readonly runId?: string;
  readonly signal?: AbortSignal;
}

export interface VariantReplayResult { readonly runId: string; readonly directory: string; readonly summary: unknown }

/**
 * Runs only the variant search, and the verification of what it proposes, on a finished Audit's stored results, into a
 * store of its own: the measurement on the finished real runs before the search is offered on by default. The source
 * run is only read. The replay checks against the snapshot the source read: the repository is read again and must hold
 * the source's files with the same content. A run recorded by an earlier build may have read fewer files (the snapshot
 * has learnt more file types since), so the files it did not read are left out when the rest match. Verification
 * reuses the source's pinned protocols, so a variant is checked as the source's issues were.
 */
export async function replayVariantSearch(options: VariantReplayOptions): Promise<VariantReplayResult> {
  const sourceDirectory = resolve(options.source);
  const source = new RunStore(dirname(sourceDirectory), basename(sourceDirectory));
  const context = await source.loadContext();
  const original = context.modelConfiguration;
  if (original?.mode !== "audit") throw new Error("VARIANT_REPLAY_REQUIRES_MODEL_AUDIT");
  const artifacts = await source.listArtifacts();
  if (!artifacts.some(({ kind }) => kind === "canonical-issues")) throw new Error(`VARIANT_REPLAY_SOURCE_UNVERIFIED:${source.runId}: the run has no verified issue set to search from`);
  const chosen = options.configuration ?? original;
  const execution = (chosen.workflow["modelExecution"] ?? {}) as { roles?: Record<string, unknown>; modelEndpoints?: Record<string, string>; stageEffort?: Record<string, unknown> };
  const roles = execution.roles ?? {};
  const copy = options.searcherProfile;
  const template = copy === undefined ? undefined : chosen.models[copy.copyOf];
  if (copy !== undefined && template === undefined) throw new Error(`MODEL_PROFILE_REQUIRED:${copy.copyOf}`);
  const searcher = copy !== undefined ? ADDED_SEARCHER : options.searcher ?? (typeof roles["variantSearcher"] === "string" ? roles["variantSearcher"] : undefined);
  if (searcher === undefined) throw new Error("VARIANT_REPLAY_SEARCHER_REQUIRED: name the profile that searches");
  const config = runConfigSchema.parse({ ...chosen, ...(copy === undefined || template === undefined ? {} : { models: { ...chosen.models, [ADDED_SEARCHER]: { ...template, modelId: copy.modelId } } }),
    workflow: { ...chosen.workflow, variantSearch: true, modelExecution: { ...execution, roles: { ...roles, variantSearcher: searcher },
      ...(copy === undefined ? {} : { modelEndpoints: { ...execution.modelEndpoints, [ADDED_SEARCHER]: execution.modelEndpoints?.[copy.copyOf] } }),
      ...(options.effort === undefined ? {} : { stageEffort: { ...execution.stageEffort, variantSearch: options.effort } }) } } });
  assertNoPreflightErrors(configurationDiagnostics(config));
  const snapshot = await sourceSnapshot(source, options.repository ?? context.repository, context);
  const graph = (await source.definitions().load(source.runId)).graph;
  const auditors = auditorIdsFor(graph).map((auditorId) => {
    const profile = config.models[auditorId];
    if (profile === undefined) throw new Error(`MODEL_PROFILE_REQUIRED:${auditorId}`);
    return { auditorId, independenceGroup: profile.independenceGroup, ruleIds: [] };
  });
  const runId = options.runId ?? `run-${randomUUID()}`;
  const store = new RunStore(resolve(options.output), runId);
  await store.saveContext({ ...context, repository: snapshot.root, criticEnabled: false, modelConfiguration: config });
  const copied = [...COPIED_STAGES.filter((kind) => artifacts.some((artifact) => artifact.kind === kind)), ...artifacts.filter(({ kind }) => kind.startsWith("model-protocol-")).map(({ kind }) => kind)];
  for (const kind of copied) await store.publish(kind, await readStage(source, kind));
  await store.publish("variant-replay-source", { sourceRunId: source.runId, searcher, configurationReplaced: options.configuration !== undefined, copied, files: snapshot.files.length });
  const pipeline = new ModelAuditPipeline({ snapshot, store, auditors, auditorKind: "model_auditors", policy: { name: context.consensusPolicy, quorum: 2, minimumIndependentGroupsForHighRisk: 2 },
    maximumRounds: context.maximumRounds, criticEnabled: false, variantSearchEnabled: true }, config, options.providerOptions);
  try { await pipeline.searchVariants(options.signal ?? new AbortController().signal); }
  finally { await pipeline.close(); }
  return { runId, directory: store.directory, summary: await readStage(store, "variant-search") };
}

/** The snapshot the source run read, read again: the whole repository when it matches, else the source's files when they do. */
async function sourceSnapshot(source: RunStore, repository: string, context: { readonly repositoryDigest: string; readonly scope: RunConfig["scope"] }): Promise<RepositorySnapshot> {
  const snapshot = await snapshotRepository(resolve(repository), SNAPSHOT_FILE_LIMIT, { scope: context.scope });
  // As the orchestrator records a run's repository.
  const digest = (files: RepositorySnapshot["files"]) => createHash("sha256").update(JSON.stringify(files)).digest("hex");
  if (digest(snapshot.files) === context.repositoryDigest) return snapshot;
  const identity = (await source.listArtifacts()).some(({ kind }) => kind === SNAPSHOT_IDENTITY_KIND) ? await readStage<SnapshotIdentity>(source, SNAPSHOT_IDENTITY_KIND) : undefined;
  const read = identity === undefined ? undefined : snapshot.files.filter(({ path }) => Object.hasOwn(identity.files, path));
  if (identity !== undefined && read !== undefined && digest(read) === context.repositoryDigest) return { ...snapshot, files: read };
  // As the snapshot identity hashes a file.
  const changed = identity === undefined ? [] : Object.keys(identity.files).filter((path) => { const file = snapshot.files.find((entry) => entry.path === path); return file === undefined || createHash("sha256").update(file.lines.join("\n")).digest("hex") !== identity.files[path]; });
  throw new Error(`RUN_REPOSITORY_CHANGED:${source.runId}: the repository no longer holds the files the run read${changed.length === 0 ? "" : ` (${changed.slice(0, 10).join(", ")}${changed.length > 10 ? ` and ${changed.length - 10} more` : ""})`}${identity?.gitHead == null ? "" : `; check out ${identity.gitHead} and pass it as the repository`}`);
}
