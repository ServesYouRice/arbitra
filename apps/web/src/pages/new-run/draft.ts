import { record } from "../run/models.js";

/**
 * The configuration being prepared, as the JSON the control plane stores. Every edit is a
 * pure function over it, so the form, the JSON view and the saved configuration are always
 * the same object; the server's validator and preflight decide whether it is valid.
 */
export type Draft = Readonly<Record<string, unknown>>;
export type Mode = "audit" | "feature" | "testing";

export function getIn(draft: Draft, path: readonly string[]): unknown {
  let value: unknown = draft;
  for (const key of path) value = record(value)[key];
  return value;
}

/** Set a nested value, creating objects on the way; `undefined` removes the key. */
export function setIn(draft: Draft, path: readonly string[], value: unknown): Draft {
  const [head, ...rest] = path;
  if (head === undefined) return draft;
  const next: Record<string, unknown> = { ...draft };
  const child = rest.length === 0 ? value : setIn(record(draft[head]), rest, value);
  if (child === undefined) delete next[head]; else next[head] = child;
  return next;
}

export function modeOf(draft: Draft): Mode {
  const mode = draft["mode"];
  return mode === "feature" || mode === "testing" ? mode : "audit";
}

export function presetOf(draft: Draft): string | null {
  const preset = getIn(draft, ["workflow", "preset"]);
  return typeof preset === "string" ? preset : null;
}

export function graphOf(draft: Draft): { readonly id: string; readonly version: string } | null {
  const graph = record(getIn(draft, ["workflow", "graph"]));
  return typeof graph["id"] === "string" && typeof graph["version"] === "string" ? { id: graph["id"], version: graph["version"] } : null;
}

/** A preset and a saved graph are exclusive; choosing one removes the other. */
export function withPreset(draft: Draft, preset: string): Draft { return setIn(setIn(draft, ["workflow", "graph"], undefined), ["workflow", "preset"], preset); }
export function withGraph(draft: Draft, graph: { readonly id: string; readonly version: string }): Draft { return setIn(setIn(draft, ["workflow", "preset"], undefined), ["workflow", "graph"], { id: graph.id, version: graph.version }); }

/** A new scope keeps only what applies to its kind, plus the exclusions every kind honours. */
export function withScopeKind(draft: Draft, kind: string): Draft {
  const exclude = getIn(draft, ["scope", "exclude"]);
  return setIn(draft, ["scope"], { kind, ...(kind === "diff" ? { diffMode: "range", head: "HEAD" } : {}), ...(Array.isArray(exclude) && exclude.length > 0 ? { exclude } : {}) });
}

/** One path per line; blank lines are dropped and an empty list removes the key. */
export function lines(value: string): readonly string[] | undefined {
  const list = value.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  return list.length === 0 ? undefined : list;
}

export interface RoleSlot { readonly label: string; readonly path: readonly string[]; readonly multiple: boolean; readonly optional: boolean; readonly hint: string }

/** The model roles this configuration binds, where it binds them, and what each does. */
export function roleSlots(draft: Draft): readonly RoleSlot[] {
  const mode = modeOf(draft);
  if (mode === "feature") {
    const base = ["workflow", "feature", "roles"];
    return [
      { label: "requirements", path: [...base, "requirements"], multiple: false, optional: false, hint: "drafts the requirements contract" },
      { label: "exploration", path: [...base, "exploration"], multiple: false, optional: false, hint: "reads the repository to ground the plan" },
      { label: "planner", path: [...base, "planner"], multiple: false, optional: false, hint: "writes the implementation plan" },
      { label: "reviewers", path: [...base, "reviewers"], multiple: true, optional: true, hint: "review the requirements independently; use distinct independence groups" },
      { label: "critic", path: [...base, "critic"], multiple: false, optional: true, hint: "reviews the plan; must be independent of the planner" },
    ];
  }
  if (mode === "testing") {
    const slots: RoleSlot[] = [
      { label: "analyst", path: ["workflow", "testing", "roles", "analyst"], multiple: false, optional: false, hint: "finds risks and test gaps; must be a frontier profile" },
      { label: "planner", path: ["workflow", "testing", "roles", "planner"], multiple: false, optional: false, hint: "writes the test plan" },
    ];
    if (getIn(draft, ["workflow", "testing", "mode"]) === "execute") for (const tier of ["fast", "balanced", "frontier"]) slots.push({ label: `${tier} writer`, path: ["workflow", "testing", "execution", "models", tier], multiple: false, optional: false, hint: `writes tests routed at ${tier} capability` });
    return slots;
  }
  if (Object.keys(record(draft["models"])).length === 0) return [];
  const base = ["workflow", "modelExecution", "roles"];
  return [
    { label: "planner", path: [...base, "planner"], multiple: false, optional: false, hint: "turns accepted issues into the plan" },
    { label: "verifier", path: [...base, "verifier"], multiple: false, optional: false, hint: "answers the single model question verification may ask" },
    { label: "critic", path: [...base, "critic"], multiple: false, optional: true, hint: "reviews the plan; audit-deep requires one" },
  ];
}

export interface Limit { readonly label: string; readonly path: readonly string[]; readonly hint: string }
/** The limits the runtime enforces on model spend (see the BUDGETS_NOT_ENFORCED preflight message). */
export const LIMITS: readonly Limit[] = Object.freeze([
  { label: "run token budget", path: ["workflow", "modelExecution", "maximumTokens"], hint: "tokens the whole run may spend on model calls; the run pauses when it is spent" },
  { label: "output tokens per call", path: ["workflow", "modelExecution", "maximumOutputTokens"], hint: "the output each call reserves; the budget must be at least this" },
  { label: "timeout per call (ms)", path: ["workflow", "modelExecution", "timeoutMs"], hint: "a call that takes longer fails and may be retried" },
  { label: "retries per call", path: ["workflow", "modelExecution", "maximumRetries"], hint: "0 to 10" },
]);

/** A name that says where the configuration came from; the operator can change it before saving. */
export function suggestedName(source: string, draft: Draft): string {
  const target = presetOf(draft) ?? graphOf(draft)?.id ?? modeOf(draft);
  return `${source} · ${target}`;
}

/**
 * Every value a template left for the operator to fill in (`replace-with-your-model-id`,
 * `Replace with the behavior…`), by dotted path. Preflight refuses placeholder model
 * identities; listing them all first saves a round of guessing which ones remain.
 */
export function placeholders(value: unknown, path = ""): readonly string[] {
  if (typeof value === "string") return /^replace[- ]with/iu.test(value) || value.includes("replace-with-your") ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((child, index) => placeholders(child, `${path}[${index}]`));
  if (typeof value === "object" && value !== null) return Object.entries(value).flatMap(([key, child]) => placeholders(child, path === "" ? key : `${path}.${key}`));
  return [];
}
