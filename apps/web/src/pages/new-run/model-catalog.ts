import { setIn, type Draft } from "./draft.js";

/**
 * The models arbitra knows to work on each transport, offered as choices so a model ID cannot be mistyped. Choosing
 * one also sets the profile's family, capability tier, limits and effort words. A model not listed can still be named
 * ("another model ID"), and the full configuration stays editable as JSON. The first entry of each list is the
 * recommended one: the model the benchmark runs used, and Gemini at high thinking (the runs used medium only to
 * shorten them). Through Antigravity, the models its CLI lists are ranked in (offeredCatalog).
 */
export interface CatalogModel {
  readonly modelId: string; readonly family: string; readonly tier: "frontier" | "balanced" | "fast"; readonly note: string;
  readonly limits?: { readonly contextTokens: number; readonly maxOutputTokens: number };
  /** The effort words the model's CLI accepts for it; each level is sent as its own word. None for a model whose
   * words are not known, or whose effort is part of its model ID (Gemini through the Antigravity CLI). */
  readonly efforts?: readonly string[];
}

/** What Claude Code 2.1.310 (`--effort`) and Codex 0.162.1 (`model_reasoning_effort`) accept for these models. Codex
 * also has `minimal` and `ultra`; arbitra uses neither (ultra delegates to sub-agents a tool-less call cannot use). */
const CLI_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const CLAUDE: readonly CatalogModel[] = [
  { modelId: "claude-opus-5-5", family: "claude", tier: "frontier", note: "strongest, slowest", limits: { contextTokens: 320_000, maxOutputTokens: 128_000 }, efforts: CLI_EFFORTS },
  { modelId: "claude-sonnet-5-5", family: "claude", tier: "balanced", note: "balanced", efforts: CLI_EFFORTS },
  { modelId: "claude-haiku-5-5", family: "claude", tier: "fast", note: "fast, light on usage", efforts: CLI_EFFORTS },
  { modelId: "claude-sonnet-5", family: "claude", tier: "balanced", note: "previous Sonnet" },
  { modelId: "claude-haiku-4-5-20251001", family: "claude", tier: "fast", note: "previous Haiku" },
];
const OPENAI: readonly CatalogModel[] = [
  { modelId: "gpt-6.1-sol", family: "gpt", tier: "frontier", note: "strongest", limits: { contextTokens: 312_000, maxOutputTokens: 64_000 }, efforts: CLI_EFFORTS },
  // Codex lists the same windows for both Sols (500,000 tokens, 872,000 at most), so 6.2 takes 6.1's measured limits.
  // It stays second: the npm Codex (0.162.1, November 21, 2026) does not serve it yet.
  { modelId: "gpt-6.2-sol", family: "gpt", tier: "frontier", note: "newest, needs Codex 0.171 or later", limits: { contextTokens: 312_000, maxOutputTokens: 64_000 }, efforts: CLI_EFFORTS },
  { modelId: "gpt-6-luna", family: "gpt", tier: "balanced", note: "faster, lighter on usage", efforts: CLI_EFFORTS },
  { modelId: "gpt-5.6-luna", family: "gpt", tier: "balanced", note: "previous Luna" },
];
const GEMINI_LIMITS = { contextTokens: 240_000, maxOutputTokens: 65_536 } as const;
const GEMINI_CLI: readonly CatalogModel[] = [
  { modelId: "gemini-3.8-flash-high", family: "gemini", tier: "frontier", note: "high thinking", limits: GEMINI_LIMITS },
  { modelId: "gemini-3.8-flash-medium", family: "gemini", tier: "frontier", note: "medium thinking, faster", limits: GEMINI_LIMITS },
  { modelId: "gemini-3.8-flash-low", family: "gemini", tier: "fast", note: "low thinking, fast but less reliable", limits: GEMINI_LIMITS },
];
const GEMINI_API: readonly CatalogModel[] = [
  { modelId: "gemini-3.8-flash", family: "gemini", tier: "frontier", note: "" },
  { modelId: "gemini-3.5-flash", family: "gemini", tier: "balanced", note: "" },
  { modelId: "gemini-3.1-flash-lite", family: "gemini", tier: "fast", note: "" },
];

/** Known models by transport; a transport without a list (an OpenAI-compatible endpoint) takes a typed model ID. */
export const MODEL_CATALOG: Readonly<Record<string, readonly CatalogModel[]>> = {
  "claude-code-cli": CLAUDE, "anthropic-messages": CLAUDE,
  "codex-cli": OPENAI, "openai-responses": OPENAI,
  "antigravity-cli": GEMINI_CLI, "gemini-native": GEMINI_API,
};

/** Models a CLI on this machine says the account can use, by transport (only Antigravity lists them). */
export type OfferedModels = Readonly<Record<string, readonly { readonly id: string; readonly name: string }[]>>;
const ORCHESTRATOR = /orchestrator/iu;
const THINKING = ["low", "medium", "high", "xhigh"] as const;
/** A model ID's thinking level by its last word (`-high`), higher first when sorted; an ID without one ranks lowest. */
const thinking = (modelId: string): number => THINKING.indexOf(modelId.slice(modelId.lastIndexOf("-") + 1) as typeof THINKING[number]);

/**
 * Gemini's families through Antigravity, strongest first, each with what it is. Google's Antigravity blog (November
 * 2026, https://antigravity.google/blog/gemini-4-neon-in-google-antigravity/): Gemini 4 Neon brings frontier-level
 * intelligence and "sits between Gemini 4 Carbon for your deepest long-horizon projects and Gemini 4 Hydrogen for rapid
 * everyday execution"; Gemini 4 Argon (September 30, 2026) is the earlier frontier model. Carbon is not offered to the
 * owner's account; it is ranked for when it is. A Gemini model of none of these families goes last.
 */
const GEMINI_FAMILIES: readonly { readonly pattern: RegExp; readonly tier: CatalogModel["tier"]; readonly note: string }[] = [
  { pattern: /carbon/iu, tier: "frontier", note: "deepest, for long-horizon work" },
  { pattern: /neon/iu, tier: "frontier", note: "frontier, Google's recommended" },
  { pattern: /argon/iu, tier: "frontier", note: "earlier frontier, its own weekly limit" },
  { pattern: /hydrogen/iu, tier: "balanced", note: "fast" },
  { pattern: /flash/iu, tier: "frontier", note: "fast" },
];
const familyOf = (modelId: string): number => { const index = GEMINI_FAMILIES.findIndex(({ pattern }) => pattern.test(modelId)); return index < 0 ? GEMINI_FAMILIES.length : index; };

/** A model Antigravity offers as a choice: the catalog's entry, or one made from its ID with its family's words. */
export function antigravityModel(modelId: string): CatalogModel {
  const known = GEMINI_CLI.find((model) => model.modelId === modelId);
  if (known !== undefined) return known;
  const family = GEMINI_FAMILIES[familyOf(modelId)];
  return { modelId, family: "gemini", tier: family?.tier ?? "frontier", note: family?.note ?? "offered by your CLI", limits: GEMINI_LIMITS };
}

/**
 * A transport's choices with the models its CLI offers added. For Antigravity only Gemini models are added: it also
 * serves other vendors' models, whose findings would not be independent of the Claude and GPT auditors. They are ranked
 * by family (Carbon, Neon, Argon, Hydrogen, Flash) and each at its highest thinking first, so the first, Neon where it
 * is offered, is the recommended choice.
 */
export function offeredCatalog(transport: string, offered: OfferedModels): readonly CatalogModel[] | undefined {
  const base = MODEL_CATALOG[transport];
  const listed = offered[transport];
  if (base === undefined || transport !== "antigravity-cli" || listed === undefined) return base;
  // An orchestrator ("Orchestrator (Argon)") hands work to other models, so its findings are not one model's; a model at
  // several thinking levels (`gemini-4-neon-low` to `-xhigh`) is offered at its highest first.
  const extra = listed.filter(({ id }) => /gemini|argon/iu.test(id) && !ORCHESTRATOR.test(id) && !base.some(({ modelId }) => modelId === id)).map(({ id }) => antigravityModel(id));
  return [...extra, ...base].sort((a, b) => familyOf(a.modelId) - familyOf(b.modelId) || thinking(b.modelId) - thinking(a.modelId));
}

/**
 * Antigravity's usage limits are per group of models, not per account. Observed live (November 21, 2026, agy 1.5.14):
 * Gemini 4 Argon High met a weekly limit of its own after 34 minutes of a finder ("Individual quota reached ... Resets in
 * 167h"), while the other Gemini models (Neon, Hydrogen, Flash), which share a five-hour and a weekly limit, had all of
 * theirs left. Carbon's group is not known; it is counted with the others.
 */
export const usageGroup = (modelId: string): "argon" | "gemini" => /argon/iu.test(modelId) ? "argon" : "gemini";

/**
 * The model a Gemini profile through Antigravity goes on with when its own usage limit is out: the first in the ranking
 * of the other group, among the models the CLI lists (Argon for Neon, Hydrogen or Flash; Neon for Argon). Undefined
 * for any other transport, or when the CLI lists none.
 */
export function otherLimitModel(transport: string, modelId: string, offered: OfferedModels): CatalogModel | undefined {
  const listed = offered[transport];
  if (transport !== "antigravity-cli" || listed === undefined || !/gemini|argon/iu.test(modelId)) return undefined;
  return offeredCatalog(transport, offered)?.find((model) => usageGroup(model.modelId) !== usageGroup(modelId) && listed.some(({ id }) => id === model.modelId));
}

/** A template's Gemini auditor moved from the default to the first model this machine's CLI offers (Neon, where offered). */
export function withStrongestOffered(config: Draft, offered: OfferedModels): Draft {
  const models = config["models"];
  const strongest = offeredCatalog("antigravity-cli", offered)?.[0];
  const fallback = MODEL_CATALOG["antigravity-cli"]?.[0];
  if (typeof models !== "object" || models === null || strongest === undefined || fallback === undefined || strongest.modelId === fallback.modelId) return config;
  let result = config;
  for (const [alias, profile] of Object.entries(models as Record<string, { modelId?: unknown; transport?: unknown }>)) {
    if (profile.transport !== "antigravity-cli" || profile.modelId !== fallback.modelId) continue;
    for (const [path, value] of modelSettings(strongest)) result = setIn(result, ["models", alias, ...path], value);
  }
  return result;
}

/**
 * What choosing a model writes into its profile. A model with known effort words supports each of them and sends each
 * as itself, so a stage at "high" reaches the CLI as `high`. A model without known limits or effort words resets them:
 * it keeps the levels the profile declares and sends no effort (preflight warns that the CLI's default applies).
 */
export function modelSettings(model: CatalogModel): readonly (readonly [readonly string[], unknown])[] {
  const effort: readonly [readonly string[], unknown] = model.efforts === undefined ? [["effort", "params"], {}]
    : [["effort"], { supported: [...model.efforts], collapse: {}, params: Object.fromEntries(model.efforts.map((word) => [word, { effort: word }])) }];
  return [[["modelId"], model.modelId], [["family"], model.family], [["capabilityTier"], model.tier],
    [["limits"], model.limits ?? { contextTokens: null, maxOutputTokens: null }], effort];
}

/** A configuration with the recommended model in every profile that still holds a placeholder model ID. */
export function withRecommendedModels(config: Draft, placeholder: (modelId: string) => boolean): Draft {
  const models = config["models"];
  if (typeof models !== "object" || models === null) return config;
  let result = config;
  for (const [alias, profile] of Object.entries(models as Record<string, { modelId?: unknown; transport?: unknown }>)) {
    const model = typeof profile.transport === "string" ? MODEL_CATALOG[profile.transport]?.[0] : undefined;
    if (model === undefined || typeof profile.modelId !== "string" || !placeholder(profile.modelId)) continue;
    for (const [path, value] of modelSettings(model)) result = setIn(result, ["models", alias, ...path], value);
  }
  return result;
}
