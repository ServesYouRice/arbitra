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
  /** The executing client's identity when it is not the wire protocol alone, e.g. `claude-code/2.1.282` for a subscription CLI. */
  readonly transportVersion?: string;
}
export interface ProviderTransport {
  readonly id: TransportId;
  send(request: TransportRequest, signal: AbortSignal): Promise<TransportResponse>;
  /** Removes whatever the transport kept for a later turn (a CLI's open sessions). Called once the run that owns it settles. */
  close?(): Promise<void>;
}
/** `QUOTA`: the account cannot pay for the call (exhausted credits or quota); retrying cannot help. */
export type TransportErrorCode = "AUTH" | "INVALID_REQUEST" | "MALFORMED_RESPONSE" | "RATE_LIMIT" | "QUOTA" | "TIMEOUT" | "CANCELLED" | "HTTP" | "OUTPUT_LIMIT";
/**
 * Whether a failed attempt provably consumed no tokens. Only failures that happen before the
 * provider could process the request (no credential, no connection, a refusal answered before any
 * work) say `none`; everything else is `unknown`, which keeps the attempt's estimate charged.
 */
export type UsageEvidence = { readonly consumption: "none"; readonly rule: string } | { readonly consumption: "unknown" };
export const USAGE_UNKNOWN: UsageEvidence = Object.freeze({ consumption: "unknown" });
export function noUsage(rule: string): UsageEvidence { return Object.freeze({ consumption: "none", rule }); }
export class TransportError extends Error {
  constructor(
    readonly code: TransportErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null,
    readonly evidence: UsageEvidence = USAGE_UNKNOWN,
    /** What the call's streams showed until it failed, when its transport read them (a CLI). */
    readonly stream: StreamTrace | null = null,
  ) { super(message); this.name = "TransportError"; }
}
/**
 * What a failed call's streams showed until it stopped: how many events came, when the last came and what it was, and
 * how its stderr ended (bounded, redacted). Times are ISO-8601. It tells a call that received nothing from one that
 * was streaming when its time ran out: observed (October 26, 2026), a timed-out call kept no trace of either.
 */
export interface StreamTrace {
  readonly startedAt: string; readonly stoppedAt: string;
  readonly events: number; readonly lastEventAt: string | null; readonly lastEventType: string | null;
  readonly stderrTail: string;
}
/** The same failure with its stream's trace. A timeout says in its message what the stream showed, so the run's failed calls do. */
export function withStreamTrace(error: TransportError, stream: StreamTrace): TransportError {
  return new TransportError(error.code, error.code === "TIMEOUT" ? `${error.message}; ${streamSummary(stream)}` : error.message, error.retryable, error.retryAfterMs, error.evidence, stream);
}
/** "stream: no event in the 25.0 min it ran" or "stream: 48 events in 15.0 min, the last (assistant) 0.2 min before it stopped", with the end of stderr. */
export function streamSummary(stream: StreamTrace): string {
  const minutes = (from: string, to: string): string => `${(Math.max(0, Date.parse(to) - Date.parse(from)) / 60_000).toFixed(1)} min`;
  const events = stream.events === 0 || stream.lastEventAt === null ? `stream: no event in the ${minutes(stream.startedAt, stream.stoppedAt)} it ran`
    : `stream: ${stream.events} event${stream.events === 1 ? "" : "s"} in ${minutes(stream.startedAt, stream.stoppedAt)}, the last${stream.lastEventType === null ? "" : ` (${stream.lastEventType})`} ${minutes(stream.lastEventAt, stream.stoppedAt)} before it stopped`;
  const tail = stream.stderrTail.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== "").join(" / ").slice(-120);
  return tail === "" ? events : `${events}; stderr: ${tail}`;
}
/** A CLI's process tree outlived its call. The failure is final, so no retry starts another CLI beside it. */
export const PROCESS_TREE_NOT_TERMINATED = "CLI_PROCESS_TREE_NOT_TERMINATED";
export function leftProcessesRunning(error: unknown): error is TransportError {
  return error instanceof TransportError && error.message.startsWith(PROCESS_TREE_NOT_TERMINATED);
}
/** The same failure, with its usage evidence stated. */
export function withUsageEvidence(error: TransportError, evidence: UsageEvidence): TransportError {
  return new TransportError(error.code, error.message, error.retryable, error.retryAfterMs, evidence, error.stream);
}

export interface TransportConfiguration {
  readonly endpoint: string;
  readonly apiKeyEnv: string;
  readonly compatibleProviderName?: string;
  /** Subscription CLI endpoints (`cli://<vendor>`): how the CLI authenticates. No API key is involved. */
  readonly cli?: { readonly auth: "subscription_login" | "oauth_token"; readonly oauthTokenEnv: string | null };
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
