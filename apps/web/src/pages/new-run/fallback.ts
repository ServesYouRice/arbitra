import { modelName, record } from "../run/models.js";
import { getIn, setIn, type Draft } from "./draft.js";
import { equivalentModel, fallbackAliases, profileFor, vendorOf, withEndpoint, withoutUnboundEndpoints, type Route } from "./routes.js";

/**
 * When a model runs out: its work can go on with the same model by the other route, through the API key when the
 * subscription's window is out for longer than the run waits, or through the subscription when the API credit is out
 * or its dollar cap is reached (`workflow.modelExecution.fallbacks`, `maximumCostUsd`). The fallback is a profile of
 * its own, `fallback-<alias>` (not `auditor-…`, which would make it a finder), that follows its model: a depth or model chosen for the lineup is chosen for it too.
 * Observed live (memoria, November 10–11, 2026): the API credit ran out before the plan, and the plan could run on the
 * owner's Claude subscription only by a resume made by hand.
 */
const EXECUTION = ["workflow", "modelExecution"] as const;
export const FALLBACK_PREFIX = "fallback-";

export interface FallbackChoice {
  readonly alias: string;
  /** "Opus 5.5". */
  readonly model: string;
  readonly route: Route;
  /** Its transport now. */
  readonly transport: string;
  /** The transport of the same model by the other route. */
  readonly other: string;
  /** The fallback's alias when one is set. */
  readonly fallback: string | null;
  /** Whether it can take a dollar cap: a model through an API key whose tokens arbitra prices (Claude's, for now). */
  readonly cappable: boolean;
  /** The dollar cap, for a model through an API key. */
  readonly capUsd: number | null;
}

const fallbacksOf = (draft: Draft): Readonly<Record<string, unknown>> => record(getIn(draft, [...EXECUTION, "fallbacks"]));
const capsOf = (draft: Draft): Readonly<Record<string, unknown>> => record(getIn(draft, [...EXECUTION, "maximumCostUsd"]));

/** The lineup's models that the other route offers, each with its fallback and cap as set. */
export function fallbackChoices(draft: Draft): readonly FallbackChoice[] {
  const fallbacks = fallbacksOf(draft); const caps = capsOf(draft); const extra = fallbackAliases(draft);
  return Object.entries(record(draft["models"])).flatMap(([alias, value]) => {
    if (extra.has(alias)) return [];
    const profile = record(value);
    const transport = String(profile["transport"] ?? ""); const vendor = vendorOf(transport);
    if (vendor === undefined) return [];
    const route: Route = vendor.cli === transport ? "cli" : "api";
    const other = route === "cli" ? vendor.api : vendor.cli;
    const modelId = String(profile["modelId"] ?? "");
    if (equivalentModel(modelId, other) === undefined) return [];
    const fallback = typeof fallbacks[alias] === "string" ? fallbacks[alias] as string : null;
    const cap = caps[alias]; const cappable = route === "api" && vendor.provider === "anthropic";
    return [{ alias, model: modelName(modelId), route, transport, other, fallback, cappable, capUsd: cappable && typeof cap === "number" ? cap : null }];
  });
}

/** The lineup with `alias` going on by the other route when it runs out, or pausing (`on` false). */
export function withFallback(draft: Draft, alias: string, on: boolean): Draft {
  const existing = fallbacksOf(draft)[alias];
  let next = draft;
  if (typeof existing === "string") next = setIn(setIn(next, ["models", existing], undefined), [...EXECUTION, "modelEndpoints", existing], undefined);
  next = setIn(next, [...EXECUTION, "fallbacks", alias], undefined);
  if (Object.keys(fallbacksOf(next)).length === 0) next = setIn(next, [...EXECUTION, "fallbacks"], undefined);
  if (on) next = withFallbackProfile(next, alias);
  return withoutUnboundEndpoints(next);
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
 * lineup holds for its fallback too. A model the other route does not offer loses its fallback; a cap on a model no
 * longer reached through an API key is removed.
 */
export function withSyncedFallbacks(draft: Draft): Draft {
  let next = draft;
  for (const alias of Object.keys(fallbacksOf(draft))) {
    const profile = record(record(next["models"])[alias]);
    const choice = Object.keys(profile).length === 0 ? undefined : fallbackChoices(next).find((entry) => entry.alias === alias);
    next = withFallback(next, alias, choice !== undefined);
  }
  for (const alias of Object.keys(capsOf(next))) {
    const transport = String(getIn(next, ["models", alias, "transport"]) ?? "");
    if (vendorOf(transport)?.api !== transport) next = withCostCap(next, alias, null);
  }
  return next === draft || JSON.stringify(next) === JSON.stringify(draft) ? draft : next;
}

function withFallbackProfile(draft: Draft, alias: string): Draft {
  const profile = record(record(draft["models"])[alias]);
  const transport = String(profile["transport"] ?? ""); const vendor = vendorOf(transport);
  if (vendor === undefined) return draft;
  const other = vendor.cli === transport ? vendor.api : vendor.cli;
  const level = /-(low|medium|high)$/u.exec(String(profile["modelId"] ?? ""))?.[1] ?? "high";
  const model = equivalentModel(String(profile["modelId"] ?? ""), other, level);
  if (model === undefined) return draft;
  const added = withEndpoint(draft, other);
  if (added === undefined) return draft;
  const fallback = `${FALLBACK_PREFIX}${alias}`;
  let next = setIn(added.draft, ["models", fallback], profileFor(other, model, profile));
  next = setIn(next, [...EXECUTION, "modelEndpoints", fallback], added.endpoint);
  return setIn(next, [...EXECUTION, "fallbacks", alias], fallback);
}
