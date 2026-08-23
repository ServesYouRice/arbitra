export const CONTEXT_MODES = [
  "none",
  "selected_artifacts",
  "summary",
  "delta",
  "recent_turns",
  "full_context",
] as const;

export type ContextMode = (typeof CONTEXT_MODES)[number];

export const CONTEXT_TRUST_LEVELS = ["system", "derived", "untrusted"] as const;
export type ContextTrust = (typeof CONTEXT_TRUST_LEVELS)[number];

export interface ContextPolicy {
  readonly mode: ContextMode;
  readonly trust: ContextTrust;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

export const DEFAULT_CONTEXT_POLICY: ContextPolicy = {
  mode: "selected_artifacts",
  trust: "derived",
  include: [],
  exclude: [],
};

export function isContextMode(value: unknown): value is ContextMode {
  return typeof value === "string" && (CONTEXT_MODES as readonly string[]).includes(value);
}

export function isContextTrust(value: unknown): value is ContextTrust {
  return typeof value === "string" && (CONTEXT_TRUST_LEVELS as readonly string[]).includes(value);
}
