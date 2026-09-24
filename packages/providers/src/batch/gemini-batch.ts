import type { TransportConfiguration, TransportRequest, TransportResponse, TransportUsage } from "../transport-contract.js";
import { geminiNativeCodec } from "../transports/gemini-native.js";
import type {
  BatchCapabilityDeclaration, BatchDriver, BatchJobStatus, BatchLookup, BatchRawItemResult, BatchSubmitInput,
} from "./contract.js";
import { BatchHttp, assertBatchId, encodeBeforeSend, record, requiredText, text, usageOf, type BatchHttpOptions } from "./http.js";

export const GEMINI_BATCH_DECLARATION: BatchCapabilityDeclaration = Object.freeze({
  capability: "batch", driverId: "gemini-batch", transport: "gemini-native", status: "declared_unverified",
  documentation: Object.freeze(["https://ai.google.dev/gemini-api/docs/batch-mode", "https://ai.google.dev/api/batch-mode"]),
  liveValidation: null, reconciliation: "display_name_listing",
});

const BATCH_NAME = /^batches\/[A-Za-z0-9_-]+$/u;
const MAXIMUM_LISTING_PAGES = 10;
const ENDED = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"]);

/**
 * Gemini batch mode with inline requests (`models/{model}:batchGenerateContent`). The
 * submission key is the batch display name, which listing can match after a lost
 * acknowledgment. File-based (`responsesFile`) output is not supported by this driver.
 */
export class GeminiBatchDriver implements BatchDriver {
  readonly id = "gemini-batch";
  readonly transport = "gemini-native";
  readonly declaration = GEMINI_BATCH_DECLARATION;
  readonly #http: BatchHttp;

  constructor(configuration: TransportConfiguration, options: BatchHttpOptions = {}) {
    this.#http = new BatchHttp(configuration, (key) => ({ "x-goog-api-key": key }), options);
  }

  async submit(input: BatchSubmitInput, signal: AbortSignal): Promise<{ readonly providerJobId: string }> {
    const model = encodeBeforeSend(() => modelPath(input.modelId));
    const requests = encodeBeforeSend(() => input.items.map(({ customId, request }) => ({ request: geminiNativeCodec.encode(request), metadata: { key: customId } })));
    const operation = record(await this.#http.call({
      path: `${model}:batchGenerateContent`, billable: true,
      body: { batch: { displayName: input.submissionKey, inputConfig: { requests: { requests } } } },
    }, signal), "gemini batch operation");
    return { providerJobId: assertBatchId(requiredText(operation["name"], "gemini batch name"), BATCH_NAME, "gemini batch name") };
  }

  async find(submissionKey: string, _modelId: string, signal: AbortSignal): Promise<BatchLookup> {
    let pageToken: string | null = null;
    for (let page = 0; page < MAXIMUM_LISTING_PAGES; page += 1) {
      const query = new URLSearchParams({ pageSize: "100", ...(pageToken === null ? {} : { pageToken }) });
      const listing = record(await this.#http.call({ path: `batches?${query.toString()}`, method: "GET" }, signal), "gemini batch list");
      for (const item of Array.isArray(listing["operations"]) ? listing["operations"] : []) {
        const operation = record(item, "gemini batch operation");
        const metadata = record(operation["metadata"] ?? {}, "gemini batch metadata");
        if (metadata["displayName"] === submissionKey) {
          return { kind: "found", providerJobId: assertBatchId(requiredText(operation["name"], "gemini batch name"), BATCH_NAME, "gemini batch name") };
        }
      }
      pageToken = text(listing["nextPageToken"]);
      if (pageToken === null || pageToken === "") return { kind: "not_found" };
    }
    return { kind: "inconclusive", reason: `Submission key not found in ${MAXIMUM_LISTING_PAGES} listing pages` };
  }

  async status(providerJobId: string, signal: AbortSignal): Promise<BatchJobStatus> {
    const operation = await this.#operation(providerJobId, signal);
    const state = stateOf(operation);
    const error = operation["error"] === undefined ? null : record(operation["error"], "gemini operation error");
    return {
      ended: ENDED.has(state), providerStatus: state,
      jobFailure: state === "FAILED" ? { code: String(error?.["code"] ?? "BATCH_FAILED"), message: text(error?.["message"]) ?? "Gemini batch failed" } : null,
    };
  }

  async results(providerJobId: string, signal: AbortSignal): Promise<readonly BatchRawItemResult[]> {
    const operation = await this.#operation(providerJobId, signal);
    const state = stateOf(operation);
    const metadata = record(operation["metadata"] ?? {}, "gemini batch metadata");
    const output = record(operation["response"] ?? metadata["output"] ?? {}, "gemini batch output");
    if (output["responsesFile"] !== undefined) throw new Error("GEMINI_BATCH_FILE_OUTPUT_UNSUPPORTED");
    const inlined = record(output["inlinedResponses"] ?? {}, "gemini inlined responses")["inlinedResponses"];
    return (Array.isArray(inlined) ? inlined : []).map((item): BatchRawItemResult => {
      const entry = record(item, "gemini inlined response");
      const customId = requiredText(record(entry["metadata"] ?? {}, "gemini item metadata")["key"], "gemini item key");
      if (entry["response"] !== undefined && entry["error"] === undefined) return { customId, outcome: "succeeded", body: entry["response"], error: null };
      const error = record(entry["error"] ?? {}, "gemini item error");
      const failure = { code: String(error["code"] ?? "errored"), message: text(error["message"]) ?? "Gemini batch item failed" };
      if (state === "CANCELLED") return { customId, outcome: "cancelled", body: null, error: failure };
      if (state === "EXPIRED") return { customId, outcome: "expired", body: null, error: failure };
      return { customId, outcome: "errored", body: null, error: failure };
    });
  }

  async cancel(providerJobId: string, signal: AbortSignal): Promise<void> {
    await this.#http.call({ path: `${assertBatchId(providerJobId, BATCH_NAME, "gemini batch name")}:cancel`, body: {} }, signal);
  }

  parse(body: unknown, request: TransportRequest): TransportResponse {
    return geminiNativeCodec.parse(body, request, {});
  }

  usage(body: unknown): TransportUsage | null {
    return usageOf(() => this.parse(body, { modelId: "usage", messages: [], maximumOutputTokens: 1 }));
  }

  async #operation(providerJobId: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    return record(await this.#http.call({ path: assertBatchId(providerJobId, BATCH_NAME, "gemini batch name"), method: "GET" }, signal), "gemini batch operation");
  }
}

function modelPath(modelId: string): string {
  const model = modelId.replace(/^models\//u, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(model)) throw new Error("INVALID_GEMINI_MODEL_ID");
  return `models/${model}`;
}

/** Documented states use a `BATCH_STATE_` prefix; `JOB_STATE_` is accepted for older examples. */
function stateOf(operation: Record<string, unknown>): string {
  const metadata = record(operation["metadata"] ?? {}, "gemini batch metadata");
  const raw = text(metadata["state"]) ?? (operation["done"] === true ? (operation["error"] === undefined ? "SUCCEEDED" : "FAILED") : "PENDING");
  return raw.replace(/^(?:BATCH|JOB)_STATE_/u, "");
}
