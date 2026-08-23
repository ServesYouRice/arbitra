export type TransportId = "anthropic-messages" | "openai-responses" | "openai-chat" | "gemini-native" | (string & {});
export type StructuredOutputTier = "native_structured" | "schema_tool_call" | "json_mode" | "prompt_json";

export interface TransportMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCallId?: string;
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
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
}
export interface TransportToolCall { readonly id: string; readonly name: string; readonly arguments: unknown; }
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
export type TransportErrorCode = "AUTH" | "MALFORMED_RESPONSE" | "RATE_LIMIT" | "TIMEOUT" | "CANCELLED" | "HTTP";
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
    try {
      response = await fetch(request.url, {
        method: "POST", headers: { "content-type": "application/json", ...request.headers },
        body: JSON.stringify(request.body), signal: request.signal,
      });
    } catch (error) {
      if (request.signal.aborted) throw new TransportError("CANCELLED", "Provider request cancelled", false);
      if (error instanceof DOMException && error.name === "TimeoutError") throw new TransportError("TIMEOUT", "Provider request timed out", true);
      throw error;
    }
    const body: unknown = await response.json().catch(() => null);
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body };
  }
}
