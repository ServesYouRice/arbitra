import { describe, expect, it } from "vitest";

import { resolveEffort } from "../src/effort.js";
import { parseModelProfile } from "../src/profiles/model-profile.js";
import { collapseDuplicateServedIdentities, independenceGroupOf, servedIdentity } from "../src/served-identity.js";

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

  it("collapses aliases served by one endpoint and resolved model identity", () => {
    const first = parseModelProfile(profileInput());
    const second = parseModelProfile({ ...profileInput(), id: "alias-b", provider: "proxy-alias" });
    expect(servedIdentity(first)).toBe(servedIdentity(second));
    expect(collapseDuplicateServedIdentities([first, second])).toEqual([first]);
  });

  it("gives an unknown family without curated metadata a singleton independence group", () => {
    const first = parseModelProfile(profileInput());
    const second = parseModelProfile({ ...profileInput(), id: "custom-b", modelId: "another-model", servedBy: "another-model" });
    expect(independenceGroupOf(first)).toMatch(/^singleton:[a-f0-9]{64}$/u);
    expect(independenceGroupOf(first)).not.toBe(independenceGroupOf(second));
  });

  it("rejects free-form quirks and undeclared effort collapse", () => {
    const invalidQuirk = profileInput();
    expect(() => parseModelProfile({ ...invalidQuirk, quirks: { ...invalidQuirk.quirks, magic: true } })).toThrow(/unknown fields magic/u);
    const invalidEffort = profileInput();
    expect(() => parseModelProfile({ ...invalidEffort, effort: { ...invalidEffort.effort, collapse: { medium: "high" } } })).toThrow(/collapse\.xhigh/u);
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
