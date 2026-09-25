export type TransportId = "anthropic-messages" | "openai-responses" | "openai-chat" | "gemini-native" | (string & {});
export type StructuredOutputTier = "native_structured" | "schema_tool_call" | "json_mode" | "prompt_json";

export interface TransportMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly toolCalls?: readonly TransportToolCall[];
}
export interface TransportTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}
export interface TransportRequest {
  readonly modelId: string;
  readonly messages: readonly TransportMessage[];
  readonly tools?: readonly TransportTool[];
  readonly responseSchema?: Readonly<Record<string, unknown>>;
  readonly maximumOutputTokens: number;
  readonly effortParams?: Readonly<Record<string, string | number | boolean | null>>;
  readonly continuation?: string;
}
export interface TransportUsage {
  /** Total input tokens, including cached reads/writes when reported separately. */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
}
/**
 * `providerState` is opaque data the provider requires back verbatim when the call is
 * replayed in history (Gemini thought signatures, natively or through its OpenAI-compatible
 * endpoint). It is never interpreted and never shown to the model as content.
 */
export interface TransportToolCall { readonly id: string; readonly name: string; readonly arguments: unknown; readonly providerState?: unknown }
export interface TransportResponse {
  readonly text: string | null;
  readonly structured: unknown;
  readonly toolCalls: readonly TransportToolCall[];
  readonly refusal: string | null;
  readonly usage: TransportUsage;
  readonly continuation: string | null;
  readonly structuredOutputTier: StructuredOutputTier;
  readonly providerRequestId: string | null;
}
export interface ProviderTransport {
  readonly id: TransportId;
  send(request: TransportRequest, signal: AbortSignal): Promise<TransportResponse>;
}
/** `QUOTA`: the account cannot pay for the call (exhausted credits or quota); retrying cannot help. */
export type TransportErrorCode = "AUTH" | "INVALID_REQUEST" | "MALFORMED_RESPONSE" | "RATE_LIMIT" | "QUOTA" | "TIMEOUT" | "CANCELLED" | "HTTP" | "OUTPUT_LIMIT";
export class TransportError extends Error {
  constructor(
    readonly code: TransportErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null,
  ) { super(message); this.name = "TransportError"; }
}

export interface TransportConfiguration {
  readonly endpoint: string;
  readonly apiKeyEnv: string;
  readonly compatibleProviderName?: string;
}

export interface HttpRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly signal: AbortSignal;
  /** Defaults to POST. GET requests carry no body. */
  readonly method?: "GET" | "POST";
  /** Defaults to JSON. Multipart bodies must be {@link MultipartBody}. */
  readonly bodyEncoding?: "json" | "multipart";
  /** Defaults to JSON. Text responses (for example JSONL result files) return the raw string. */
  readonly responseEncoding?: "json" | "text";
}
export interface MultipartBody {
  readonly fields: Readonly<Record<string, string>>;
  readonly file: { readonly field: string; readonly filename: string; readonly contentType: string; readonly content: string };
}
export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}
export interface HttpClient { send(request: HttpRequest): Promise<HttpResponse>; }

export class FetchHttpClient implements HttpClient {
  async send(request: HttpRequest): Promise<HttpResponse> {
    let response: Response;
    const method = request.method ?? "POST";
    let body: string | FormData | undefined;
    let headers: Record<string, string> = { ...request.headers };
    if (method === "POST" && request.bodyEncoding === "multipart") {
      const multipart = request.body as MultipartBody;
      const form = new FormData();
      for (const [name, value] of Object.entries(multipart.fields)) form.append(name, value);
      form.append(multipart.file.field, new Blob([multipart.file.content], { type: multipart.file.contentType }), multipart.file.filename);
      body = form;
    } else if (method === "POST") {
      headers = { "content-type": "application/json", ...headers };
      body = JSON.stringify(request.body);
    }
    try {
      response = await fetch(request.url, { method, headers, ...(body === undefined ? {} : { body }), signal: request.signal });
    } catch (error) {
      if (request.signal.aborted) throw new TransportError("CANCELLED", "Provider request cancelled", false);
      if (error instanceof DOMException && error.name === "TimeoutError") throw new TransportError("TIMEOUT", "Provider request timed out", true);
      throw error;
    }
    const parsed: unknown = request.responseEncoding === "text" ? await response.text().catch(() => null) : await response.json().catch(() => null);
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body: parsed };
  }
}
