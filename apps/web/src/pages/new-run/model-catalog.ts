/**
 * The models arbitra knows to work on each transport, offered as choices so a model ID cannot be mistyped. Choosing
 * one also sets the profile's family and capability tier. A model not listed can still be named ("another model ID"),
 * and the full configuration stays editable as JSON. The first entry of each list is the recommended one.
 */
export interface CatalogModel { readonly modelId: string; readonly family: string; readonly tier: "frontier" | "balanced" | "fast"; readonly note: string }

const CLAUDE: readonly CatalogModel[] = [
  { modelId: "claude-opus-5-5", family: "claude", tier: "frontier", note: "strongest, slowest" },
  { modelId: "claude-sonnet-5-5", family: "claude", tier: "balanced", note: "balanced" },
  { modelId: "claude-haiku-5-5", family: "claude", tier: "fast", note: "fast, light on usage" },
  { modelId: "claude-sonnet-5", family: "claude", tier: "balanced", note: "previous Sonnet" },
  { modelId: "claude-haiku-4-5-20251001", family: "claude", tier: "fast", note: "previous Haiku" },
];
const OPENAI: readonly CatalogModel[] = [
  { modelId: "gpt-6.1-sol", family: "gpt", tier: "frontier", note: "strongest" },
  { modelId: "gpt-6-luna", family: "gpt", tier: "balanced", note: "faster, lighter on usage" },
  { modelId: "gpt-5.6-luna", family: "gpt", tier: "balanced", note: "previous Luna" },
];
const GEMINI_CLI: readonly CatalogModel[] = [
  { modelId: "gemini-3.8-flash-medium", family: "gemini", tier: "frontier", note: "medium thinking" },
  { modelId: "gemini-3.8-flash-high", family: "gemini", tier: "frontier", note: "high thinking, slowest" },
  { modelId: "gemini-3.8-flash-low", family: "gemini", tier: "fast", note: "low thinking, fast but less reliable" },
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

export function catalogModel(transport: string, modelId: string): CatalogModel | undefined {
  return MODEL_CATALOG[transport]?.find((model) => model.modelId === modelId);
}
