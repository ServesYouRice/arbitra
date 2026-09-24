import type { TransportConfiguration, TransportRequest, TransportResponse, TransportUsage } from "../transport-contract.js";
import { anthropicMessagesCodec } from "../transports/anthropic-messages.js";
import type {
  BatchCapabilityDeclaration, BatchDriver, BatchJobStatus, BatchLookup, BatchRawItemResult, BatchSubmitInput,
} from "./contract.js";
import { BatchHttp, encodeBeforeSend, jsonLines, record, requiredText, text, usageOf, type BatchHttpOptions } from "./http.js";

export const ANTHROPIC_BATCH_DECLARATION: BatchCapabilityDeclaration = Object.freeze({
  capability: "batch", driverId: "anthropic-message-batches", transport: "anthropic-messages", status: "declared_unverified",
  documentation: Object.freeze(["https://docs.claude.com/en/docs/build-with-claude/batch-processing", "https://docs.claude.com/en/api/creating-message-batches"]),
  liveValidation: null, reconciliation: "operator_only",
});

/**
 * Anthropic Message Batches. The API accepts no client-supplied submission key or batch
 * metadata, so a lost creation acknowledgment cannot be reconciled automatically: the
 * lane records it as uncertain and the operator decides from the provider console.
 */
export class AnthropicBatchDriver implements BatchDriver {
  readonly id = "anthropic-message-batches";
  readonly transport = "anthropic-messages";
  readonly declaration = ANTHROPIC_BATCH_DECLARATION;
  readonly #http: BatchHttp;

  constructor(configuration: TransportConfiguration, options: BatchHttpOptions = {}) {
    this.#http = new BatchHttp(configuration, (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }), options);
  }

  async submit(input: BatchSubmitInput, signal: AbortSignal): Promise<{ readonly providerJobId: string }> {
    const requests = encodeBeforeSend(() => input.items.map(({ customId, request }) => ({ custom_id: customId, params: anthropicMessagesCodec.encode(request) })));
    const batch = record(await this.#http.call({ path: "messages/batches", billable: true, body: { requests } }, signal), "anthropic batch");
    return { providerJobId: requiredText(batch["id"], "anthropic batch id") };
  }

  async find(): Promise<BatchLookup> {
    return { kind: "unsupported", reason: "Anthropic Message Batches accept no client submission key or metadata; confirm in the provider console whether the batch exists" };
  }

  async status(providerJobId: string, signal: AbortSignal): Promise<BatchJobStatus> {
    const batch = await this.#batch(providerJobId, signal);
    const status = requiredText(batch["processing_status"], "anthropic processing_status");
    return { ended: status === "ended", providerStatus: status, jobFailure: null };
  }

  async results(providerJobId: string, signal: AbortSignal): Promise<readonly BatchRawItemResult[]> {
    const batch = await this.#batch(providerJobId, signal);
    const advertised = text(batch["results_url"]);
    // Credentials are only ever sent to the configured origin.
    const url = advertised === null ? `messages/batches/${encodeURIComponent(providerJobId)}/results` : this.#http.sameOrigin(advertised);
    if (url === null) throw new Error("BATCH_RESULTS_URL_UNTRUSTED");
    const content = await this.#http.call({ path: url, method: "GET", responseEncoding: "text" }, signal);
    return jsonLines(content, "anthropic batch results").map((line): BatchRawItemResult => {
      const customId = requiredText(line["custom_id"], "anthropic custom_id");
      const result = record(line["result"], "anthropic result");
      const type = text(result["type"]);
      if (type === "succeeded") return { customId, outcome: "succeeded", body: result["message"], error: null };
      if (type === "canceled") return { customId, outcome: "cancelled", body: null, error: { code: "canceled", message: "Cancelled before processing" } };
      if (type === "expired") return { customId, outcome: "expired", body: null, error: { code: "expired", message: "Batch expired before processing" } };
      const outer = record(result["error"] ?? {}, "anthropic error");
      const inner = record(outer["error"] ?? outer, "anthropic error detail");
      return { customId, outcome: "errored", body: null, error: { code: text(inner["type"]) ?? "errored", message: text(inner["message"]) ?? "Anthropic batch item failed" } };
    });
  }

  async cancel(providerJobId: string, signal: AbortSignal): Promise<void> {
    await this.#http.call({ path: `messages/batches/${encodeURIComponent(providerJobId)}/cancel`, body: {} }, signal);
  }

  parse(body: unknown, request: TransportRequest): TransportResponse {
    const message = record(body, "anthropic batch message");
    return anthropicMessagesCodec.parse(message, request, text(message["id"]) === null ? {} : { "request-id": text(message["id"]) ?? "" });
  }

  usage(body: unknown): TransportUsage | null {
    return usageOf(() => this.parse(body, { modelId: "usage", messages: [], maximumOutputTokens: 1 }));
  }

  async #batch(providerJobId: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    return record(await this.#http.call({ path: `messages/batches/${encodeURIComponent(providerJobId)}`, method: "GET" }, signal), "anthropic batch");
  }
}
