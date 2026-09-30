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

export function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
