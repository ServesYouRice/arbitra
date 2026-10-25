import subscriptionAuditGemini from "../../../../../examples/model-backed/subscription-audit-gemini.json" with { type: "json" };
import { record } from "../run/models.js";
import { getIn, setIn, type Draft } from "./draft.js";
import { MODEL_CATALOG, modelSettings } from "./model-catalog.js";

/**
 * Depth presets for a subscription audit (Claude Code and Codex): a depth is the models and the effort of each step, in
 * each vendor's own effort word, and nothing else. Every step runs at every depth; the plan critic is a switch of its
 * own, off by default, and two or three finders is a choice of its own. Decided by the owner on October 25, 2026 from
 * the research in arbitra-experiments/depth-2026-10-25. Critical and high issues are always checked by the strongest
 * checker (Opus). Gemini is only ever given optional work, at high at every depth: the third finder, and the variant
 * search when it is switched on. It is never given a core step (checking, second opinion, merging, planning, the critic).
 */
export type Depth = "deep" | "balanced" | "cheap";
export type FinderCount = 2 | 3;

type Alias = "auditor-a" | "auditor-b" | "checker" | "medium-checker" | "second-opinion";
type Level = "low" | "medium" | "high" | "xhigh" | "max";

interface DepthPreset {
  readonly label: string;
  /** What the depth writes, step by step, as models and efforts. */
  readonly summary: string;
  /** The model of each profile the depth uses. Profiles other than the two finders are added only where a depth needs them. */
  readonly models: Readonly<Partial<Record<Alias, string>>>;
  readonly roles: Readonly<{ planner: Alias; verifier: Alias; mediumVerifier?: Alias; merger?: Alias; secondOpinion: Alias; critic: Alias; critiqueChecker: Alias }>;
  /** Finding issues, per finder; the third finder, Gemini, always finds at high. */
  readonly discovery: Readonly<Record<"auditor-a" | "auditor-b", Level>>;
  readonly efforts: Readonly<{ clustering: Level; peerReview: Level; verification: Level; secondOpinion: Level; critiqueCheck: Level; planner: Level; critic: Level; revision: Level }>;
}

const OPUS = "claude-opus-5-5"; const SONNET = "claude-sonnet-5-5"; const SOL = "gpt-6.1-sol"; const LUNA = "gpt-6-luna";
/** The model the third finder runs, and its effort: Gemini's effort is part of its model ID. */
export const THIRD_FINDER_EFFORT: Level = "high";

export const DEPTHS: Readonly<Record<Depth, DepthPreset>> = Object.freeze({
  deep: {
    label: "deep · the frontier models at full effort",
    summary: "Find: Opus 5.5 xhigh and GPT-6.1 Sol xhigh. Merge: Opus low. Check: Opus high; before rejecting a critical or high issue, a second opinion from Sol high. Plan: Opus high. Review the plan, when switched on: Sol high, its items checked by Opus high.",
    models: { "auditor-a": OPUS, "auditor-b": SOL },
    roles: { planner: "auditor-a", verifier: "auditor-a", secondOpinion: "auditor-b", critic: "auditor-b", critiqueChecker: "auditor-a" },
    discovery: { "auditor-a": "xhigh", "auditor-b": "xhigh" },
    efforts: { clustering: "low", peerReview: "high", verification: "high", secondOpinion: "high", critiqueCheck: "high", planner: "high", critic: "high", revision: "high" },
  },
  balanced: {
    label: "balanced · the frontier models at medium effort",
    summary: "Find: Opus 5.5 medium and GPT-6.1 Sol medium. Merge: Opus low. Check: critical and high issues Opus high, medium ones Sonnet 5.5 high; second opinion before rejecting a severe issue Sol medium. Plan: Opus medium. Review the plan, when switched on: Sol medium, its items checked by Opus medium.",
    models: { "auditor-a": OPUS, "auditor-b": SOL, "medium-checker": SONNET },
    roles: { planner: "auditor-a", verifier: "auditor-a", mediumVerifier: "medium-checker", secondOpinion: "auditor-b", critic: "auditor-b", critiqueChecker: "auditor-a" },
    discovery: { "auditor-a": "medium", "auditor-b": "medium" },
    efforts: { clustering: "low", peerReview: "medium", verification: "high", secondOpinion: "medium", critiqueCheck: "medium", planner: "medium", critic: "medium", revision: "medium" },
  },
  cheap: {
    label: "cheap · the lighter models, the strongest only on severe issues",
    summary: "Find: Sonnet 5.5 high and GPT-6 Luna max. Merge: Sonnet medium. Check: critical and high issues Opus 5.5 high, medium ones Sonnet high; second opinion before rejecting a severe issue GPT-6.1 Sol medium. Plan: Sonnet high. Review the plan, when switched on: Luna high, its items checked by Sonnet high.",
    models: { "auditor-a": SONNET, "auditor-b": LUNA, checker: OPUS, "second-opinion": SOL },
    roles: { planner: "auditor-a", verifier: "checker", mediumVerifier: "auditor-a", merger: "auditor-a", secondOpinion: "second-opinion", critic: "auditor-b", critiqueChecker: "auditor-a" },
    discovery: { "auditor-a": "high", "auditor-b": "max" },
    efforts: { clustering: "medium", peerReview: "high", verification: "high", secondOpinion: "medium", critiqueCheck: "high", planner: "high", critic: "high", revision: "high" },
  },
});

/** The profiles a depth may add beside the finders, each on its finder's CLI. */
const EXTRA: Readonly<Record<Exclude<Alias, "auditor-a" | "auditor-b">, "auditor-a" | "auditor-b">> = Object.freeze({ checker: "auditor-a", "medium-checker": "auditor-a", "second-opinion": "auditor-b" });

const execution = (draft: Draft) => record(getIn(draft, ["workflow", "modelExecution"]));
const transportOf = (draft: Draft, alias: string) => record(record(draft["models"])[alias])["transport"];

/** Whether the draft is an audit on Claude Code and Codex, the lineup the depth presets are written for. */
export function isSubscriptionAudit(draft: Draft): boolean {
  return draft["mode"] === "audit" && transportOf(draft, "auditor-a") === "claude-code-cli" && transportOf(draft, "auditor-b") === "codex-cli" && getIn(draft, ["workflow", "modelExecution", "modelEndpoints"]) !== undefined;
}

/** How many finders the draft runs, by its preset (the earlier names count too). */
export function findersOf(draft: Draft): FinderCount {
  const preset = getIn(draft, ["workflow", "preset"]);
  return preset === "audit-three-finders" || preset === "audit-deep" ? 3 : 2;
}

/**
 * The draft at a depth. On a subscription audit it writes each profile's model, the roles and every step's effort;
 * a profile the depth no longer uses (one cheap or balanced added) is removed with its endpoint binding. Any other
 * configuration keeps its models and efforts, and only its depth label (the level a stage left unset runs at) changes.
 */
export function withDepth(draft: Draft, depth: Depth): Draft {
  let next = setIn(draft, ["auditDepth"], depth);
  if (!isSubscriptionAudit(draft)) return next;
  const preset = DEPTHS[depth];
  const endpoints = record(execution(draft)["modelEndpoints"]);
  for (const [alias, base] of Object.entries(EXTRA)) {
    if (preset.models[alias as Alias] !== undefined) {
      next = setIn(next, ["models", alias], record(record(draft["models"])[base]));
      next = setIn(next, ["workflow", "modelExecution", "modelEndpoints", alias], endpoints[base]);
    } else {
      next = setIn(setIn(next, ["models", alias], undefined), ["workflow", "modelExecution", "modelEndpoints", alias], undefined);
    }
  }
  for (const [alias, modelId] of Object.entries(preset.models)) {
    const model = MODEL_CATALOG[String(transportOf(next, alias))]?.find((entry) => entry.modelId === modelId);
    if (model === undefined) throw new Error(`DEPTH_MODEL_NOT_IN_CATALOG:${modelId}`);
    for (const [path, value] of modelSettings(model)) next = setIn(next, ["models", alias, ...path], value);
  }
  next = setIn(next, ["workflow", "modelExecution", "roles"], { ...preset.roles });
  next = setIn(next, ["workflow", "modelExecution", "stageEffort"], { discovery: discoveryEffort(preset.discovery, findersOf(next)), ...preset.efforts });
  return searching(next) ? withVariantSearch(next, true) : next;
}

/** The profile that searches for variants on a lineup without Gemini: Sonnet 5.5, on the first finder's CLI. */
const VARIANT_SEARCHER = "variant-searcher";
/** The variant search's effort at every depth, whichever model searches. */
export const VARIANT_SEARCH_EFFORT: Level = "high";
const searching = (draft: Draft) => getIn(draft, ["workflow", "variantSearch"]) === true;

/**
 * The draft with the variant search on or off (`workflow.variantSearch`). On a subscription audit the searcher is
 * Gemini 3.8 Flash, the third finder, when Gemini is in the lineup, else Sonnet 5.5 on Claude Code, a profile of its
 * own, at high at every depth: the search only proposes, and what it proposes is checked like any finding, so it is
 * work the owner gives Gemini freely (October 25, 2026). Switched off, the searcher and its profile go. Any other
 * configuration only switches the step and names its searcher under roles.
 */
export function withVariantSearch(draft: Draft, on: boolean): Draft {
  let next = setIn(draft, ["workflow", "variantSearch"], on);
  if (!isSubscriptionAudit(draft)) return next;
  const gemini = transportOf(next, "auditor-c") === "antigravity-cli";
  const sonnet = MODEL_CATALOG["claude-code-cli"]?.find(({ modelId }) => modelId === SONNET);
  if (on && !gemini && sonnet !== undefined) {
    let profile: Draft = record(record(next["models"])["auditor-a"]);
    for (const [path, value] of modelSettings(sonnet)) profile = setIn(profile, path, value);
    next = setIn(setIn(next, ["models", VARIANT_SEARCHER], profile), ["workflow", "modelExecution", "modelEndpoints", VARIANT_SEARCHER], record(execution(next)["modelEndpoints"])["auditor-a"]);
  } else next = setIn(setIn(next, ["models", VARIANT_SEARCHER], undefined), ["workflow", "modelExecution", "modelEndpoints", VARIANT_SEARCHER], undefined);
  next = setIn(next, ["workflow", "modelExecution", "roles", "variantSearcher"], on ? gemini ? "auditor-c" : VARIANT_SEARCHER : undefined);
  return setIn(next, ["workflow", "modelExecution", "stageEffort", "variantSearch"], on ? VARIANT_SEARCH_EFFORT : undefined);
}

/** Finding's effort: one level when every finder shares it, else one per finder; Gemini, the third, always high. */
function discoveryEffort(finders: DepthPreset["discovery"], count: FinderCount): Level | Readonly<Record<string, Level>> {
  const levels: Record<string, Level> = { ...finders, ...(count === 3 ? { "auditor-c": THIRD_FINDER_EFFORT } : {}) };
  const distinct = new Set(Object.values(levels));
  return distinct.size === 1 ? [...distinct][0] as Level : levels;
}

const GEMINI = subscriptionAuditGemini as unknown as Draft;
const GEMINI_ENDPOINT = (getIn(GEMINI, ["workflow", "modelExecution", "endpoints"]) as readonly { readonly id: string; readonly providerId: string; readonly transport: string }[]).find(({ transport }) => transport === "antigravity-cli");

/**
 * The draft with two finders (Claude, GPT) or three (Gemini added through the Antigravity CLI). The third finder is
 * Gemini 3.8 Flash at high thinking at every depth, and only a finder: its findings are checked like any other.
 * Google's terms do not support driving the Antigravity CLI from another application on a consumer plan, so New
 * run says so where three are chosen.
 */
export function withFinders(draft: Draft, count: FinderCount): Draft {
  if (!isSubscriptionAudit(draft) || GEMINI_ENDPOINT === undefined) return draft;
  const present = record(draft["models"])["auditor-c"] !== undefined;
  let next = setIn(draft, ["workflow", "preset"], count === 3 ? "audit-three-finders" : "audit-two-finders");
  const endpoints = (execution(draft)["endpoints"] ?? []) as readonly { readonly id: string; readonly providerId: string }[];
  if (count === 3 && !present) {
    const model = MODEL_CATALOG["antigravity-cli"]?.[0];
    let profile: Draft = record(record(GEMINI["models"])["auditor-c"]);
    if (model !== undefined) for (const [path, value] of modelSettings(model)) profile = setIn(profile, path, value);
    next = setIn(next, ["models", "auditor-c"], profile);
    if (!endpoints.some(({ id }) => id === GEMINI_ENDPOINT.id)) next = setIn(next, ["workflow", "modelExecution", "endpoints"], [...endpoints, GEMINI_ENDPOINT]);
    next = setIn(next, ["workflow", "modelExecution", "modelEndpoints", "auditor-c"], GEMINI_ENDPOINT.id);
    next = setIn(next, ["workflow", "modelExecution", "rateLimits", GEMINI_ENDPOINT.providerId], getIn(GEMINI, ["workflow", "modelExecution", "rateLimits", GEMINI_ENDPOINT.providerId]));
  }
  if (count === 2 && present) {
    next = setIn(setIn(next, ["models", "auditor-c"], undefined), ["workflow", "modelExecution", "modelEndpoints", "auditor-c"], undefined);
    const bound = new Set(Object.values(record(execution(next)["modelEndpoints"])));
    const kept = endpoints.filter(({ id }) => bound.has(id));
    next = setIn(next, ["workflow", "modelExecution", "endpoints"], kept);
    for (const provider of new Set(endpoints.map(({ providerId }) => providerId))) if (!kept.some(({ providerId }) => providerId === provider)) next = setIn(next, ["workflow", "modelExecution", "rateLimits", provider], undefined);
  }
  const adjusted = withFinderEfforts(next, count);
  return searching(adjusted) ? withVariantSearch(adjusted, true) : adjusted;
}

/** Every per-profile effort without the third finder, or with it at high for finding issues. */
function withFinderEfforts(draft: Draft, count: FinderCount): Draft {
  const efforts = record(execution(draft)["stageEffort"]);
  if (Object.keys(efforts).length === 0) return draft;
  const adjusted = Object.fromEntries(Object.entries(efforts).map(([stage, value]) => {
    if (typeof value === "string") return [stage, stage === "discovery" && count === 3 && value !== THIRD_FINDER_EFFORT ? { "auditor-a": value, "auditor-b": value, "auditor-c": THIRD_FINDER_EFFORT } : value];
    const others = Object.fromEntries(Object.entries(record(value)).filter(([alias]) => alias !== "auditor-c"));
    const levels = stage === "discovery" && count === 3 ? { ...others, "auditor-c": THIRD_FINDER_EFFORT } : others;
    const distinct = new Set(Object.values(levels));
    return [stage, distinct.size === 1 && Object.keys(levels).length >= 2 ? [...distinct][0] : levels];
  }));
  return setIn(draft, ["workflow", "modelExecution", "stageEffort"], adjusted);
}
