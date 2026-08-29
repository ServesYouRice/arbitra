import { resolve } from "node:path";
import type { Orchestrator } from "./orchestrator.js";

/**
 * The server's port, satisfied by the same orchestrator the CLI uses.
 *
 * Route handlers stay thin on purpose: every decision below is the orchestrator's, so the
 * localhost UI and a CI invocation observe one run lifecycle, not two.
 */
export function controlPlaneCore(orchestrator: Orchestrator) {
  const named = (body: unknown): { name: string; config: unknown } => {
    const value = body as { name?: unknown; config?: unknown } | undefined;
    if (typeof value?.name !== "string") throw new Error("CONFIGURATION_NAME_REQUIRED");
    return { name: value.name, config: value.config };
  };

  const configured = async (body: unknown): Promise<Awaited<ReturnType<Orchestrator["configurations"]["load"]>>["config"]> => {
    const request = body as { configurationId?: unknown } | undefined;
    if (typeof request?.configurationId !== "string") throw new Error("CONFIGURATION_ID_REQUIRED");
    return (await orchestrator.configurations.load(request.configurationId)).config;
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
        if (typeof path !== "string") throw new Error("REPOSITORY_PATH_REQUIRED");
        return Object.freeze({ repository: resolve(path), selected: true });
      },
    },

    runs: {
      estimate: async (body: unknown) => orchestrator.estimate(await configured(body)),
      start: async (body: unknown) => orchestrator.start(await configured(body)),
      status: (id: string) => orchestrator.status(id),
      resume: (id: string) => orchestrator.resume(id),
      events: (id: string) => orchestrator.events(id),
      cancel: async (id: string) => orchestrator.cancel(id),
      artifacts: (id: string) => orchestrator.artifacts(id),
      artifact: (id: string, artifactId: string) => orchestrator.artifact(id, artifactId),
    },

    /**
     * Evaluation.
     *
     * The guarded query layer reads model activity traces out of a per-run SQLite index.
     * A scripted-auditor run makes no provider calls, so it records no traces and there is
     * no index to query: rather than hand `MetricStore` an empty directory and present
     * whatever falls out as a measurement, this reports the absence. Every rate is `null`
     * and the denominator says the run carried no activity, which is what the UI's
     * `measured()` helper renders as "unavailable". A measurement the run did not produce
     * is never reported as zero.
     */
    evaluation: {
      metrics: async (runId: string) => {
        const summary = await orchestrator.summary(runId) as { auditorCount?: number };
        return Object.freeze({
          rows: Object.freeze([]),
          denominator: Object.freeze({ activityCount: 0, auditorCount: summary.auditorCount ?? 0, groundTruthAvailable: false }),
          segmentation: Object.freeze([]),
          independence: Object.freeze({ applicable: false, reason: "scripted_auditors_record_no_provider_activity", groups: Object.freeze([]) }),
          totalCostUsd: null, currency: null, costPerTrueAcceptedIssue: null,
          consensusPrecision: null, consensusRecall: null,
          verificationResolutionRate: null, cacheHitRate: null, escalatedPairs: null,
          securityOverlapBudget: null, suppressionCandidateCount: null,
        });
      },
      compare: async (request: { readonly a: unknown; readonly b: unknown }) => {
        for (const value of [request.a, request.b]) {
          if (typeof (value as { protocolIdentity?: unknown })?.protocolIdentity !== "string") throw new Error("COMPARISON_SIDE_REQUIRES_PROTOCOL_IDENTITY");
        }
        return Object.freeze({
          comparable: false,
          error: "NO_RECORDED_PROVIDER_ACTIVITY",
          message: "Neither side has model activity traces to compare; scripted-auditor runs record none.",
        });
      },
    },
  };
}
