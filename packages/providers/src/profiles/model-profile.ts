import { parseEffortProfile, type EffortProfile } from "../effort.js";
import {
  booleanValue, enumValue, exactKeys, nullableNumber, parseProviderQuirks,
  record, type ProviderQuirks,
} from "../quirks.js";

export type CapabilityTier = "frontier" | "balanced" | "fast";
export type StructuredOutputDialect = "openai_strict" | "gemini" | "anthropic_tool" | "json_mode" | "prompt_json" | "none";

export interface ModelSupports {
  readonly tools: boolean;
  readonly parallelToolCalls: boolean;
  readonly structuredOutput: boolean;
  readonly reasoning: boolean;
  readonly promptCaching: boolean;
  readonly batch: boolean;
  readonly vision: boolean;
}

export interface ModelProfile {
  readonly id: string;
  readonly provider: string;
  readonly modelId: string;
  readonly transport: string;
  readonly baseUrl: string;
  readonly servedBy: string | null;
  readonly fingerprint: string | null;
  readonly family: string;
  readonly independenceGroup: string | null;
  readonly capabilityTier: CapabilityTier;
  readonly supports: ModelSupports;
  readonly limits: { readonly contextTokens: number | null; readonly maxOutputTokens: number | null };
  readonly effort: EffortProfile;
  readonly quirks: ProviderQuirks;
  readonly structuredOutputDialect: StructuredOutputDialect;
}

export function parseModelProfile(value: unknown): ModelProfile {
  const input = record(value, "profile");
  exactKeys(input, ["id", "provider", "modelId", "transport", "baseUrl", "servedBy", "fingerprint", "family",
    "independenceGroup", "capabilityTier", "supports", "limits", "effort", "quirks", "structuredOutputDialect"], "profile");
  const supports = record(input["supports"], "supports");
  exactKeys(supports, ["tools", "parallelToolCalls", "structuredOutput", "reasoning", "promptCaching", "batch", "vision"], "supports");
  const limits = record(input["limits"], "limits");
  exactKeys(limits, ["contextTokens", "maxOutputTokens"], "limits");
  const baseUrl = nonempty(input["baseUrl"], "baseUrl");
  try { new URL(baseUrl); } catch { throw new Error("INVALID_PROFILE:baseUrl: expected absolute URL"); }
  return Object.freeze({
    id: nonempty(input["id"], "id"), provider: nonempty(input["provider"], "provider"),
    modelId: nonempty(input["modelId"], "modelId"), transport: nonempty(input["transport"], "transport"), baseUrl,
    servedBy: nullableString(input["servedBy"], "servedBy"), fingerprint: nullableString(input["fingerprint"], "fingerprint"),
    family: nonempty(input["family"], "family"), independenceGroup: nullableString(input["independenceGroup"], "independenceGroup"),
    capabilityTier: enumValue(input["capabilityTier"], ["frontier", "balanced", "fast"], "capabilityTier"),
    supports: Object.freeze({
      tools: booleanValue(supports["tools"], "supports.tools"),
      parallelToolCalls: booleanValue(supports["parallelToolCalls"], "supports.parallelToolCalls"),
      structuredOutput: booleanValue(supports["structuredOutput"], "supports.structuredOutput"),
      reasoning: booleanValue(supports["reasoning"], "supports.reasoning"),
      promptCaching: booleanValue(supports["promptCaching"], "supports.promptCaching"),
      batch: booleanValue(supports["batch"], "supports.batch"), vision: booleanValue(supports["vision"], "supports.vision"),
    }),
    limits: Object.freeze({ contextTokens: nullableNumber(limits["contextTokens"], "limits.contextTokens"),
      maxOutputTokens: nullableNumber(limits["maxOutputTokens"], "limits.maxOutputTokens") }),
    effort: parseEffortProfile(input["effort"]), quirks: parseProviderQuirks(input["quirks"]),
    structuredOutputDialect: enumValue(input["structuredOutputDialect"], ["openai_strict", "gemini", "anthropic_tool", "json_mode", "prompt_json", "none"], "structuredOutputDialect"),
  });
}

function nonempty(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`INVALID_PROFILE:${path}: expected non-empty string`);
  return value;
}
function nullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return nonempty(value, path);
}
