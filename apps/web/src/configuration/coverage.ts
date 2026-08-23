import { HTTP_ROUTE_SCHEMAS } from "@arbitra/schemas/http-control-plane";
export const DEDICATED_CONTROLS = Object.freeze(["mode", "scope", "auditDepth", "consensusPolicy", "maxConsensusRounds", "models", "harness"] as const);
export const JSON_FALLBACK_FIELDS = Object.freeze(["verification", "workflow", "budgets", "security", "protocols", "promptOverrides", "contextPolicies"] as const);
export function canonicalConfigurationFields(): readonly string[] { const route = HTTP_ROUTE_SCHEMAS["POST /configurations"]; const config = route.body.properties.config as { properties?: Record<string, unknown> }; return Object.freeze(Object.keys(config.properties ?? {}).filter((key) => key !== "schemaVersion").sort()); }
export function configurationCoverage(): { readonly covered: readonly string[]; readonly missing: readonly string[] } { const fields = canonicalConfigurationFields(); const registered = new Set<string>([...DEDICATED_CONTROLS, ...JSON_FALLBACK_FIELDS]); return Object.freeze({ covered: Object.freeze(fields.filter((field) => registered.has(field))), missing: Object.freeze(fields.filter((field) => !registered.has(field))) }); }

