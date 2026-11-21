import { modelName, record } from "../run/models.js";
import { getIn, setIn, type Draft } from "./draft.js";
import { antigravityModel, otherLimitModel, usageGroup, type OfferedModels } from "./model-catalog.js";
import { equivalentModel, fallbackAliases, profileFor, vendorOf, withEndpoint, withoutUnboundEndpoints, type Route } from "./routes.js";

/**
 * When a model runs out: its work can go on with the same model by the other route, through the API key when the
 * subscription's window is out for longer than the run waits, or through the subscription when the API credit is out
 * or its dollar cap is reached (`workflow.modelExecution.fallbacks`, `maximumCostUsd`). A Gemini model through
 * Antigravity can also go on with a Gemini model of Antigravity's other usage limit (model-catalog.ts, `usageGroup`):
 * observed live (November 21, 2026), Gemini 4 Argon met its own weekly limit after 34 minutes and the finder was left
 * out while the other Gemini models had all of theirs. The fallback is a profile of its own, `fallback-<alias>` (not
 * `auditor-…`, which would make it a finder), that follows its model: a depth or model chosen for the lineup is chosen for it too.
 * Observed live (memoria, November 10–11, 2026): the API credit ran out before the plan, and the plan could run on the
 * owner's Claude subscription only by a resume made by hand.
 */
const EXECUTION = ["workflow", "modelExecution"] as const;
export const FALLBACK_PREFIX = "fallback-";

/** How a fallback goes on: the same model by the other route, or another model by the same route. */
export type FallbackKind = "route" | "model";

export interface FallbackChoice {
  readonly alias: string;
  /** "Opus 5.5". */
  readonly model: string;
  readonly route: Route;
  /** Its transport now. */
  readonly transport: string;
  /** The transport of the same model by the other route, or null when that route does not offer it. */
  readonly other: string | null;
  /** The model of the other usage limit by the same route (a Gemini model through Antigravity), or null when there is none. */
  readonly sameRoute: { readonly modelId: string; readonly model: string } | null;
  /** The fallback's alias when one is set. */
  readonly fallback: string | null;
  /** How the fallback set goes on, or null when none is set. */
  readonly kind: FallbackKind | null;
  /** Whether the run goes on without the model when it runs out and has no fallback: a finder the run can do without
   * (two others stay, and it holds no role but the variant search), which the run leaves out rather than pause for. */
  readonly optional: boolean;
  /** Whether it can take a dollar cap: a model through an API key whose tokens arbitra prices (Claude's, for now). */
  readonly cappable: boolean;
  /** The dollar cap, for a model through an API key. */
  readonly capUsd: number | null;
}

const fallbacksOf = (draft: Draft): Readonly<Record<string, unknown>> => record(getIn(draft, [...EXECUTION, "fallbacks"]));
const capsOf = (draft: Draft): Readonly<Record<string, unknown>> => record(getIn(draft, [...EXECUTION, "maximumCostUsd"]));
const profileOf = (draft: Draft, alias: string): Readonly<Record<string, unknown>> => record(record(draft["models"])[alias]);

/**
 * The model `alias` goes on with by the same route when its usage limit is out: the first of the other limit's group
 * the CLI lists, else (the list not read yet) the fallback it has, while that is still of the other group.
 */
function sameRouteTarget(draft: Draft, alias: string, offered: OfferedModels): string | undefined {
  const profile = profileOf(draft, alias);
  const transport = String(profile["transport"] ?? ""); const modelId = String(profile["modelId"] ?? "");
  const listed = otherLimitModel(transport, modelId, offered)?.modelId;
  if (listed !== undefined || offered[transport] !== undefined) return listed;
  const existing = fallbacksOf(draft)[alias];
  const fallback = typeof existing === "string" ? profileOf(draft, existing) : {};
  return fallback["transport"] === transport && transport === "antigravity-cli" && typeof fallback["modelId"] === "string" && usageGroup(fallback["modelId"]) !== usageGroup(modelId) ? fallback["modelId"] : undefined;
}

/** Whether the run leaves `alias` out rather than pause for it: a finder with no role but the variant search, two others staying. */
function optionalFinder(draft: Draft, alias: string): boolean {
  const finders = Object.keys(record(draft["models"])).filter((name) => name.startsWith("auditor-"));
  const held = Object.entries(record(getIn(draft, [...EXECUTION, "roles"]))).some(([role, named]) => named === alias && role !== "variantSearcher");
  return alias.startsWith("auditor-") && !held && finders.length >= 3;
}

/** The lineup's models that another route or another usage limit offers, each with its fallback and cap as set. */
export function fallbackChoices(draft: Draft, offered: OfferedModels = {}): readonly FallbackChoice[] {
  const fallbacks = fallbacksOf(draft); const caps = capsOf(draft); const extra = fallbackAliases(draft);
  return Object.entries(record(draft["models"])).flatMap(([alias, value]) => {
    if (extra.has(alias)) return [];
    const profile = record(value);
    const transport = String(profile["transport"] ?? ""); const vendor = vendorOf(transport);
    if (vendor === undefined) return [];
    const route: Route = vendor.cli === transport ? "cli" : "api";
    const otherTransport = route === "cli" ? vendor.api : vendor.cli;
    const modelId = String(profile["modelId"] ?? "");
    const other = equivalentModel(modelId, otherTransport) === undefined ? null : otherTransport;
    const target = sameRouteTarget(draft, alias, offered);
    if (other === null && target === undefined) return [];
    const fallback = typeof fallbacks[alias] === "string" ? fallbacks[alias] as string : null;
    const kind: FallbackKind | null = fallback === null ? null : profileOf(draft, fallback)["transport"] === transport ? "model" : "route";
    const cap = caps[alias]; const cappable = route === "api" && vendor.provider === "anthropic";
    return [{ alias, model: modelName(modelId), route, transport, other, sameRoute: target === undefined ? null : { modelId: target, model: modelName(target) }, fallback, kind,
      optional: optionalFinder(draft, alias), cappable, capUsd: cappable && typeof cap === "number" ? cap : null }];
  });
}

/**
 * The lineup with `alias` going on by the other route ("route", or true), with the model of the other usage limit by
 * the same route ("model"), or with no fallback (false), so the run pauses for it or leaves an optional finder out.
 */
export function withFallback(draft: Draft, alias: string, how: FallbackKind | boolean, offered: OfferedModels = {}): Draft {
  const kind: FallbackKind | null = how === true ? "route" : how === false ? null : how;
  // Chosen before the fallback it has goes: without the CLI's list, that fallback is the one kept.
  const target = kind === "model" ? sameRouteTarget(draft, alias, offered) : undefined;
  const existing = fallbacksOf(draft)[alias];
  if (kind === null && existing === undefined) return draft;
  let next = draft;
  if (typeof existing === "string") next = setIn(setIn(next, ["models", existing], undefined), [...EXECUTION, "modelEndpoints", existing], undefined);
  next = setIn(next, [...EXECUTION, "fallbacks", alias], undefined);
  if (Object.keys(fallbacksOf(next)).length === 0) next = setIn(next, [...EXECUTION, "fallbacks"], undefined);
  if (kind === "route") next = withFallbackProfile(next, alias);
  if (kind === "model" && target !== undefined) next = withSameRouteProfile(next, alias, target);
  return withoutUnboundEndpoints(next);
}

/**
 * The lineup with each Gemini model through Antigravity (of `aliases`, or all) given the model of the other usage limit
 * as its fallback, where the CLI lists one and the model has no fallback yet. A template and a third finder start with
 * it; a person can take it away under "when a model runs out".
 */
export function withUsageLimitFallbacks(draft: Draft, offered: OfferedModels, aliases?: readonly string[]): Draft {
  let next = draft;
  for (const choice of fallbackChoices(draft, offered)) {
    if (choice.fallback === null && choice.sameRoute !== null && (aliases === undefined || aliases.includes(choice.alias))) next = withFallback(next, choice.alias, "model", offered);
  }
  return next;
}

/** A dollar cap for a model through an API key; null removes it. */
export function withCostCap(draft: Draft, alias: string, usd: number | null): Draft {
  const next = setIn(draft, [...EXECUTION, "maximumCostUsd", alias], usd === null || !Number.isFinite(usd) || usd <= 0 ? undefined : usd);
  return Object.keys(capsOf(next)).length === 0 ? setIn(next, [...EXECUTION, "maximumCostUsd"], undefined) : next;
}

/** The lineup with every fallback, fallback profile and dollar cap removed: a change of route sets them afresh. */
export function withoutFallbacks(draft: Draft): Draft {
  let next = draft;
  for (const alias of Object.keys(fallbacksOf(draft))) next = withFallback(next, alias, false);
  return setIn(next, [...EXECUTION, "maximumCostUsd"], undefined);
}

/**
 * Each fallback profile made again from its model as the lineup has it now, so a depth, model or effort chosen for the
 * lineup holds for its fallback too, and a Gemini model's fallback stays one of the other usage limit. A model the
 * other route, or the other limit, no longer offers loses its fallback; a cap on a model no longer reached through an
 * API key is removed.
 */
export function withSyncedFallbacks(draft: Draft, offered: OfferedModels = {}): Draft {
  let next = draft;
  for (const alias of Object.keys(fallbacksOf(draft))) {
    const profile = profileOf(next, alias);
    const choice = Object.keys(profile).length === 0 ? undefined : fallbackChoices(next, offered).find((entry) => entry.alias === alias);
    const kept: FallbackKind | false = choice?.kind === "route" && choice.other !== null ? "route" : choice?.kind === "model" && choice.sameRoute !== null ? "model" : false;
    next = withFallback(next, alias, kept, offered);
  }
  for (const alias of Object.keys(capsOf(next))) {
    const transport = String(getIn(next, ["models", alias, "transport"]) ?? "");
    if (vendorOf(transport)?.api !== transport) next = withCostCap(next, alias, null);
  }
  return next === draft || JSON.stringify(next) === JSON.stringify(draft) ? draft : next;
}

function withFallbackProfile(draft: Draft, alias: string): Draft {
  const profile = profileOf(draft, alias);
  const transport = String(profile["transport"] ?? ""); const vendor = vendorOf(transport);
  if (vendor === undefined) return draft;
  const other = vendor.cli === transport ? vendor.api : vendor.cli;
  const level = /-(low|medium|high)$/u.exec(String(profile["modelId"] ?? ""))?.[1] ?? "high";
  const model = equivalentModel(String(profile["modelId"] ?? ""), other, level);
  if (model === undefined) return draft;
  const added = withEndpoint(draft, other);
  if (added === undefined) return draft;
  return withFallbackOn(added.draft, alias, profileFor(other, model, profile), added.endpoint);
}

/** The fallback on another model through the same CLI and endpoint as `alias`: its own usage limit, the same login. */
function withSameRouteProfile(draft: Draft, alias: string, modelId: string): Draft {
  const transport = String(profileOf(draft, alias)["transport"] ?? "");
  const endpoint = getIn(draft, [...EXECUTION, "modelEndpoints", alias]);
  if (typeof endpoint !== "string") return draft;
  return withFallbackOn(draft, alias, profileFor(transport, antigravityModel(modelId), profileOf(draft, alias)), endpoint);
}

function withFallbackOn(draft: Draft, alias: string, profile: Draft, endpoint: string): Draft {
  const fallback = `${FALLBACK_PREFIX}${alias}`;
  const next = setIn(setIn(draft, ["models", fallback], profile), [...EXECUTION, "modelEndpoints", fallback], endpoint);
  return setIn(next, [...EXECUTION, "fallbacks", alias], fallback);
}
