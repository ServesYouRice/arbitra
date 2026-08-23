import {
  FetchHttpClient, TransportError, type HttpClient, type HttpResponse, type ProviderTransport,
  type StructuredOutputTier, type TransportConfiguration, type TransportId, type TransportRequest,
  type TransportResponse, type TransportToolCall, type TransportUsage,
} from "../transport-contract.js";

export interface ProtocolCodec {
  readonly id: TransportId;
  readonly path: string;
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
    try { this.endpoint = new URL(codec.path, ensureTrailingSlash(configuration.endpoint)).toString(); }
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
    let response: HttpResponse;
    try {
      response = await this.client.send({
        url: this.endpoint, headers: this.codec.authHeaders(apiKey), body: this.codec.encode(request), signal,
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

export function response(
  request: TransportRequest,
  values: {
    text?: string | null; structured?: unknown; toolCalls?: readonly TransportToolCall[]; refusal?: string | null;
    usage?: Partial<TransportUsage>; continuation?: string | null; tier?: StructuredOutputTier; requestId?: string | null;
  },
): TransportResponse {
  const text = values.text ?? null;
  let structured = values.structured ?? null;
  if (request.responseSchema !== undefined && structured === null && text !== null) {
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
  if (value.status === 429) {
    const seconds = Number(value.headers["retry-after"]);
    throw new TransportError("RATE_LIMIT", "Provider rate limit", true, Number.isFinite(seconds) ? seconds * 1_000 : null);
  }
  if (value.status === 408 || value.status === 504) throw new TransportError("TIMEOUT", "Provider request timed out", true);
  if (value.status === 401 || value.status === 403) throw new TransportError("AUTH", "Provider rejected credentials", false);
  throw new TransportError("HTTP", `Provider HTTP ${value.status}`, value.status >= 500);
}
function ensureTrailingSlash(value: string): string { return value.endsWith("/") ? value : `${value}/`; }
