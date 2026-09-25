import { FetchHttpClient, type HttpClient, type HttpResponse, type TransportConfiguration, type TransportResponse, type TransportUsage } from "../transport-contract.js";
import { providerErrorDetail } from "../transports/json-transport.js";
import { BatchRequestError } from "./contract.js";

export interface BatchHttpOptions {
  readonly client?: HttpClient;
  readonly credential?: (environmentName: string) => string | undefined;
}

export interface BatchCall {
  readonly path: string;
  readonly method?: "GET" | "POST";
  readonly body?: unknown;
  readonly bodyEncoding?: "json" | "multipart";
  readonly responseEncoding?: "json" | "text";
  /**
   * Whether an ambiguous failure may have created billable work. Only submission calls
   * are billable; reads, listings and file uploads are not.
   */
  readonly billable?: boolean;
}

/** Authenticated HTTP for batch drivers, with explicit accepted/unknown classification. */
export class BatchHttp {
  readonly #base: URL;
  readonly #client: HttpClient;
  readonly #credential: (environmentName: string) => string | undefined;

  constructor(
    private readonly configuration: TransportConfiguration,
    private readonly authHeaders: (apiKey: string) => Readonly<Record<string, string>>,
    options: BatchHttpOptions = {},
  ) {
    let base: URL;
    try { base = new URL(configuration.endpoint); } catch { throw new Error("INVALID_TRANSPORT_ENDPOINT"); }
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.hash) throw new Error("INVALID_TRANSPORT_ENDPOINT");
    if (!base.pathname.endsWith("/")) base.pathname = `${base.pathname}/`;
    this.#base = base;
    this.#client = options.client ?? new FetchHttpClient();
    this.#credential = options.credential ?? ((name) => process.env[name]);
  }

  /** Resolves a provider-supplied absolute URL only when it stays on the configured origin. */
  sameOrigin(url: string): string | null {
    try {
      const resolved = new URL(url, this.#base);
      return resolved.origin === this.#base.origin ? resolved.toString() : null;
    } catch { return null; }
  }

  async call(call: BatchCall, signal: AbortSignal): Promise<unknown> {
    const billable = call.billable ?? false;
    const apiKey = this.#credential(this.configuration.apiKeyEnv);
    if (apiKey === undefined || apiKey.length === 0) {
      throw new BatchRequestError("AUTH", `Credential environment variable ${this.configuration.apiKeyEnv} is not set`, "no", false);
    }
    const url = /^https?:\/\//u.test(call.path) ? call.path : new URL(call.path, this.#base).toString();
    let response: HttpResponse;
    try {
      response = await this.#client.send({
        url, headers: this.authHeaders(apiKey), body: call.body ?? null, signal,
        method: call.method ?? "POST",
        ...(call.bodyEncoding === undefined ? {} : { bodyEncoding: call.bodyEncoding }),
        ...(call.responseEncoding === undefined ? {} : { responseEncoding: call.responseEncoding }),
      });
    } catch (error) {
      // The request may have reached the provider. For a billable submission that is
      // exactly the lost-acknowledgment window.
      const message = error instanceof Error ? error.message : String(error);
      throw new BatchRequestError(signal.aborted ? "CANCELLED" : "NETWORK", message, billable ? "unknown" : "no", true);
    }
    if (response.status >= 200 && response.status < 300) return response.body;
    // The provider's own error class (bounded, redacted), so a schema rejection is distinguishable from an outage.
    const detail = providerErrorDetail(response.body);
    const suffix = detail === null ? "" : `: ${detail}`;
    // Same classification as the interactive transports: an unfunded account is refused, not rate limited.
    if ([400, 402, 429].includes(response.status) && detail !== null && QUOTA_REFUSAL.test(detail)) {
      throw new BatchRequestError("QUOTA", `Provider account has no usable credit or quota${suffix}`, "no", false);
    }
    if (response.status === 429) throw new BatchRequestError("RATE_LIMIT", `Provider rate limit${suffix}`, "no", true);
    if (response.status === 401 || response.status === 403) throw new BatchRequestError("AUTH", `Provider rejected credentials${suffix}`, "no", false);
    if (response.status === 404) throw new BatchRequestError("NOT_FOUND", `Provider HTTP 404 for ${call.method ?? "POST"} ${call.path}${suffix}`, "no", false);
    if (response.status === 408 || response.status === 504 || response.status >= 500) {
      throw new BatchRequestError("HTTP", `Provider HTTP ${response.status}${suffix}`, billable ? "unknown" : "no", true);
    }
    throw new BatchRequestError("INVALID_REQUEST", `Provider HTTP ${response.status}${suffix}`, "no", false);
  }
}

/**
 * Exhausted credit, as OpenAI (429 insufficient_quota, 400 billing_hard_limit_reached) and
 * Anthropic (400 credit balance) report it. Deliberately not the bare word "billing": Google
 * says "check your plan and billing details" on ordinary per-minute 429s, which stay retryable.
 */
const QUOTA_REFUSAL = /insufficient_quota|billing_hard_limit|credit_balance|credit balance|payment required/iu;

export function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new BatchRequestError("MALFORMED_RESPONSE", `${label} must be an object`, "no", false);
  return value as Record<string, unknown>;
}
export function text(value: unknown): string | null { return typeof value === "string" ? value : null; }
export function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new BatchRequestError("MALFORMED_RESPONSE", `${label} is missing`, "no", false);
  return value;
}
export function jsonLines(value: unknown, label: string): readonly Record<string, unknown>[] {
  if (typeof value !== "string") throw new BatchRequestError("MALFORMED_RESPONSE", `${label} must be JSONL text`, "no", false);
  return value.split("\n").filter((line) => line.trim() !== "").map((line, index) => {
    try { return record(JSON.parse(line), `${label} line ${index + 1}`); }
    catch (error) {
      if (error instanceof BatchRequestError) throw error;
      throw new BatchRequestError("MALFORMED_RESPONSE", `${label} line ${index + 1} is not JSON`, "no", false);
    }
  });
}

export function usageOf(parse: () => TransportResponse): TransportUsage | null {
  let usage: TransportUsage;
  try { usage = parse().usage; } catch { return null; }
  return usage.inputTokens === null && usage.outputTokens === null ? null : usage;
}

export function assertBatchId(value: string, pattern: RegExp, label: string): string {
  if (!pattern.test(value)) throw new BatchRequestError("MALFORMED_RESPONSE", `${label} has an unexpected format`, "no", false);
  return value;
}

/** Encoding happens before any request is sent, so an encoding failure is a definite non-submission. */
export function encodeBeforeSend<T>(encode: () => T): T {
  try { return encode(); }
  catch (error) { throw new BatchRequestError("INVALID_REQUEST", error instanceof Error ? error.message : "Invalid batch item", "no", false); }
}
