import { describe, expect, it } from "vitest";
import { effortFor, modelName, modelNodeLabels } from "../src/pages/run/models.js";

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
});
