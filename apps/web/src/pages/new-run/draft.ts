import { record } from "../run/models.js";

/**
 * The configuration being prepared, as the JSON the control plane stores. Every edit is a
 * pure function over it, so the form, the JSON view and the saved configuration are always
 * the same object; the server's validator and preflight decide whether it is valid.
 */
export type Draft = Readonly<Record<string, unknown>>;
export type Mode = "audit" | "feature" | "testing";
/** One edit of the draft at a path; `undefined` removes the key. */
export type Edit = (path: readonly string[], value: unknown) => void;

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
    { label: "writes the plan", path: [...base, "planner"], multiple: false, optional: false, hint: "Turns the confirmed issues into the plan." },
    { label: "checks each issue", path: [...base, "verifier"], multiple: false, optional: false, hint: "Critical and high issues always go to it, so make it the strongest." },
    { label: "checks medium issues", path: [...base, "mediumVerifier"], multiple: false, optional: true, hint: "In place of the one above, with a lighter model." },
    { label: "reviews the plan", path: [...base, "critic"], multiple: false, optional: true, hint: "When the plan review is switched on." },
  ];
}

export interface Limit { readonly label: string; readonly path: readonly string[]; readonly hint: string }
/** The limits the runtime enforces on model spend (see the BUDGETS_NOT_ENFORCED preflight message). */
export const LIMITS: readonly Limit[] = Object.freeze([
  { label: "stop at (tokens)", path: ["workflow", "modelExecution", "maximumTokens"], hint: "The run pauses when its model calls have used this many tokens; you can raise it and resume." },
  { label: "output a call may write (tokens)", path: ["workflow", "modelExecution", "maximumOutputTokens"], hint: "What each call reserves for its answer; the stop must be at least this." },
  { label: "longest call (ms)", path: ["workflow", "modelExecution", "timeoutMs"], hint: "A call that takes longer is stopped and may be tried again." },
  { label: "tries again per call", path: ["workflow", "modelExecution", "maximumRetries"], hint: "0 to 10." },
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
