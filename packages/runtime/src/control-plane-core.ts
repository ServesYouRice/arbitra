import { queryActivityTraces } from "@arbitra/persistence/metrics/query.js";
import { protocolIdentity } from "@arbitra/persistence/index-db/rebuild.js";
import { CrossProtocolComparisonError } from "@arbitra/persistence/metrics/queries.js";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Orchestrator } from "./orchestrator.js";
import { withIncrementalBase } from "./incremental-audit.js";

/**
 * The server's port, satisfied by the same orchestrator the CLI uses.
 *
 * Route handlers stay thin on purpose: every decision below is the orchestrator's, so the
 * localhost UI and a CI invocation observe one run lifecycle, not two.
 */
export function controlPlaneCore(orchestrator: Orchestrator) {
  let selectedRepository = orchestrator.repository;
  const named = (body: unknown): { name: string; config: unknown } => {
    const value = body as { name?: unknown; config?: unknown } | undefined;
    if (typeof value?.name !== "string") throw new Error("CONFIGURATION_NAME_REQUIRED");
    return { name: value.name, config: value.config };
  };

  const configured = async (body: unknown): Promise<{ config: Awaited<ReturnType<Orchestrator["configurations"]["load"]>>["config"]; repository: string }> => {
    const request = body as { configurationId?: unknown; repository?: unknown; incremental?: unknown } | undefined;
    if (typeof request?.configurationId !== "string") throw new Error("CONFIGURATION_ID_REQUIRED");
    if (request.repository !== undefined && typeof request.repository !== "string") throw new Error("REPOSITORY_PATH_REQUIRED");
    const repository = request.repository === undefined ? selectedRepository : await repositoryPath(request.repository);
    // An explicit incremental request overrides the saved configuration's, exactly as the CLI flag does.
    return { config: withIncrementalBase((await orchestrator.configurations.load(request.configurationId)).config, request.incremental), repository };
  };

  return {
    configurations: {
      list: () => orchestrator.configurations.list(),
      save: async (body: unknown) => { const { name, config } = named(body); return orchestrator.configurations.save(name, config); },
      load: (id: string) => orchestrator.configurations.load(id),
      update: async (id: string, body: unknown) => { const { name, config } = named(body); return orchestrator.configurations.update(id, name, config); },
      duplicate: async (id: string, body: unknown) => orchestrator.configurations.duplicate(id, named({ ...(body as object), config: null }).name),
      validate: (body: unknown) => orchestrator.validate(body),
      export: async (id: string) => JSON.parse(await orchestrator.configurations.export(id)) as unknown,
    },

    repositories: {
      // The control plane is localhost-only and read-only, so selecting a repository just
      // records the path the operator named; it never writes to it.
      select: async (body: unknown) => {
        const path = (body as { path?: unknown } | undefined)?.path;
        selectedRepository = await repositoryPath(path);
        return Object.freeze({ repository: selectedRepository, selected: true });
      },
    },

    runs: {
      estimate: async (body: unknown) => { const request = await configured(body); return orchestrator.estimate(request.config, request.repository); },
      start: async (body: unknown) => { const request = await configured(body); return orchestrator.start(request.config, request.repository); },
      status: (id: string) => orchestrator.status(id),
      resume: (id: string) => orchestrator.resume(id),
      events: (id: string) => orchestrator.events(id),
      cancel: async (id: string) => orchestrator.cancel(id),
      respondCheckpoint: (id: string, checkpointId: string, body: unknown) => orchestrator.respondCheckpoint(id, checkpointId, body),
      artifacts: (id: string) => orchestrator.artifacts(id),
      artifact: (id: string, artifactId: string) => orchestrator.artifact(id, artifactId),
    },

    traces: {
      list: (runId: string, query: unknown) => orchestrator.traces(runId, query),
      detail: (runId: string, traceId: string) => orchestrator.trace(runId, traceId),
      artifact: (runId: string, traceId: string, slot: string) => orchestrator.traceArtifact(runId, traceId, slot),
    },

    incremental: {
      report: (runId: string) => orchestrator.incrementalReport(runId),
    },

    replay: {
      // Returns once the new run exists, like `runs.start`; progress streams from its own events.
      start: (sourceRunId: string, body: unknown) => orchestrator.startReplay(sourceRunId, body),
      report: async (runId: string) => {
        const report = await orchestrator.replayReport(runId);
        if (report === null) throw Object.assign(new Error(`REPLAY_CONTRACT_ABSENT:${runId}`), { statusCode: 404 });
        return report;
      },
    },

    requirements: {
      current: (runId: string) => orchestrator.requirements(runId),
      approve: (runId: string, body: unknown) => orchestrator.approveRequirements(runId, body),
      revise: (runId: string, artifactId: string, draft: unknown) => orchestrator.reviseRequirements(runId, artifactId, draft),
      applyRevision: (runId: string, artifactId: string) => orchestrator.applyRequirementsRevision(runId, artifactId),
    },

    testing: {
      view: (runId: string) => orchestrator.testing(runId),
      changeSet: (runId: string) => orchestrator.testingChangeSet(runId),
    },

    evaluation: {
      metrics: (runId: string) => orchestrator.metrics(runId),
      compare: async (request: { readonly a: unknown; readonly b: unknown }) => {
        const side = (value: unknown) => {
          const input = value as { protocolIdentity?: unknown; runIds?: unknown } | null;
          if (typeof input?.protocolIdentity !== "string" || input.protocolIdentity.trim() === "") throw new Error("COMPARISON_SIDE_REQUIRES_PROTOCOL_IDENTITY");
          if (input.runIds !== undefined && (!Array.isArray(input.runIds) || input.runIds.some((id: unknown) => typeof id !== "string" || id === ""))) throw new Error("INVALID_COMPARISON_RUN_IDS");
          return { protocolIdentity: input.protocolIdentity, runIds: input.runIds as string[] | undefined };
        };
        const a = side(request.a); const b = side(request.b);
        if (a.protocolIdentity !== b.protocolIdentity) throw new CrossProtocolComparisonError(a.protocolIdentity, b.protocolIdentity);
        const sides = [];
        for (const selected of [a, b]) {
          const ids = selected.runIds ?? await orchestrator.runIds();
          const traces = (await Promise.all([...new Set(ids)].map((id) => orchestrator.modelTraces(id)))).flat().filter((trace) => protocolIdentity(trace) === selected.protocolIdentity);
          if (traces.length === 0) return { comparable: false, error: "NO_MATCHING_PROVIDER_ACTIVITY", message: "A comparison side has no recorded activity for the exact protocol identity and selected runs." };
          sides.push({ protocolIdentity: selected.protocolIdentity, rows: queryActivityTraces(traces, { groupBy: ["model", "harness", "protocol"] }) });
        }
        return { comparable: true, protocolIdentity: a.protocolIdentity, sides };
      },
    },
  };
}

async function repositoryPath(value: unknown): Promise<string> {
  if (typeof value !== "string" || value.trim() === "") throw new Error("REPOSITORY_PATH_REQUIRED");
  const path = resolve(value);
  if (!(await stat(path)).isDirectory()) throw new Error(`REPOSITORY_NOT_DIRECTORY:${path}`);
  return realpath(path);
}
