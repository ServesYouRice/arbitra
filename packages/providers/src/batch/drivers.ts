import type { TransportConfiguration } from "../transport-contract.js";
import { ANTHROPIC_BATCH_DECLARATION, AnthropicBatchDriver } from "./anthropic-batch.js";
import type { BatchCapabilityDeclaration, BatchDriver } from "./contract.js";
import { GEMINI_BATCH_DECLARATION, GeminiBatchDriver } from "./gemini-batch.js";
import type { BatchHttpOptions } from "./http.js";
import { OPENAI_BATCH_DECLARATION, OpenAiBatchDriver } from "./openai-batch.js";

export type BatchDriverFactory = (configuration: TransportConfiguration, options: BatchHttpOptions) => BatchDriver;

/** Keyed by wire transport. A transport absent here has no batch lane. */
export const BUILTIN_BATCH_DRIVER_FACTORIES: Readonly<Record<string, BatchDriverFactory>> = Object.freeze({
  "openai-responses": (configuration, options) => new OpenAiBatchDriver(configuration, options),
  "anthropic-messages": (configuration, options) => new AnthropicBatchDriver(configuration, options),
  "gemini-native": (configuration, options) => new GeminiBatchDriver(configuration, options),
});

/** Capability provenance for every shipped driver. None has been validated live. */
export const BATCH_DRIVER_DECLARATIONS: readonly BatchCapabilityDeclaration[] = Object.freeze([
  OPENAI_BATCH_DECLARATION, ANTHROPIC_BATCH_DECLARATION, GEMINI_BATCH_DECLARATION,
]);

export function unsupportedBatchEndpointMessage(endpointId: string, transport: string, supported: readonly string[]): string {
  return `BATCH_LANE_UNSUPPORTED_ENDPOINT:${endpointId}: transport "${transport}" has no batch driver `
    + `(batch drivers exist for: ${supported.join(", ")}). Remove this model from workflow.modelExecution.batch.lanes `
    + "to keep it on the interactive path, or bind it to an endpoint whose transport has a batch driver.";
}
