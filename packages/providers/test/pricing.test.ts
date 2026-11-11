import { describe, expect, it } from "vitest";
import { callCostUsd, priceOf, PRICES_AS_OF } from "../src/pricing.js";

describe("token prices", () => {
  it("prices cache writes and cache reads apart from plain input", () => {
    // Observed live (memoria, November 10, 2026): cache writes were most of an Opus run's cost.
    const opus = priceOf("claude-opus-5-5");
    if (opus === null) throw new Error("PRICE_ABSENT");
    // 100K uncached input $0.40, 200K cache writes $1.00, 1M cache reads $0.20, 10K output $0.20.
    expect(callCostUsd({ inputTokens: 1_300_000, outputTokens: 10_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 200_000 }, opus)).toBeCloseTo(1.8, 10);
    expect(callCostUsd({ inputTokens: 1_000, outputTokens: 1_000, cacheReadTokens: null, cacheWriteTokens: null }, opus)).toBeCloseTo(0.024, 10);
    expect(callCostUsd({ inputTokens: null, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }, opus)).toBeNull();
    expect(callCostUsd(null, opus)).toBeNull();
  });

  it("knows a model by its ID without a date or context suffix, carries its date, and prices nothing it does not list", () => {
    expect(priceOf("claude-haiku-4-5-20251001")).toEqual(priceOf("claude-haiku-4-5"));
    expect(priceOf("claude-opus-5-5[1m]")).toEqual(priceOf("claude-opus-5-5"));
    expect(priceOf("gpt-6.1-sol")).toBeNull();
    expect(PRICES_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  });

  it("prices a long Haiku 5.5 prompt at its higher rate", () => {
    const haiku = priceOf("claude-haiku-5-5");
    if (haiku === null) throw new Error("PRICE_ABSENT");
    expect(callCostUsd({ inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, haiku)).toBeCloseTo(0.01, 10);
    expect(callCostUsd({ inputTokens: 200_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, haiku)).toBeCloseTo(0.1, 10);
  });
});
