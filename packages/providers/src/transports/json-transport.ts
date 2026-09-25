import {
  FetchHttpClient, TransportError, type HttpClient, type HttpResponse, type ProviderTransport,
  type StructuredOutputTier, type TransportConfiguration, type TransportId, type TransportRequest,
  type TransportResponse, type TransportToolCall, type TransportUsage,
} from "../transport-contract.js";

export interface ProtocolCodec {
  readonly id: TransportId;
  readonly path: string | ((request: TransportRequest) => string);
  encode(request: TransportRequest): unknown;
  parse(body: unknown, request: TransportRequest, headers: Readonly<Record<string, string>>): TransportResponse;
  authHeaders(apiKey: string): Readonly<Record<string, string>>;
}

export class JsonProtocolTransport implements ProviderTransport {
  readonly id: TransportId;
  private readonly endpoint: string;
  constructor(
    configuration: TransportConfiguration,
    private readonly codec: ProtocolCodec,
    private readonly client: HttpClient = new FetchHttpClient(),
    private readonly credential: (environmentName: string) => string | undefined = (name) => process.env[name],
  ) {
    this.id = codec.id;
    try {
      const endpoint = new URL(configuration.endpoint);
      if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) throw new Error("invalid endpoint");
      endpoint.pathname = ensureTrailingSlash(endpoint.pathname);
      this.endpoint = endpoint.toString();
    }
    catch { throw new Error("INVALID_TRANSPORT_ENDPOINT"); }
    this.apiKeyEnvironmentName = configuration.apiKeyEnv;
    this.compatibleProviderName = configuration.compatibleProviderName ?? null;
  }
  readonly apiKeyEnvironmentName: string;
  readonly compatibleProviderName: string | null;

  async send(request: TransportRequest, signal: AbortSignal): Promise<TransportResponse> {
    if (signal.aborted) throw new TransportError("CANCELLED", "Provider request cancelled", false);
    const apiKey = this.credential(this.apiKeyEnvironmentName);
    if (apiKey === undefined || apiKey.length === 0) throw new TransportError("AUTH", `Credential environment variable ${this.apiKeyEnvironmentName} is not set`, false);
    let url: string; let body: unknown;
    try {
      url = new URL(typeof this.codec.path === "string" ? this.codec.path : this.codec.path(request), this.endpoint).toString();
      body = this.codec.encode(request);
    } catch (error) {
      throw new TransportError("INVALID_REQUEST", error instanceof Error ? error.message : "Invalid provider request", false);
    }
    let response: HttpResponse;
    try {
      response = await this.client.send({
        url, headers: this.codec.authHeaders(apiKey), body, signal,
      });
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === "AbortError")) throw new TransportError("CANCELLED", "Provider request cancelled", false);
      if (error instanceof TransportError) throw error;
      throw new TransportError("HTTP", error instanceof Error ? error.message : String(error), true);
    }
    assertHttpSuccess(response);
    try { return this.codec.parse(response.body, request, response.headers); }
    catch (error) {
      if (error instanceof TransportError) throw error;
      throw new TransportError("MALFORMED_RESPONSE", error instanceof Error ? error.message : "Malformed provider response", false);
    }
  }
}

/** A response stopped by the requested output ceiling is incomplete, even when its
 * prefix happens to parse. Fail explicitly so callers can split the stage rather than
 * treating a truncated structured result as malformed or complete. */
export function assertOutputComplete(stopped: boolean): void {
  if (stopped) throw new TransportError("OUTPUT_LIMIT", "MODEL_OUTPUT_LIMIT_REACHED: provider stopped at maximumOutputTokens", false);
}

export function response(
  request: TransportRequest,
  values: {
    text?: string | null; structured?: unknown; toolCalls?: readonly TransportToolCall[]; refusal?: string | null;
    usage?: Partial<TransportUsage>; continuation?: string | null; tier?: StructuredOutputTier; requestId?: string | null;
  },
): TransportResponse {
  const text = values.text ?? null;
  let structured = values.structured ?? null;
  if (request.responseSchema !== undefined && structured === null && text !== null && values.refusal == null && (values.toolCalls?.length ?? 0) === 0) {
    try { structured = JSON.parse(text); } catch { throw new Error("Structured response was not valid JSON"); }
  }
  return Object.freeze({
    text, structured, toolCalls: Object.freeze([...(values.toolCalls ?? [])]), refusal: values.refusal ?? null,
    usage: Object.freeze({ inputTokens: values.usage?.inputTokens ?? null, outputTokens: values.usage?.outputTokens ?? null,
      cacheReadTokens: values.usage?.cacheReadTokens ?? null, cacheWriteTokens: values.usage?.cacheWriteTokens ?? null }),
    continuation: values.continuation ?? null,
    structuredOutputTier: values.tier ?? (request.responseSchema === undefined ? "prompt_json" : "native_structured"),
    providerRequestId: values.requestId ?? null,
  });
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
export function array(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : []; }
export function string(value: unknown): string | null { return typeof value === "string" ? value : null; }
export function number(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }

function assertHttpSuccess(value: HttpResponse): void {
  if (value.status >= 200 && value.status < 300) return;
  const detail = providerErrorDetail(value.body);
  const suffix = detail === null ? "" : `: ${detail}`;
  // Observed live: OpenAI answers exhausted credit with 429 insufficient_quota and Anthropic
  // with 400 "credit balance is too low". Neither is a rate limit or a malformed request,
  // and retrying only repeats the refusal.
  if ((value.status === 429 || value.status === 400 || value.status === 402) && detail !== null && /insufficient_quota|credit_balance|credit balance|billing|payment required/iu.test(detail)) throw new TransportError("QUOTA", `Provider account has no usable credit or quota${suffix}`, false);
  if (value.status === 429) {
    const header = Object.entries(value.headers).find(([name]) => name.toLowerCase() === "retry-after")?.[1];
    throw new TransportError("RATE_LIMIT", `Provider rate limit${suffix}`, true, retryAfterMilliseconds(header));
  }
  if (value.status === 408 || value.status === 504) throw new TransportError("TIMEOUT", "Provider request timed out", true);
  if (value.status === 401 || value.status === 403) throw new TransportError("AUTH", `Provider rejected credentials${suffix}`, false);
  throw new TransportError("HTTP", `Provider HTTP ${value.status}${suffix}`, value.status >= 500);
}

/**
 * The provider's own error classification, bounded and stripped of anything credential-like,
 * so an operator can tell a schema rejection from an outage. Only the error object's
 * type/code/status and the start of its message are kept; request echoes are not.
 */
export function providerErrorDetail(body: unknown): string | null {
  const root = Array.isArray(body) ? body[0] as unknown : body;
  if (root === null || typeof root !== "object") return null;
  const error = (root as Record<string, unknown>)["error"];
  if (error === null || typeof error !== "object") return null;
  const fields = error as Record<string, unknown>;
  const parts = [fields["type"], fields["code"], fields["status"]].filter((part): part is string | number => typeof part === "string" || typeof part === "number").map(String);
  const message = typeof fields["message"] === "string" ? fields["message"].replace(/\s+/gu, " ").slice(0, 240) : null;
  const text = [...new Set(parts)].join("/") + (message === null ? "" : ` ${message}`);
  const redacted = text.replace(/(sk-(?:ant-|proj-)?|AIza|AQ\.)[A-Za-z0-9_.-]{6,}/gu, "$1<redacted>").replace(/\b(key|token|secret)=[^\s&]+/giu, "$1=<redacted>").trim();
  return redacted === "" ? null : redacted;
}
function ensureTrailingSlash(value: string): string { return value.endsWith("/") ? value : `${value}/`; }

export function retryAfterMilliseconds(value: string | undefined, now = Date.now()): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(trimmed)) {
    const milliseconds = Number(trimmed) * 1_000;
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(trimmed)) return null;
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}
