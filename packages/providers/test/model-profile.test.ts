import { describe, expect, it } from "vitest";

import { resolveEffort } from "../src/effort.js";
import { parseModelProfile } from "../src/profiles/model-profile.js";

describe("model profiles", () => {
  it("parses a custom profile with typed capabilities, limits and quirks", () => {
    const profile = parseModelProfile(profileInput());
    expect(profile).toMatchObject({
      id: "custom-a", capabilityTier: "fast", family: "unknown-family",
      supports: { tools: true, reasoning: true },
      quirks: { systemPromptSupport: "full", historyPolicy: "round_trip_opaque", toolLoopLimit: 8 },
    });
    expect(Object.isFrozen(profile)).toBe(true);
  });

  it("keeps capability and effort independent and surfaces xhigh collapse", () => {
    const profile = parseModelProfile(profileInput());
    expect(profile.capabilityTier).toBe("fast");
    expect(resolveEffort(profile, "xhigh")).toEqual({
      applied: "high",
      collapsedFrom: "xhigh",
      params: { thinking_level: "high" },
    });
  });

  it("rejects free-form quirks and undeclared effort collapse", () => {
    const invalidQuirk = profileInput();
    expect(() => parseModelProfile({ ...invalidQuirk, quirks: { ...invalidQuirk.quirks, magic: true } })).toThrow(/unknown fields magic/u);
    const invalidEffort = profileInput();
    expect(() => parseModelProfile({ ...invalidEffort, effort: { ...invalidEffort.effort, collapse: { medium: "high" } } })).toThrow(/collapse\.xhigh/u);
    expect(() => parseModelProfile({ ...profileInput(), limits: { contextTokens: 0, maxOutputTokens: 1 } })).toThrow(/positive safe integer/u);
    const nonFinite = profileInput();
    expect(() => parseModelProfile({ ...nonFinite, effort: { ...nonFinite.effort, params: { ...nonFinite.effort.params, low: { thinking_level: Number.NaN } } } })).toThrow(/effort\.params\.low\.thinking_level/u);
  });
});

function profileInput() {
  return {
    id: "custom-a",
    provider: "custom-proxy",
    modelId: "alias-model",
    transport: "custom-compatible",
    baseUrl: "https://models.example.test/v1",
    servedBy: "resolved-model",
    fingerprint: null,
    family: "unknown-family",
    independenceGroup: null,
    capabilityTier: "fast",
    supports: {
      tools: true, parallelToolCalls: false, structuredOutput: true, reasoning: true,
      promptCaching: false, batch: false, vision: false,
    },
    limits: { contextTokens: 100_000, maxOutputTokens: 8_000 },
    effort: {
      supported: ["low", "high"],
      collapse: { medium: "high", xhigh: "high" },
      params: { low: { thinking_level: "low" }, high: { thinking_level: "high" } },
    },
    quirks: {
      systemPromptSupport: "full",
      fewShotPolicy: "neutral",
      promptStyle: "markdown",
      documentPlacement: "leading",
      historyPolicy: "round_trip_opaque",
      samplingDefaults: { temperature: 0.2, topP: 0.9, topK: null },
      greedyDecodingSafe: false,
      toolLoopLimit: 8,
      prefillSupported: false,
    },
    structuredOutputDialect: "json_mode",
  };
}
