import { assertBatchLaneSupported } from "@arbitra/providers/batch/preflight.js";
import type { BatchLaneSettings, BatchStateBackend } from "@arbitra/providers/batch/lane.js";
import { ProviderRegistry } from "@arbitra/providers/registry.js";
import type { RunConfig } from "@arbitra/schemas/config.js";
import { providerExecutionSchema, type ProviderExecution } from "@arbitra/schemas/provider-execution.js";
import type { RunStore } from "./run-store.js";

const KIND_PREFIX = "model-batch-";

/**
 * Run preflight for `workflow.modelExecution.batch`. No network access: it checks the
 * profile's declared support and that the endpoint's transport has a batch driver.
 */
export function validateBatchLanes(config: RunConfig): void {
  const execution = providerExecutionSchema.parse(config.workflow["modelExecution"]);
  if (execution.batch === undefined) return;
  const registry = new ProviderRegistry(execution.endpoints);
  for (const lane of execution.batch.lanes) {
    const profile = Object.hasOwn(config.models, lane.modelProfileId) ? config.models[lane.modelProfileId] : undefined;
    if (profile === undefined) throw new Error(`BATCH_LANE_MODEL_PROFILE_REQUIRED:${lane.modelProfileId}`);
    const endpointId = execution.modelEndpoints[lane.modelProfileId];
    if (endpointId === undefined) throw new Error(`MODEL_ENDPOINT_ABSENT:${lane.modelProfileId}`);
    assertBatchLaneSupported(registry, lane.modelProfileId, endpointId, profile);
  }
}

/** The lane settings for an activity, or undefined when it stays on the interactive path. */
export function batchLaneFor(execution: ProviderExecution, modelProfileId: string, activityId: string): BatchLaneSettings | undefined {
  const group = activityId.split("/")[0] ?? activityId;
  const lane = execution.batch?.lanes.find((candidate) => candidate.modelProfileId === modelProfileId && candidate.activityGroups.includes(group));
  if (lane === undefined) return undefined;
  return { pollIntervalMs: lane.pollIntervalMs, maximumWaitMs: lane.maximumWaitMs, maximumItemsPerSubmission: lane.maximumItemsPerSubmission,
    collectWindowMs: lane.collectWindowMs, maximumAttempts: lane.maximumAttempts };
}

/** Batch item and submission records as individually published run artifacts. */
export function runStoreBatchBackend(store: RunStore): BatchStateBackend {
  const kind = (key: string): string => {
    if (!/^(?:item|submission)\/[a-z0-9-]+$/u.test(key)) throw new Error(`INVALID_BATCH_STATE_KEY:${key}`);
    return `${KIND_PREFIX}${key.replace("/", "-")}`;
  };
  return {
    async load(key) {
      const artifact = (await store.listArtifacts()).find((item) => item.kind === kind(key));
      return artifact === undefined ? null : JSON.parse((await store.readArtifact(artifact.artifactId)).content) as unknown;
    },
    async save(key, value) { await store.publish(kind(key), value); },
    async list(prefix) {
      const kindPrefix = `${KIND_PREFIX}${prefix.replace("/", "-")}`;
      return (await store.listArtifacts()).filter((item) => item.kind.startsWith(kindPrefix))
        .map((item) => { const rest = item.kind.slice(KIND_PREFIX.length); const split = rest.indexOf("-"); return `${rest.slice(0, split)}/${rest.slice(split + 1)}`; });
    },
  };
}
