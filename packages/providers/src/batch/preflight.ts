import type { ModelProfile } from "../profiles/model-profile.js";
import type { ProviderRegistry } from "../registry.js";
import type { BatchDriver } from "./contract.js";

/**
 * Preflight for an explicitly configured batch lane. Throws an actionable error before any
 * spend when the profile, the endpoint's transport, or the declared capability cannot
 * support batching. Returns the driver whose capability provenance the run records.
 */
export function assertBatchLaneSupported(registry: ProviderRegistry, modelProfileId: string, endpointId: string,
  profile: Pick<ModelProfile, "supports">): BatchDriver {
  if (!profile.supports.batch) {
    throw new Error(`BATCH_LANE_MODEL_UNSUPPORTED:${modelProfileId}: the model profile declares supports.batch=false. `
      + "Set it only after confirming the provider batches this model, or remove the model from workflow.modelExecution.batch.lanes.");
  }
  if (profile.supports.tools) {
    throw new Error(`BATCH_LANE_INTERACTIVE_PROFILE:${modelProfileId}: the profile declares supports.tools=true, so its activities run `
      + "interactive tool loops. Use a separate profile with supports.tools=false for batch-lane activity groups, or remove the lane.");
  }
  return registry.batchDriver(endpointId);
}
