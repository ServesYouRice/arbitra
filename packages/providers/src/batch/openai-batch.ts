import type { TransportConfiguration, TransportRequest, TransportResponse, TransportUsage } from "../transport-contract.js";
import { openAiResponsesCodec } from "../transports/openai-responses.js";
import {
  type BatchCapabilityDeclaration, type BatchDriver, type BatchJobStatus, type BatchLookup,
  type BatchRawItemResult, type BatchSubmitInput,
} from "./contract.js";
import { BatchHttp, encodeBeforeSend, jsonLines, record, requiredText, text, usageOf, type BatchHttpOptions } from "./http.js";

export const OPENAI_BATCH_DECLARATION: BatchCapabilityDeclaration = Object.freeze({
  capability: "batch", driverId: "openai-batch", transport: "openai-responses", status: "declared_unverified",
  documentation: Object.freeze(["https://platform.openai.com/docs/guides/batch", "https://platform.openai.com/docs/api-reference/batch"]),
  liveValidation: null, reconciliation: "metadata_listing",
});

const METADATA_KEY = "arbitra_submission_key";
const LISTING_PAGE_LIMIT = 100;
const MAXIMUM_LISTING_PAGES = 10;
const ENDED = new Set(["completed", "failed", "expired", "cancelled"]);

/**
 * OpenAI Batch API against `/v1/responses`: JSONL input file upload, batch creation with
 * a metadata submission key, status polling, output/error file retrieval and cancellation.
 * Input-file upload is not billable, so a failed upload is a definite non-submission.
 */
export class OpenAiBatchDriver implements BatchDriver {
  readonly id = "openai-batch";
  readonly transport = "openai-responses";
  readonly declaration = OPENAI_BATCH_DECLARATION;
  readonly #http: BatchHttp;

  constructor(configuration: TransportConfiguration, options: BatchHttpOptions = {}) {
    this.#http = new BatchHttp(configuration, (key) => ({ authorization: `Bearer ${key}` }), options);
  }

  async submit(input: BatchSubmitInput, signal: AbortSignal): Promise<{ readonly providerJobId: string }> {
    const lines = encodeBeforeSend(() => input.items.map(({ customId, request }) => JSON.stringify({
      custom_id: customId, method: "POST", url: "/v1/responses", body: openAiResponsesCodec.encode(request),
    })));
    const file = record(await this.#http.call({
      path: "files", bodyEncoding: "multipart",
      body: { fields: { purpose: "batch" }, file: { field: "file", filename: `${input.submissionKey}.jsonl`, contentType: "application/jsonl", content: `${lines.join("\n")}\n` } },
    }, signal), "openai file");
    const inputFileId = requiredText(file["id"], "openai file id");
    const batch = record(await this.#http.call({
      path: "batches", billable: true,
      body: { input_file_id: inputFileId, endpoint: "/v1/responses", completion_window: "24h", metadata: { [METADATA_KEY]: input.submissionKey } },
    }, signal), "openai batch");
    return { providerJobId: requiredText(batch["id"], "openai batch id") };
  }

  async find(submissionKey: string, _modelId: string, signal: AbortSignal): Promise<BatchLookup> {
    let after: string | null = null;
    for (let page = 0; page < MAXIMUM_LISTING_PAGES; page += 1) {
      const query = new URLSearchParams({ limit: String(LISTING_PAGE_LIMIT), ...(after === null ? {} : { after }) });
      const listing = record(await this.#http.call({ path: `batches?${query.toString()}`, method: "GET" }, signal), "openai batch list");
      const data = Array.isArray(listing["data"]) ? listing["data"] : [];
      for (const item of data) {
        const batch = record(item, "openai batch");
        const metadata = typeof batch["metadata"] === "object" && batch["metadata"] !== null ? batch["metadata"] as Record<string, unknown> : {};
        if (metadata[METADATA_KEY] === submissionKey) return { kind: "found", providerJobId: requiredText(batch["id"], "openai batch id") };
      }
      if (listing["has_more"] !== true) return { kind: "not_found" };
      after = text(listing["last_id"]) ?? text(record(data.at(-1), "openai batch")["id"]);
      if (after === null) break;
    }
    return { kind: "inconclusive", reason: `Submission key not found in the newest ${MAXIMUM_LISTING_PAGES * LISTING_PAGE_LIMIT} batches` };
  }

  async status(providerJobId: string, signal: AbortSignal): Promise<BatchJobStatus> {
    const batch = await this.#batch(providerJobId, signal);
    const status = requiredText(batch["status"], "openai batch status");
    const errorData = record(batch["errors"] ?? {}, "openai batch errors")["data"];
    const first = Array.isArray(errorData) && errorData.length > 0 ? record(errorData[0], "openai batch error") : null;
    return {
      ended: ENDED.has(status), providerStatus: status,
      jobFailure: status === "failed" ? { code: text(first?.["code"]) ?? "BATCH_FAILED", message: text(first?.["message"]) ?? "OpenAI batch failed" } : null,
    };
  }

  async results(providerJobId: string, signal: AbortSignal): Promise<readonly BatchRawItemResult[]> {
    const batch = await this.#batch(providerJobId, signal);
    const results: BatchRawItemResult[] = [];
    for (const fileId of [text(batch["output_file_id"]), text(batch["error_file_id"])]) {
      if (fileId === null) continue;
      const content = await this.#http.call({ path: `files/${encodeURIComponent(fileId)}/content`, method: "GET", responseEncoding: "text" }, signal);
      for (const line of jsonLines(content, "openai batch results")) results.push(outcomeOf(line));
    }
    return results;
  }

  async cancel(providerJobId: string, signal: AbortSignal): Promise<void> {
    await this.#http.call({ path: `batches/${encodeURIComponent(providerJobId)}/cancel`, body: {} }, signal);
  }

  parse(body: unknown, request: TransportRequest): TransportResponse {
    const value = record(body, "openai batch item");
    const requestId = text(value["requestId"]);
    return openAiResponsesCodec.parse(value["body"], request, requestId === null ? {} : { "x-request-id": requestId });
  }

  usage(body: unknown): TransportUsage | null {
    return usageOf(() => this.parse(body, { modelId: "usage", messages: [], maximumOutputTokens: 1 }));
  }

  async #batch(providerJobId: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    return record(await this.#http.call({ path: `batches/${encodeURIComponent(providerJobId)}`, method: "GET" }, signal), "openai batch");
  }
}

function outcomeOf(line: Record<string, unknown>): BatchRawItemResult {
  const customId = requiredText(line["custom_id"], "openai custom_id");
  const response = line["response"] === null || line["response"] === undefined ? null : record(line["response"], "openai item response");
  const error = line["error"] === null || line["error"] === undefined ? null : record(line["error"], "openai item error");
  const statusCode = typeof response?.["status_code"] === "number" ? response["status_code"] : null;
  if (response !== null && error === null && statusCode !== null && statusCode >= 200 && statusCode < 300) {
    return { customId, outcome: "succeeded", body: { body: response["body"], requestId: text(response["request_id"]) }, error: null };
  }
  const code = text(error?.["code"]) ?? (statusCode === null ? "UNKNOWN" : `HTTP_${statusCode}`);
  const message = text(error?.["message"]) ?? text(record(record(response?.["body"] ?? {}, "body")["error"] ?? {}, "error")["message"]) ?? "OpenAI batch item failed";
  if (code === "batch_expired") return { customId, outcome: "expired", body: null, error: { code, message } };
  if (code === "batch_cancelled") return { customId, outcome: "cancelled", body: null, error: { code, message } };
  return { customId, outcome: "errored", body: null, error: { code, message } };
}
