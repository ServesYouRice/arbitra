import { setIn, type Draft } from "./draft.js";

/**
 * The models arbitra knows to work on each transport, offered as choices so a model ID cannot be mistyped. Choosing
 * one also sets the profile's family, capability tier, limits and effort words. A model not listed can still be named
 * ("another model ID"), and the full configuration stays editable as JSON. The first entry of each list is the
 * recommended one: the model the benchmark runs used, and Gemini at high thinking (the runs used medium only to
 * shorten them).
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
const ARGON = /argon/iu;

/**
 * A transport's choices with the models its CLI offers added. For Antigravity only Gemini models are added: it also
 * serves other vendors' models, whose findings would not be independent of the Claude and GPT auditors. An Argon
 * model, Gemini's strongest, goes first, as the recommended choice.
 */
export function offeredCatalog(transport: string, offered: OfferedModels): readonly CatalogModel[] | undefined {
  const base = MODEL_CATALOG[transport];
  const listed = offered[transport];
  if (base === undefined || transport !== "antigravity-cli" || listed === undefined) return base;
  const extra = listed.filter(({ id }) => /gemini|argon/iu.test(id) && !base.some(({ modelId }) => modelId === id))
    .map(({ id, name }): CatalogModel => ({ modelId: id, family: "gemini", tier: "frontier", note: ARGON.test(`${id} ${name}`) ? "strongest, offered by your CLI" : "offered by your CLI", limits: GEMINI_LIMITS }));
  return [...extra.filter(({ note }) => note.startsWith("strongest")), ...base, ...extra.filter(({ note }) => !note.startsWith("strongest"))];
}

/** A template's Gemini auditor moved from the default to Argon when this machine's CLI offers it. */
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
