/**
 * The model profiles a configuration binds and the roles each one plays, read from the
 * configuration alone. `node` names the workflow node a role runs in, so a node's details
 * can show the models bound to it.
 */
export interface RoleBinding { readonly label: string; readonly node: string }
export interface ModelProfileSummary {
  readonly alias: string;
  readonly provider: string;
  readonly modelId: string;
  readonly family: string;
  readonly transport: string;
  readonly capabilityTier: string;
  readonly independenceGroup: string;
  readonly roles: readonly RoleBinding[];
  /** The templates ship placeholder identities that preflight refuses (`MODEL_IDENTITY_PLACEHOLDER`). */
  readonly placeholder: boolean;
}

export const PLACEHOLDER_PREFIX = "replace-with-";

export function modelProfiles(config: Readonly<Record<string, unknown>>): readonly ModelProfileSummary[] {
  const models = record(config["models"]);
  const workflow = record(config["workflow"]);
  const roles = new Map<string, RoleBinding[]>();
  const bind = (alias: unknown, binding: RoleBinding): void => { if (typeof alias === "string") roles.set(alias, [...(roles.get(alias) ?? []), binding]); };
  if (config["mode"] === "audit") {
    for (const alias of Object.keys(models)) if (alias.startsWith("auditor-")) bind(alias, { label: `auditor ${alias.slice("auditor-".length)}`, node: alias });
    const audit = record(record(workflow["modelExecution"])["roles"]);
    bind(audit["planner"], { label: "planner", node: "planner" });
    bind(audit["verifier"], { label: "verifier", node: "verification" });
    bind(audit["critic"], { label: "critic", node: "critic" });
  }
  if (config["mode"] === "feature") {
    const feature = record(record(workflow["feature"])["roles"]);
    for (const role of ["requirements", "exploration", "planner", "critic"]) bind(feature[role], { label: role, node: "feature" });
    for (const reviewer of Array.isArray(feature["reviewers"]) ? feature["reviewers"] : []) bind(reviewer, { label: "reviewer", node: "feature" });
  }
  if (config["mode"] === "testing") {
    const testing = record(workflow["testing"]);
    const testingRoles = record(testing["roles"]);
    bind(testingRoles["analyst"], { label: "analyst", node: "testing" });
    bind(testingRoles["planner"], { label: "planner", node: "testing" });
    const writers = record(record(testing["execution"])["models"]);
    for (const tier of ["fast", "balanced", "frontier"]) bind(writers[tier], { label: `${tier} writer`, node: "execute" });
  }
  return Object.freeze(Object.entries(models).map(([alias, value]) => {
    const profile = record(value);
    const text = (key: string): string => typeof profile[key] === "string" ? profile[key] as string : "unavailable";
    return Object.freeze({ alias, provider: text("provider"), modelId: text("modelId"), family: text("family"), transport: text("transport"), capabilityTier: text("capabilityTier"),
      independenceGroup: text("independenceGroup"), roles: Object.freeze(roles.get(alias) ?? []), placeholder: text("modelId").startsWith(PLACEHOLDER_PREFIX) || text("family").startsWith(PLACEHOLDER_PREFIX) });
  }));
}

/** A model ID as people say it: `claude-opus-5-5` → `Opus 5.5`, `gpt-6.1-sol` → `GPT-6.1 Sol`. Unknown IDs stay as they are. */
export function modelName(modelId: string): string {
  const claude = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/u.exec(modelId);
  if (claude !== null) return `${capitalise(claude[1] ?? "")} ${claude[2]}${claude[3] === undefined || claude[3].length > 2 ? "" : `.${claude[3]}`}`;
  const gpt = /^gpt-([\d.]+)(?:-([a-z]+))?$/u.exec(modelId);
  if (gpt !== null) return `GPT-${gpt[1]}${gpt[2] === undefined ? "" : ` ${capitalise(gpt[2])}`}`;
  const gemini = /^gemini-([\d.]+)-([a-z]+)(?:-([a-z]+))?$/u.exec(modelId);
  if (gemini !== null) return `Gemini ${gemini[1]} ${capitalise(gemini[2] ?? "")}${gemini[3] === undefined ? "" : ` ${gemini[3]}`}`;
  return modelId;
}
function capitalise(word: string): string { return word.charAt(0).toUpperCase() + word.slice(1); }

type EffortStage = "discovery" | "peerReview" | "verification" | "planner" | "critic";
/**
 * The effort a stage asks of a profile, in the vendor's own word: the stage's `stageEffort`, else the audit depth's
 * (fast: low, balanced: medium, deep: high), translated by the profile's `effort.params` (deep runs Opus at "xhigh").
 * Discovery always follows the depth. A model whose ID carries its effort (`gemini-3.8-flash-medium`) shows the level.
 */
export function effortFor(config: Readonly<Record<string, unknown>>, alias: string, stage: EffortStage): string {
  const depth = config["auditDepth"];
  const byDepth = depth === "fast" ? "low" : depth === "deep" ? "high" : "medium";
  const configured = stage === "discovery" ? undefined : record(record(record(config["workflow"])["modelExecution"])["stageEffort"])[stage];
  const level = typeof configured === "string" ? configured : byDepth;
  const params = record(record(record(record(config["models"])[alias])["effort"])["params"])[level];
  const vendor = record(params)["effort"] ?? record(params)["reasoning_effort"];
  if (typeof vendor === "string") return vendor;
  const slug = /-(low|medium|high|max)$/u.exec(String(record(record(config["models"])[alias])["modelId"] ?? ""))?.[1];
  return slug ?? level;
}

/** The effort a role runs at (an auditor at the audit's depth, a later stage at its own), or null for another role. */
export function roleEffort(config: Readonly<Record<string, unknown>>, alias: string, node: string): string | null {
  const stage = node.startsWith("auditor-") ? "discovery" : node;
  return stage === "discovery" || stage === "verification" || stage === "planner" || stage === "critic" ? effortFor(config, alias, stage) : null;
}

/** Each model node's label as the model that ran it and its effort, such as `Opus 5.5 · xhigh`, for graphs. */
export function modelNodeLabels(config: Readonly<Record<string, unknown>> | null): ReadonlyMap<string, string> {
  if (config === null || config["mode"] !== "audit") return new Map();
  const profiles = modelProfiles(config);
  const name = (alias: unknown) => typeof alias === "string" ? profiles.find((profile) => profile.alias === alias) : undefined;
  const roles = record(record(record(config["workflow"])["modelExecution"])["roles"]);
  const labels = new Map<string, string>();
  for (const profile of profiles) if (profile.alias.startsWith("auditor-")) labels.set(profile.alias, `${modelName(profile.modelId)} · ${effortFor(config, profile.alias, "discovery")}`);
  for (const [node, role, stage] of [["planner", "planner", "planner"], ["verification", "verifier", "verification"], ["critic", "critic", "critic"]] as const) {
    const profile = name(roles[role]);
    if (profile !== undefined) labels.set(node, `${modelName(profile.modelId)} · ${effortFor(config, profile.alias, stage)}`);
  }
  return labels;
}

export function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
