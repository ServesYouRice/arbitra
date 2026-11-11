import type { TransportUsage } from "./transport-contract.js";

/**
 * What an API call costs, in US dollars per million tokens, by model ID. Only API endpoints are priced: a subscription
 * CLI is paid for by its plan, whatever a call reads. Update the table and its date together when a vendor changes its
 * prices; a model not listed is unpriced, and a dollar cap on it is refused rather than left unenforced.
 *
 * Source: Anthropic's first-party API prices as the claude-api skill lists them (cached November 3, 2026), read
 * November 11, 2026. Cache writes are the 5-minute writes arbitra makes (`cache_control: ephemeral`), 1.25 times the
 * input price; cache reads are as each model lists them. Observed live (memoria, November 10, 2026): cache writes
 * were most of an Opus run's cost, so they are priced apart from plain input.
 */
export const PRICES_AS_OF = "2026-11-11";

export interface TokenPrice {
  readonly inputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
  readonly cacheWriteUsdPerMillion: number;
  readonly cacheReadUsdPerMillion: number;
  /** A higher price for a call whose input is above `aboveInputTokens` (Haiku 5.5 above 100K tokens). */
  readonly longPrompt?: { readonly aboveInputTokens: number } & Omit<TokenPrice, "longPrompt">;
}

const price = (input: number, output: number, cacheRead: number): TokenPrice => Object.freeze({ inputUsdPerMillion: input, outputUsdPerMillion: output, cacheWriteUsdPerMillion: input * 1.25, cacheReadUsdPerMillion: cacheRead });

export const TOKEN_PRICES: Readonly<Record<string, TokenPrice>> = Object.freeze({
  "claude-fable-5-2": price(8, 40, 0.2),
  "claude-mythos-5-2": price(8, 40, 0.2),
  "claude-fable-5-1": price(10, 50, 0.25),
  "claude-mythos-5-1": price(10, 50, 0.25),
  "claude-fable-5": price(10, 50, 1),
  "claude-mythos-5": price(10, 50, 1),
  "claude-opus-5-5": price(4, 20, 0.2),
  "claude-opus-5": price(5, 25, 0.5),
  "claude-opus-4-8": price(5, 25, 0.5),
  "claude-opus-4-7": price(5, 25, 0.5),
  "claude-opus-4-6": price(5, 25, 0.5),
  "claude-sonnet-5-5": price(2, 10, 0.1),
  "claude-sonnet-5": price(2, 10, 0.2),
  "claude-sonnet-4-6": price(3, 15, 0.3),
  // Above 100K input tokens a call is priced at $0.50 / $2.50; its cache prices there follow the same multipliers.
  "claude-haiku-5-5": Object.freeze({ ...price(0.1, 0.5, 0.01), longPrompt: Object.freeze({ aboveInputTokens: 100_000, ...price(0.5, 2.5, 0.05) }) }),
  "claude-haiku-4-5": price(1, 5, 0.1),
});

/** The price of a model, by its ID without a date suffix (`claude-haiku-4-5-20251001`) or a context tag (`[1m]`). */
export function priceOf(modelId: string): TokenPrice | null {
  const bare = modelId.trim().toLowerCase().replace(/\[[^\]]*\]$/u, "").replace(/-\d{8}$/u, "");
  return Object.hasOwn(TOKEN_PRICES, bare) ? TOKEN_PRICES[bare] ?? null : null;
}

/**
 * The dollars one call cost, from its reported usage: uncached input, cache writes, cache reads and output each at
 * their own price. `inputTokens` counts cache reads and writes (the transports' usage contract). Null when the usage
 * does not say what was read and written, never zero.
 */
export function callCostUsd(usage: TransportUsage | null, prices: TokenPrice): number | null {
  if (usage === null || usage.inputTokens === null || usage.outputTokens === null) return null;
  const read = usage.cacheReadTokens ?? 0; const written = usage.cacheWriteTokens ?? 0;
  const uncached = Math.max(0, usage.inputTokens - read - written);
  const tier = prices.longPrompt !== undefined && usage.inputTokens > prices.longPrompt.aboveInputTokens ? prices.longPrompt : prices;
  return (uncached * tier.inputUsdPerMillion + written * tier.cacheWriteUsdPerMillion + read * tier.cacheReadUsdPerMillion + usage.outputTokens * tier.outputUsdPerMillion) / 1_000_000;
}
