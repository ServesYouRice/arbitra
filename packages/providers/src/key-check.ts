import { FetchHttpClient, type HttpClient, type HttpResponse } from "./transport-contract.js";
import { providerErrorDetail } from "./transports/json-transport.js";
import { anthropicMessagesCodec } from "./transports/anthropic-messages.js";
import { geminiNativeCodec } from "./transports/gemini-native.js";

/**
 * Whether an API key endpoint will take a run's calls, asked before the run starts and without a generation: the
 * provider's models route, which costs nothing. `accepted`: the provider answered with the key; `refused`: it refused
 * the key; `missing`: the variable is not set, so nothing was asked; `unchecked`: the provider could not be reached or
 * gave another answer, so the first call will tell. Each model is `known` when the provider lists it for this key,
 * `false` when it says it has no such model, and null when that was not learnt.
 *
 * The models route proves the key and the model name only: it does not prove the account has credit, or that the
 * provider takes the shape of a request (observed live, November 10, 2026: every Anthropic call was refused for a
 * `thinking.effort` field this route never sees).
 */
export interface KeyCheck {
  readonly state: "accepted" | "refused" | "missing" | "unchecked";
  readonly models: readonly { readonly modelId: string; readonly known: boolean | null }[];
  /** The provider's own words for a refusal or another answer, with anything credential-like removed. */
  readonly detail: string | null;
  /** What was spent to learn it: `models_route` is a metadata request, never billed. */
  readonly cost: "models_route" | "none";
}

export interface KeyCheckEndpoint { readonly transport: string; readonly endpoint: string; readonly apiKeyEnvVar: string }
export interface KeyCheckOptions {
  readonly credential: (environmentName: string) => string | undefined;
  readonly client?: HttpClient;
  readonly signal?: AbortSignal;
  /** How long one request may take; 10 seconds by default. */
  readonly timeoutMs?: number;
}

interface Route {
  readonly headers: (key: string) => Readonly<Record<string, string>>;
  /** One request per model (`each`), or one list of the key's models (`list`). */
  readonly ask: { readonly kind: "each"; readonly path: (modelId: string) => string } | { readonly kind: "list"; readonly path: string };
  /** A refused key: Google answers an invalid one with 400 API_KEY_INVALID, not 401. */
  readonly refused: (response: HttpResponse) => boolean;
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const authRefused = ({ status }: HttpResponse) => status === 401 || status === 403;
const ROUTES: Readonly<Record<string, Route>> = {
  "anthropic-messages": { headers: anthropicMessagesCodec.authHeaders, ask: { kind: "each", path: (modelId) => `models/${encodeURIComponent(modelId)}` }, refused: authRefused },
  "gemini-native": { headers: geminiNativeCodec.authHeaders, ask: { kind: "each", path: (modelId) => `models/${encodeURIComponent(modelId.replace(/^models\//u, ""))}` },
    refused: (response) => authRefused(response) || (response.status === 400 && /API_KEY_INVALID|API key not valid/u.test(JSON.stringify(response.body ?? null))) },
  // OpenAI and the providers compatible with it list a key's models at one route; not all of them answer for one model.
  "openai-chat": { headers: bearer, ask: { kind: "list", path: "models" }, refused: authRefused },
  "openai-responses": { headers: bearer, ask: { kind: "list", path: "models" }, refused: authRefused },
};

/** The transports {@link checkApiKey} can check without a generation. */
export const KEY_CHECK_TRANSPORTS: ReadonlySet<string> = new Set(Object.keys(ROUTES));

/** Checks one API key endpoint for the models a run sends to it. Null for a transport with no cheap check. */
export async function checkApiKey(endpoint: KeyCheckEndpoint, modelIds: readonly string[], options: KeyCheckOptions): Promise<KeyCheck | null> {
  const route = Object.hasOwn(ROUTES, endpoint.transport) ? ROUTES[endpoint.transport] : undefined;
  if (route === undefined) return null;
  const ids = [...new Set(modelIds)];
  const unknown = (state: KeyCheck["state"], detail: string | null, cost: KeyCheck["cost"] = "models_route"): KeyCheck => ({ state, models: ids.map((modelId) => ({ modelId, known: null })), detail, cost });
  const key = options.credential(endpoint.apiKeyEnvVar);
  if (key === undefined || key.length === 0) return unknown("missing", null, "none");
  // A provider's error text may echo what it was sent; the key never leaves this function in it.
  const scrub = (text: string | null) => text === null ? null : text.split(key).join("<redacted>");
  const base = new URL(endpoint.endpoint);
  base.pathname = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  const client = options.client ?? new FetchHttpClient();
  const get = async (path: string): Promise<HttpResponse | string> => {
    const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 10_000), ...(options.signal === undefined ? [] : [options.signal])]);
    try { return await client.send({ url: new URL(path, base).toString(), method: "GET", headers: route.headers(key), body: undefined, signal }); }
    // Only the failure's kind is kept: a client's message may quote the request.
    catch (error) { const cause = (error as { cause?: { code?: unknown } }).cause?.code; return `the provider could not be reached${typeof cause === "string" ? ` (${cause})` : ""}`; }
  };
  const other = (response: HttpResponse) => { const detail = providerErrorDetail(response.body); return scrub(`HTTP ${response.status}${detail === null ? "" : `: ${detail}`}`) ?? ""; };
  if (route.ask.kind === "list") {
    const response = await get(route.ask.path);
    if (typeof response === "string") return unknown("unchecked", response);
    if (route.refused(response)) return unknown("refused", scrub(providerErrorDetail(response.body)));
    const data = (response.body as { data?: unknown } | null)?.data;
    if (response.status !== 200 || !Array.isArray(data)) return unknown("unchecked", other(response));
    const listed = new Set(data.flatMap((entry) => typeof (entry as { id?: unknown } | null)?.id === "string" ? [(entry as { id: string }).id] : []));
    return { state: "accepted", models: ids.map((modelId) => ({ modelId, known: listed.has(modelId) || listed.has(`models/${modelId}`) })), detail: null, cost: "models_route" };
  }
  // With no model to ask about (a template's placeholders are never sent), the key alone is checked on the list route.
  if (ids.length === 0) {
    const response = await get("models");
    if (typeof response === "string") return unknown("unchecked", response);
    if (route.refused(response)) return unknown("refused", scrub(providerErrorDetail(response.body)));
    return response.status === 200 ? unknown("accepted", null) : unknown("unchecked", other(response));
  }
  const models: { modelId: string; known: boolean | null }[] = [];
  let answered = false; let detail: string | null = null;
  for (const modelId of ids) {
    const response = await get(route.ask.path(modelId));
    if (typeof response === "string") { detail ??= response; models.push({ modelId, known: null }); continue; }
    if (route.refused(response)) return unknown("refused", scrub(providerErrorDetail(response.body)));
    if (response.status === 200) { answered = true; models.push({ modelId, known: true }); continue; }
    // Anthropic answers a model the key cannot use, or that does not exist, with 404 not_found_error.
    if (response.status === 404) { answered = true; models.push({ modelId, known: false }); continue; }
    detail ??= other(response); models.push({ modelId, known: null });
  }
  return { state: answered ? "accepted" : "unchecked", models, detail: answered ? null : detail, cost: "models_route" };
}
