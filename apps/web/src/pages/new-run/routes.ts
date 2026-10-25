import auditMixedProviders from "../../../../../examples/model-backed/audit-mixed-providers.json" with { type: "json" };
import subscriptionAudit from "../../../../../examples/model-backed/subscription-audit.json" with { type: "json" };
import subscriptionAuditGemini from "../../../../../examples/model-backed/subscription-audit-gemini.json" with { type: "json" };
import { record } from "../run/models.js";
import { getIn, setIn, type Draft } from "./draft.js";
import { MODEL_CATALOG, modelSettings, type CatalogModel } from "./model-catalog.js";

/**
 * How a lineup reaches its models: through the vendors' CLIs signed in on this computer, or through each vendor's API
 * with a key. A depth writes the same models and efforts either way; only the endpoints and the profiles' transports
 * differ. The endpoints and profile settings come from the repository's own templates (`examples/model-backed/`),
 * which `pnpm run validate:examples` keeps passing preflight.
 */
export type Route = "cli" | "api";

interface Vendor { readonly provider: string; readonly family: string; readonly cli: string; readonly api: string }
const VENDORS: readonly Vendor[] = Object.freeze([
  { provider: "anthropic", family: "claude", cli: "claude-code-cli", api: "anthropic-messages" },
  { provider: "openai", family: "gpt", cli: "codex-cli", api: "openai-responses" },
  { provider: "google", family: "gemini", cli: "antigravity-cli", api: "gemini-native" },
]);
/** An OpenAI-compatible chat endpoint (Kimi through Moonshot, OpenRouter, a local server): the same whichever route. */
export const COMPATIBLE_TRANSPORT = "openai-chat";
export const vendorOf = (transport: unknown): Vendor | undefined => VENDORS.find(({ cli, api }) => cli === transport || api === transport);
export const transportFor = (provider: string, route: Route): string | undefined => VENDORS.find((vendor) => vendor.provider === provider)?.[route];

interface Endpoint { readonly id: string; readonly providerId: string; readonly transport: string }
const templates = [subscriptionAudit, subscriptionAuditGemini, auditMixedProviders] as unknown as readonly Draft[];
const endpointsOf = (draft: Draft): readonly Endpoint[] => (getIn(draft, ["workflow", "modelExecution", "endpoints"]) ?? []) as readonly Endpoint[];
/** Each transport's endpoint, model profile and rate policy as the templates write them. */
function template(transport: string): { readonly endpoint: Endpoint; readonly profile: Draft; readonly rateLimit: unknown } | undefined {
  for (const config of templates) {
    const endpoint = endpointsOf(config).find((entry) => entry.transport === transport);
    const alias = Object.entries(record(config["models"])).find(([, profile]) => record(profile)["transport"] === transport)?.[0];
    if (endpoint !== undefined && alias !== undefined) return { endpoint, profile: record(record(config["models"])[alias]), rateLimit: getIn(config, ["workflow", "modelExecution", "rateLimits", endpoint.providerId]) };
  }
  return undefined;
}

/**
 * The route every vendor model of the lineup takes, or null when they take both. A model on an OpenAI-compatible
 * endpoint is reached the same way on either route, so it does not decide it.
 */
export function routeOf(draft: Draft): Route | null {
  const transports = Object.values(record(draft["models"])).map((profile) => record(profile)["transport"]).filter((transport) => transport !== COMPATIBLE_TRANSPORT);
  if (transports.length === 0) return null;
  if (transports.every((transport) => VENDORS.some(({ cli }) => cli === transport))) return "cli";
  if (transports.every((transport) => VENDORS.some(({ api }) => api === transport))) return "api";
  return null;
}

const LEVEL_IN_ID = /-(low|medium|high)$/u;
/**
 * The same model on another route, or undefined when the other route does not offer it. Claude and GPT models are the
 * same IDs through the CLI and the API; Gemini through Antigravity carries its thinking level in the ID
 * (`gemini-3.8-flash-high`), which its API takes as a setting instead. An Argon model is offered by Antigravity only.
 */
export function equivalentModel(modelId: string, transport: string, level = "high"): CatalogModel | undefined {
  const catalog = MODEL_CATALOG[transport] ?? [];
  return catalog.find((model) => model.modelId === modelId) ?? catalog.find((model) => model.modelId === modelId.replace(LEVEL_IN_ID, ""))
    ?? catalog.find((model) => model.modelId === `${modelId}-${level}`);
}

/** A profile for a model on a transport, from the template's profile for it with the model's settings written in. */
export function profileFor(transport: string, model: CatalogModel | undefined, fallback: Draft): Draft {
  let profile = template(transport)?.profile ?? fallback;
  if (model !== undefined) for (const [path, value] of modelSettings(model)) profile = setIn(profile, path, value);
  else profile = setIn(setIn(profile, ["modelId"], fallback["modelId"]), ["family"], fallback["family"]);
  return profile;
}

/** The lineup with a transport's endpoint present and its provider's rate policy set; the endpoint's ID is returned. */
export function withEndpoint(draft: Draft, transport: string): { readonly draft: Draft; readonly endpoint: string } | undefined {
  const present = endpointsOf(draft).find((entry) => entry.transport === transport);
  if (present !== undefined) return { draft, endpoint: present.id };
  const found = template(transport);
  if (found === undefined) return undefined;
  const taken = new Set(endpointsOf(draft).map(({ id }) => id));
  const endpoint = taken.has(found.endpoint.id) ? { ...found.endpoint, id: `${found.endpoint.id}-${transport}` } : found.endpoint;
  let next = setIn(draft, ["workflow", "modelExecution", "endpoints"], [...endpointsOf(draft), endpoint]);
  if (getIn(next, ["workflow", "modelExecution", "rateLimits", endpoint.providerId]) === undefined) next = setIn(next, ["workflow", "modelExecution", "rateLimits", endpoint.providerId], found.rateLimit);
  return { draft: next, endpoint: endpoint.id };
}

/** The lineup without endpoints no profile is bound to, and without the rate policy of a provider it no longer calls. */
export function withoutUnboundEndpoints(draft: Draft): Draft {
  const endpoints = endpointsOf(draft);
  const bound = new Set(Object.values(record(getIn(draft, ["workflow", "modelExecution", "modelEndpoints"]))));
  const kept = endpoints.filter(({ id }) => bound.has(id));
  if (kept.length === endpoints.length) return draft;
  let next = setIn(draft, ["workflow", "modelExecution", "endpoints"], kept);
  for (const provider of new Set(endpoints.map(({ providerId }) => providerId))) if (!kept.some(({ providerId }) => providerId === provider)) next = setIn(next, ["workflow", "modelExecution", "rateLimits", provider], undefined);
  return next;
}

/**
 * The lineup with every model reached through the other route: each profile moves to the same vendor's CLI or API,
 * with the same model where that route offers it. A model the route does not offer (an Argon model through an API key)
 * keeps its ID, and the page says so on its card and before Start.
 */
export function withRoute(draft: Draft, route: Route): Draft {
  if (routeOf(draft) === route || routeOf(draft) === null) return draft;
  let next = draft;
  for (const [alias, value] of Object.entries(record(draft["models"]))) {
    const profile = record(value);
    const vendor = vendorOf(profile["transport"]);
    if (vendor === undefined) continue;
    const transport = vendor[route];
    const added = withEndpoint(next, transport);
    if (added === undefined) continue;
    next = added.draft;
    const level = /-(low|medium|high)$/u.exec(String(profile["modelId"] ?? ""))?.[1] ?? "high";
    next = setIn(next, ["models", alias], profileFor(transport, equivalentModel(String(profile["modelId"] ?? ""), transport, level), profile));
    next = setIn(next, ["workflow", "modelExecution", "modelEndpoints", alias], added.endpoint);
  }
  return withoutUnboundEndpoints(next);
}

/** Whether a profile's model is one its transport is not known to offer: the cue to say so rather than hide it. */
export function notOffered(transport: string, modelId: string, offered: readonly string[] = []): boolean {
  const catalog = MODEL_CATALOG[transport];
  return catalog !== undefined && !catalog.some((model) => model.modelId === modelId) && !offered.includes(modelId);
}
