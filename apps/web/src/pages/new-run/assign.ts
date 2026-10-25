import auditCompatibleChat from "../../../../../examples/model-backed/audit-compatible-chat.json" with { type: "json" };
import { modelName, record } from "../run/models.js";
import { findersOf, withFinders, withoutUnusedProfiles } from "./depth.js";
import { getIn, setIn, type Draft } from "./draft.js";
import { MODEL_CATALOG, modelSettings, offeredCatalog, type CatalogModel, type OfferedModels } from "./model-catalog.js";
import { COMPATIBLE_TRANSPORT, profileFor, routeOf, transportFor, vendorOf, withEndpoint, withoutUnboundEndpoints } from "./routes.js";

/**
 * Who does each step, changed in place: a step's model from what the lineup can reach, and its effort in that model's
 * own words. A depth card is a preset; a change made here keeps the lineup and marks it changed, and choosing the card
 * again writes the preset afresh. Gemini does only optional work (the third finder, the variant search), never a core
 * step: the owner's rule of October 25, 2026. Any other model the person can reach, a vendor's API or an
 * OpenAI-compatible endpoint (Kimi through Moonshot, OpenRouter, a local server), may take any step; the core steps
 * still start on the measured lineup.
 */
export type Role = "merger" | "verifier" | "mediumVerifier" | "secondOpinion" | "variantSearcher" | "planner" | "critic" | "critiqueChecker";
export type Stage = "discovery" | "clustering" | "peerReview" | "verification" | "secondOpinion" | "critiqueCheck" | "variantSearch" | "planner" | "critic" | "revision";
/** A place a model sits: a finder, a role (with the role it falls back to when unset), or a stage whose models are the finders. */
export type Seat = { readonly kind: "finder"; readonly alias: string } | { readonly kind: "role"; readonly role: Role; readonly fallback?: Role } | { readonly kind: "stage"; readonly stage: Stage };

export const ROLE_STAGE: Readonly<Record<Role, Stage>> = Object.freeze({ merger: "clustering", verifier: "verification", mediumVerifier: "verification", secondOpinion: "secondOpinion",
  variantSearcher: "variantSearch", planner: "planner", critic: "critic", critiqueChecker: "critiqueCheck" });
/** The name of a profile a role gets when it takes a model no other step runs. */
const ROLE_ALIAS: Readonly<Record<Role, string>> = Object.freeze({ merger: "merger", verifier: "checker", mediumVerifier: "medium-checker", secondOpinion: "second-opinion",
  variantSearcher: "variant-searcher", planner: "planner", critic: "critic", critiqueChecker: "critique-checker" });

const ROLES = ["workflow", "modelExecution", "roles"] as const;
const EFFORTS = ["workflow", "modelExecution", "stageEffort"] as const;
const BINDINGS = ["workflow", "modelExecution", "modelEndpoints"] as const;
const LEVEL_IN_ID = /-(low|medium|high)$/u;
const models = (draft: Draft) => record(draft["models"]);
const profile = (draft: Draft, alias: string) => record(models(draft)[alias]);
const transportOf = (draft: Draft, alias: string) => String(profile(draft, alias)["transport"] ?? "");
const modelIdOf = (draft: Draft, alias: string) => String(profile(draft, alias)["modelId"] ?? "");
const bindingOf = (draft: Draft, alias: string) => record(getIn(draft, BINDINGS))[alias];
interface Endpoint { readonly id: string; readonly providerId: string; readonly transport: string; readonly endpoint?: string; readonly apiKeyEnvVar?: string }
const endpoints = (draft: Draft) => (getIn(draft, ["workflow", "modelExecution", "endpoints"]) ?? []) as readonly Endpoint[];
/** Gemini through Antigravity names its thinking level in the model ID; the model is the ID without it. */
const geminiLevels = (transport: string, modelId: string) => transport === "antigravity-cli" && LEVEL_IN_ID.test(modelId);
export const baseModel = (transport: string, modelId: string): string => geminiLevels(transport, modelId) ? modelId.replace(LEVEL_IN_ID, "") : modelId;

/** The profile a seat names now. */
export function aliasOf(draft: Draft, seat: Seat): string | undefined {
  if (seat.kind === "finder") return models(draft)[seat.alias] === undefined ? undefined : seat.alias;
  if (seat.kind === "stage") return undefined;
  const roles = record(getIn(draft, ROLES));
  const named = roles[seat.role] ?? (seat.fallback === undefined ? undefined : roles[seat.fallback]);
  return typeof named === "string" ? named : undefined;
}

const optional = (seat: Seat) => (seat.kind === "finder" && seat.alias === "auditor-c") || (seat.kind === "role" && seat.role === "variantSearcher");

/** Models a seat can take through one CLI, one API, or one OpenAI-compatible endpoint; `key` names which. */
export interface OptionGroup { readonly key: string; readonly label: string; readonly transport: string; readonly models: readonly CatalogModel[] }

/**
 * The models a seat can take, grouped by what reaches them: the lineup's CLIs or APIs, with their known models; each
 * OpenAI-compatible endpoint the lineup has, with the models named on it; and for optional work Gemini through the
 * lineup's route as well, first, with what Antigravity offers (Argon, its strongest, when it offers it). The first
 * finder stays a Claude model and the second a GPT one, so the finders stay independent and the depths apply.
 */
export function seatOptions(draft: Draft, seat: Seat, offered: OfferedModels): readonly OptionGroup[] {
  const transports = endpoints(draft).map(({ transport }) => transport).filter((transport) => transport !== COMPATIBLE_TRANSPORT);
  const gemini = transportFor("google", routeOf(draft) ?? "cli");
  const reachable = [...new Set(optional(seat) && gemini !== undefined ? [gemini, ...transports] : transports)];
  const allowed = (transport: string): boolean => {
    const vendor = vendorOf(transport);
    if (seat.kind === "finder" && seat.alias === "auditor-a") return vendor?.provider === "anthropic";
    if (seat.kind === "finder" && seat.alias === "auditor-b") return vendor?.provider === "openai";
    return optional(seat) || vendor?.family !== "gemini";
  };
  const vendorGroups = reachable.filter(allowed).map((transport): OptionGroup => {
    const seen = new Set<string>();
    // One entry per model: Gemini's thinking levels are its efforts, not models of their own.
    const listed = (offeredCatalog(transport, offered) ?? []).filter(({ modelId }) => { const base = baseModel(transport, modelId); if (seen.has(base)) return false; seen.add(base); return true; });
    return { key: `t:${transport}`, label: `through ${RUNS_THROUGH[transport] ?? transport}`, transport, models: listed };
  });
  const finderSlot = seat.kind === "finder" && (seat.alias === "auditor-a" || seat.alias === "auditor-b");
  const compatible = finderSlot ? [] : endpoints(draft).filter(({ transport }) => transport === COMPATIBLE_TRANSPORT).map((endpoint): OptionGroup => {
    const named = [...new Set(Object.keys(models(draft)).filter((alias) => bindingOf(draft, alias) === endpoint.id).map((alias) => modelIdOf(draft, alias)))];
    return { key: `e:${endpoint.id}`, label: `through ${hostOf(endpoint.endpoint)}`, transport: COMPATIBLE_TRANSPORT, models: named.map((modelId) => ({ modelId, family: "", tier: "balanced", note: "" })) };
  });
  return [...vendorGroups, ...compatible].filter(({ models: listed }) => listed.length > 0);
}

const RUNS_THROUGH: Readonly<Record<string, string>> = Object.freeze({ "claude-code-cli": "Claude Code", "codex-cli": "Codex", "antigravity-cli": "Antigravity", "gemini-cli": "Gemini CLI",
  "anthropic-messages": "Anthropic's API", "openai-responses": "OpenAI's API", "gemini-native": "Gemini's API" });
const hostOf = (url: string | undefined): string => { try { return new URL(url ?? "").host; } catch { return url ?? "an OpenAI-compatible endpoint"; } };

/** An option's value: which group, and which model in it. */
export const optionValue = (group: Pick<OptionGroup, "key" | "transport">, modelId: string): string => `${group.key}|${baseModel(group.transport, modelId)}`;
/** The option value of the model a seat holds now. */
export function seatValue(draft: Draft, alias: string): string {
  const transport = transportOf(draft, alias);
  return transport === COMPATIBLE_TRANSPORT ? `e:${String(bindingOf(draft, alias) ?? "")}|${modelIdOf(draft, alias)}` : optionValue({ key: `t:${transport}`, transport }, modelIdOf(draft, alias));
}

/**
 * A model's name in a list, with what the catalog says of it. Gemini through Antigravity is listed without its
 * thinking level, which is its effort. A model arbitra has no list entry for (one a CLI offers, or one named on an
 * endpoint) says it is not measured.
 */
export function optionName(transport: string, model: CatalogModel): string {
  const name = modelName(baseModel(transport, model.modelId));
  const known = (MODEL_CATALOG[transport] ?? []).some(({ modelId }) => modelId === model.modelId);
  const notes = [geminiLevels(transport, model.modelId) ? "" : model.note, known ? "" : "not measured"].filter((note) => note !== "");
  return notes.length === 0 ? name : `${name} (${notes.join(", ")})`;
}

/** The efforts a seat's model takes, in its own words; Gemini through Antigravity takes them as model IDs. */
export function effortChoices(draft: Draft, alias: string, offered: OfferedModels): readonly string[] {
  const transport = transportOf(draft, alias);
  const modelId = modelIdOf(draft, alias);
  if (geminiLevels(transport, modelId)) {
    const base = baseModel(transport, modelId);
    return (offeredCatalog(transport, offered) ?? []).map((model) => model.modelId).filter((id) => id.replace(LEVEL_IN_ID, "") === base && LEVEL_IN_ID.test(id)).map((id) => LEVEL_IN_ID.exec(id)?.[1] ?? "");
  }
  const supported = record(profile(draft, alias)["effort"])["supported"];
  return Array.isArray(supported) ? supported.map(String) : [];
}

/** The level a stage asks of a profile: the stage's own, one level or one per profile, else undefined. */
export function effortLevel(draft: Draft, stage: Stage, alias: string): string | undefined {
  const value = getIn(draft, [...EFFORTS, stage]);
  const level = typeof value === "string" ? value : record(value)[alias];
  if (typeof level === "string") return level;
  return stage === "secondOpinion" || stage === "critiqueCheck" ? effortLevel(draft, "verification", alias) : undefined;
}

/**
 * The draft with one profile's effort at a stage. A stage set as one level for every profile becomes one per profile
 * with the others kept, and one again when they all agree. The plan's revision follows the plan.
 */
export function withStageEffort(draft: Draft, stage: Stage, alias: string, level: string): Draft {
  const aliases = Object.keys(models(draft));
  const current = getIn(draft, [...EFFORTS, stage]);
  const levels: Record<string, unknown> = typeof current === "string" ? Object.fromEntries(aliases.map((name) => [name, current])) : { ...record(current) };
  levels[alias] = level;
  const values = new Set(Object.values(levels));
  const next = setIn(draft, [...EFFORTS, stage], values.size === 1 && aliases.every((name) => Object.hasOwn(levels, name)) ? level : levels);
  return stage === "planner" ? withStageEffort(next, "revision", alias, level) : next;
}

/** A seat's effort changed: an effort word, or for Gemini through Antigravity the same model at another thinking level. */
export function withSeatEffort(draft: Draft, seat: Seat, level: string, offered: OfferedModels): Draft {
  // A stage the finders share (the review round) runs at one level for all of them.
  if (seat.kind === "stage") return setIn(draft, [...EFFORTS, seat.stage], level);
  const alias = aliasOf(draft, seat);
  if (alias === undefined) return draft;
  const transport = transportOf(draft, alias);
  const modelId = modelIdOf(draft, alias);
  if (geminiLevels(transport, modelId)) return withSeatModel(draft, seat, transport, `${baseModel(transport, modelId)}-${level}`, offered);
  return withStageEffort(draft, seat.kind === "finder" ? "discovery" : ROLE_STAGE[seat.role], alias, level);
}

/** A model the seat can take, by transport and ID; for Gemini through Antigravity, at the thinking level it had. */
function catalogModel(draft: Draft, seat: Seat, transport: string, modelId: string, offered: OfferedModels): CatalogModel | undefined {
  const catalog = offeredCatalog(transport, offered) ?? [];
  const alias = aliasOf(draft, seat);
  const level = alias === undefined ? undefined : LEVEL_IN_ID.exec(modelIdOf(draft, alias))?.[1];
  return catalog.find((model) => model.modelId === modelId) ?? catalog.find((model) => model.modelId === `${modelId}-${level ?? "high"}`) ?? catalog.find((model) => baseModel(transport, model.modelId) === modelId);
}

/** The draft with a seat on the model an option names: `t:<transport>|<model>` or `e:<endpoint>|<model>`. */
export function withSeatOption(draft: Draft, seat: Seat, value: string, offered: OfferedModels): Draft {
  const [key = "", modelId = ""] = value.split("|");
  if (key.startsWith("t:")) return withSeatModel(draft, seat, key.slice(2), modelId, offered);
  const endpoint = key.slice(2);
  const source = Object.keys(models(draft)).find((alias) => bindingOf(draft, alias) === endpoint && modelIdOf(draft, alias) === modelId);
  return source === undefined ? draft : withSeatProfile(draft, seat, profile(draft, source), endpoint, offered);
}

/** The draft with a seat on a model through a CLI or an API it knows, from a profile like one the lineup has on it. */
export function withSeatModel(draft: Draft, seat: Seat, transport: string, modelId: string, offered: OfferedModels): Draft {
  if (seat.kind === "stage") return draft;
  const model = catalogModel(draft, seat, transport, modelId, offered);
  if (model === undefined) return draft;
  const like = Object.keys(models(draft)).find((alias) => transportOf(draft, alias) === transport);
  if (like !== undefined) {
    let copy: Draft = profile(draft, like);
    for (const [path, value] of modelSettings(model)) copy = setIn(copy, path, value);
    return withSeatProfile(draft, seat, copy, String(bindingOf(draft, like) ?? ""), offered);
  }
  const added = withEndpoint(draft, transport);
  if (added === undefined) return draft;
  return withSeatProfile(added.draft, seat, profileFor(transport, model, {}), added.endpoint, offered);
}

/**
 * The draft with a seat on a given profile, bound to an endpoint. A role moves to a profile that already runs that
 * model there, else to one of its own; a finder's profile takes the model, and the roles it also held keep theirs on
 * a profile of their own. The effort a seat had stays where the new model has the same word. Profiles nothing uses go.
 */
function withSeatProfile(draft: Draft, seat: Seat, placed: Draft, endpoint: string, offered: OfferedModels): Draft {
  if (seat.kind === "stage") return draft;
  const stage: Stage = seat.kind === "finder" ? "discovery" : ROLE_STAGE[seat.role];
  const before = aliasOf(draft, seat);
  const level = before === undefined ? undefined : effortLevel(draft, stage, before);
  let next = draft;
  let alias: string;
  if (seat.kind === "finder") {
    alias = seat.alias;
    // The roles this finder also held keep its model, on a profile of their own.
    for (const [role, named] of Object.entries(record(getIn(next, ROLES)))) {
      if (named !== alias) continue;
      const kept = placeFor(next, role as Role, profile(next, alias), String(bindingOf(next, alias) ?? ""), alias);
      next = setIn(kept.draft, [...ROLES, role], kept.alias);
    }
    next = setIn(setIn(next, ["models", alias], placed), [...BINDINGS, alias], endpoint);
  } else {
    const kept = placeFor(next, seat.role, placed, endpoint);
    alias = kept.alias;
    next = setIn(kept.draft, [...ROLES, seat.role], alias);
  }
  const modelId = String(placed["modelId"] ?? "");
  if (level !== undefined && effortChoices(next, alias, offered).includes(level) && !geminiLevels(String(placed["transport"] ?? ""), modelId)) next = withStageEffort(next, stage, alias, level);
  return withoutUnboundEndpoints(withoutUnusedProfiles(next));
}

/** A profile for a role: one that already runs the same model through the same endpoint (other than `avoid`), else a new one. */
function placeFor(draft: Draft, role: Role, placed: Draft, endpoint: string, avoid?: string): { readonly draft: Draft; readonly alias: string } {
  const existing = Object.keys(models(draft)).find((alias) => alias !== avoid && transportOf(draft, alias) === placed["transport"] && modelIdOf(draft, alias) === placed["modelId"] && bindingOf(draft, alias) === endpoint);
  if (existing !== undefined) return { draft, alias: existing };
  let alias = ROLE_ALIAS[role];
  for (let index = 2; models(draft)[alias] !== undefined; index += 1) alias = `${ROLE_ALIAS[role]}-${index}`;
  return { draft: setIn(setIn(draft, ["models", alias], placed), [...BINDINGS, alias], endpoint), alias };
}

/** OpenAI-compatible endpoints people use, as a convenience: the base URL and key variable filled in, the model typed. */
export const COMPATIBLE_PRESETS: readonly { readonly id: string; readonly name: string; readonly baseUrl: string; readonly keyVar: string; readonly example: string }[] = Object.freeze([
  { id: "moonshot", name: "Moonshot (Kimi)", baseUrl: "https://api.moonshot.ai/v1", keyVar: "ARBITRA_MOONSHOT_API_KEY", example: "kimi-3.1, as Moonshot lists it" },
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", keyVar: "ARBITRA_OPENROUTER_API_KEY", example: "vendor/model, as OpenRouter lists it" },
  { id: "local", name: "a server on this computer", baseUrl: "http://127.0.0.1:8000/v1", keyVar: "ARBITRA_LOCAL_API_KEY", example: "the model the server serves" },
  { id: "compatible", name: "another OpenAI-compatible endpoint", baseUrl: "", keyVar: "ARBITRA_COMPATIBLE_API_KEY", example: "the model as the endpoint lists it" },
]);
export interface CustomModel { readonly preset: string; readonly baseUrl: string; readonly modelId: string; readonly keyVar: string }

/** Why a model the person names cannot be used yet, in words, or null when it can. */
export function customProblem(custom: CustomModel): string | null {
  let url: URL | null = null;
  try { url = new URL(custom.baseUrl); } catch { url = null; }
  if (url === null || !["http:", "https:"].includes(url.protocol) || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return "The base URL must be an http or https address, with no key, query or fragment in it.";
  if (custom.modelId.trim() === "") return "Name the model as the endpoint lists it.";
  if (!/^[A-Z_][A-Z0-9_]*$/u.test(custom.keyVar)) return "The key variable is an environment variable name, in capitals, such as ARBITRA_MOONSHOT_API_KEY.";
  return null;
}

const COMPATIBLE_PROFILE = record(record((auditCompatibleChat as unknown as Draft)["models"])["auditor-a"]);
const COMPATIBLE_RATE = getIn(auditCompatibleChat as unknown as Draft, ["workflow", "modelExecution", "rateLimits", "compatible"]);

/**
 * The draft with a seat on a model the person names: an OpenAI-compatible endpoint by its base URL and the environment
 * variable holding its key, and the model's ID there. The endpoint is reused when the lineup has it already; the model
 * is its own independence group, named after the endpoint, so a third finder from another vendor counts as one.
 */
export function withCustomModel(draft: Draft, seat: Seat, custom: CustomModel, offered: OfferedModels): Draft {
  if (customProblem(custom) !== null) return draft;
  const baseUrl = custom.baseUrl.replace(/\/+$/u, "");
  const present = endpoints(draft).find((entry) => entry.transport === COMPATIBLE_TRANSPORT && entry.endpoint?.replace(/\/+$/u, "") === baseUrl);
  let next = draft;
  let endpoint = present;
  if (endpoint === undefined) {
    const taken = new Set(endpoints(draft).map(({ id }) => id));
    let id = custom.preset;
    for (let index = 2; taken.has(id); index += 1) id = `${custom.preset}-${index}`;
    endpoint = { id, providerId: id, transport: COMPATIBLE_TRANSPORT, endpoint: baseUrl, apiKeyEnvVar: custom.keyVar };
    next = setIn(next, ["workflow", "modelExecution", "endpoints"], [...endpoints(draft), endpoint]);
    next = setIn(next, ["workflow", "modelExecution", "rateLimits", id], COMPATIBLE_RATE);
  }
  const modelId = custom.modelId.trim();
  const family = /^[a-z0-9]+/iu.exec(modelId.split("/").at(-1) ?? modelId)?.[0]?.toLowerCase() ?? endpoint.providerId;
  const placed: Draft = { ...COMPATIBLE_PROFILE, provider: endpoint.providerId, modelId, family, independenceGroup: endpoint.providerId };
  return withSeatProfile(next, seat, placed, endpoint.id, offered);
}

/**
 * The draft with a third finder on a model, or without one. It is Gemini 3.8 Flash at high by default (withFinders);
 * any other model the lineup reaches, or one the person names, may take its place.
 */
export function withThirdFinder(draft: Draft, choice: { readonly transport: string; readonly modelId: string } | "default" | null, offered: OfferedModels): Draft {
  if (choice === null) return withFinders(draft, 2);
  const three = findersOf(draft) === 3 && models(draft)["auditor-c"] !== undefined ? draft : withFinders(draft, 3);
  if (choice === "default") return three;
  if (transportOf(three, "auditor-c") === choice.transport && baseModel(choice.transport, modelIdOf(three, "auditor-c")) === baseModel(choice.transport, choice.modelId)) return three;
  return withSeatModel(three, { kind: "finder", alias: "auditor-c" }, choice.transport, choice.modelId, offered);
}
