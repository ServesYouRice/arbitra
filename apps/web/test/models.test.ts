import { describe, expect, it } from "vitest";
import { effortFor, modelName, modelNodeLabels } from "../src/pages/run/models.js";
import { MODEL_CATALOG, modelSettings } from "../src/pages/new-run/model-catalog.js";

describe("models as people name them", () => {
  it("names models, reads each stage's effort in the vendor's word and labels graph nodes with both", () => {
    expect(["claude-opus-5-5", "claude-haiku-4-5-20251001", "gpt-6.1-sol", "gpt-5.6-luna", "gemini-3.8-flash-medium", "custom-model"].map(modelName))
      .toEqual(["Opus 5.5", "Haiku 4.5", "GPT-6.1 Sol", "GPT-5.6 Luna", "Gemini 3.8 Flash medium", "custom-model"]);
    const opus = { modelId: "claude-opus-5-5", effort: { params: { low: { effort: "medium" }, medium: { effort: "high" }, high: { effort: "xhigh" } } } };
    const config = { mode: "audit", auditDepth: "deep", models: { "auditor-a": opus, "auditor-b": { modelId: "gpt-6.1-sol" } },
      workflow: { modelExecution: { roles: { planner: "auditor-a", verifier: "auditor-a" }, stageEffort: { verification: "medium", planner: "medium" } } } };
    // Deep audits ask "high", which this profile sends to Claude Code as "xhigh"; later stages run at their own effort.
    expect(effortFor(config, "auditor-a", "discovery")).toBe("xhigh");
    expect(effortFor(config, "auditor-a", "verification")).toBe("high");
    expect(effortFor(config, "auditor-b", "discovery")).toBe("high");
    expect(Object.fromEntries(modelNodeLabels(config))).toEqual({ "auditor-a": "Opus 5.5 · xhigh", "auditor-b": "GPT-6.1 Sol · high", planner: "Opus 5.5 · high", verification: "Opus 5.5 · high" });
    expect(modelNodeLabels(null).size).toBe(0);
  });

  it("reads finding's own effort, per profile, before the depth's", () => {
    const words = { params: Object.fromEntries(["low", "medium", "high", "xhigh", "max"].map((level) => [level, { effort: level }])) };
    const config = { mode: "audit", auditDepth: "cheap", models: { "auditor-a": { modelId: "claude-sonnet-5-5", effort: words }, "auditor-b": { modelId: "gpt-6-luna", effort: words }, "auditor-c": { modelId: "gemini-3.8-flash-high", effort: { params: {} } }, checker: { modelId: "claude-opus-5-5", effort: words } },
      workflow: { modelExecution: { roles: { planner: "auditor-a", verifier: "checker" }, stageEffort: { discovery: { "auditor-a": "high", "auditor-b": "max", "auditor-c": "high" }, verification: "high", secondOpinion: "medium" } } } };
    expect(["auditor-a", "auditor-b", "auditor-c"].map((alias) => effortFor(config, alias, "discovery"))).toEqual(["high", "max", "high"]);
    expect(effortFor(config, "checker", "verification")).toBe("high");
    // A stage the configuration leaves out runs at the depth's level: medium at cheap.
    expect(effortFor(config, "auditor-a", "planner")).toBe("medium");
  });
});

describe("the model catalog", () => {
  it("sends every current Claude Code and Codex model the effort asked for, in the CLI's own word", () => {
    const settings = (transport: string, modelId: string) => {
      const model = MODEL_CATALOG[transport]?.find((entry) => entry.modelId === modelId);
      if (model === undefined) throw new Error(`NOT_IN_CATALOG:${modelId}`);
      return Object.fromEntries(modelSettings(model).map(([path, value]) => [path.join("."), value])) as Record<string, unknown>;
    };
    // Sonnet, Haiku and Luna had no effort words, so the CLI ran them at its own default whatever the configuration said;
    // Opus and Sol had arbitra's levels moved one step up. Each level now sends its own word, low to max.
    for (const [transport, modelId] of [["claude-code-cli", "claude-opus-5-5"], ["claude-code-cli", "claude-sonnet-5-5"], ["claude-code-cli", "claude-haiku-5-5"], ["codex-cli", "gpt-6.1-sol"], ["codex-cli", "gpt-6-luna"]] as const) {
      expect(settings(transport, modelId)["effort"], modelId).toEqual({ supported: ["low", "medium", "high", "xhigh", "max"], collapse: {},
        params: { low: { effort: "low" }, medium: { effort: "medium" }, high: { effort: "high" }, xhigh: { effort: "xhigh" }, max: { effort: "max" } } });
    }
    // A model whose words are not known keeps its declared levels and sends none; Gemini's effort is in its model ID.
    expect(settings("claude-code-cli", "claude-haiku-4-5-20251001")["effort.params"]).toEqual({});
    expect(settings("antigravity-cli", "gemini-3.8-flash-high")["effort.params"]).toEqual({});
  });
});
