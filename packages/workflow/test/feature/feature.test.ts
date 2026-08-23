import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { featureComplexityGate, requirementsNode, validateFeatureTaskTraceability, type RequirementsContract } from "../../src/nodes/requirements/index.js";

const draft = {
  assumptions: [{ id: "ASM-1", statement: "Existing session identity remains authoritative.", confidence: "high" as const }],
  ambiguities: [{ id: "AMB-1", question: "Must old sessions migrate?", proposedDefault: "Keep old sessions valid.", blastRadius: "low" as const }],
  outOfScope: ["Identity provider replacement"],
  acceptance: [{ id: "ACC-1", assertion: "A signed-in user can enable the feature." }],
};

describe("Feature Mode requirements and routing", () => {
  it("persists a trivial automatic contract, records defaults and skips review", async () => {
    const persisted: RequirementsContract[] = [];
    const node = requirementsNode({
      mode: "automatic", protocolVersion: "1.0.0", protocolHash: "a".repeat(64),
      schema: { parse: () => draft }, runtime: { async generate(request) { expect(request.capability).toBe("balanced"); return draft; } },
      artifacts: { async persist(_kind, contract) { persisted.push(contract); return { artifactId: "artifact:req-simple" }; } },
    });
    const result = await node.run({ featureRequest: "Add a preference toggle", repositorySummary: { modules: ["settings"] } });
    expect(result.modelCalls).toBe(1);
    expect(result.checkpoint).toBeNull();
    expect(result.contract.decision.acceptedDefaults).toEqual([{ ambiguityId: "AMB-1", value: "Keep old sessions valid.", acceptedBy: "automatic_mode" }]);
    expect(persisted).toEqual([result.contract]);
    const route = featureComplexityGate(result.contract, preflight());
    expect(route).toMatchObject({ recommended: "FAST", multiModelReview: false, stages: ["requirements", "targeted_exploration", "planner", "renderer"] });
    expect(route.targetedSurfaceIds).toEqual(["settings"]);
  });

  it("persists before checkpointing and sends high risk through targeted review, Planner and Critic", async () => {
    const events: string[] = [];
    const risky = { ...draft, ambiguities: [{ ...draft.ambiguities[0]!, blastRadius: "high" as const }] };
    const node = requirementsNode({
      mode: "interactive", protocolVersion: "1.0.0", protocolHash: "b".repeat(64), schema: { parse: () => risky },
      runtime: { async generate() { events.push("model"); return risky; } },
      artifacts: { async persist() { events.push("persist"); return { artifactId: "artifact:req-risky" }; } },
    });
    const result = await node.run({ featureRequest: "Change session authorization", repositorySummary: {} });
    events.push("checkpoint");
    expect(events).toEqual(["model", "persist", "checkpoint"]);
    expect(result.checkpoint).toEqual({ kind: "high_impact_ambiguities", ambiguityIds: ["AMB-1"] });
    const route = featureComplexityGate(result.contract, { ...preflight(), securitySensitiveSurfaceCount: 1 });
    expect(route.recommended).toBe("DEEP");
    expect(route.stages).toEqual(expect.arrayContaining(["targeted_review", "planner", "critic"]));
    expect(route.multiModelReview).toBe(false);
  });

  it("requires every downstream task to reference a recorded assumption or acceptance", () => {
    const contract = contractFromDraft();
    expect(validateFeatureTaskTraceability(contract, [{ id: "TASK-1", requirementIds: ["ASM-1"] }, { id: "TASK-2", requirementIds: ["ACC-1"] }])).toEqual([]);
    expect(validateFeatureTaskTraceability(contract, [{ id: "TASK-3", requirementIds: [] }])).toEqual([{ taskId: "TASK-3", code: "FEATURE_TASK_REQUIREMENT_TRACE_MISSING" }]);
    expect(validateFeatureTaskTraceability(contract, [{ id: "TASK-4", requirementIds: ["AMB-1"] }])).toEqual([{ taskId: "TASK-4", code: "FEATURE_TASK_REQUIREMENT_TRACE_UNKNOWN" }]);
  });

  it("ships two presets over one canonical graph and a structured defaults-first protocol", () => {
    const simple = JSON.parse(readFileSync(new URL("../../src/presets/feature-simple.json", import.meta.url), "utf8")) as { graph: unknown };
    const risky = JSON.parse(readFileSync(new URL("../../src/presets/feature-high-risk.json", import.meta.url), "utf8")) as { graph: unknown };
    expect(simple.graph).toEqual({ id: "canonical-feature", version: 1 });
    expect(risky.graph).toEqual(simple.graph);
    const protocol = readFileSync(new URL("../../../protocols/assets/feature-requirements/1.0.0/protocol.md", import.meta.url), "utf8");
    expect(protocol).toContain("proposed defaults");
    expect(protocol).toContain("structured Requirements Contract");
  });
});

function contractFromDraft(): RequirementsContract {
  return { schemaVersion: 1, featureRequest: "Feature", ...draft, decision: { mode: "automatic", acceptedDefaults: [] } };
}

function preflight() {
  return { affectedSurfaces: [{ id: "settings", paths: ["src/settings.ts"], riskCategories: [], relevantTo: ["ACC-1"] }, { id: "unrelated", paths: ["src/billing.ts"], riskCategories: ["billing"], relevantTo: ["OTHER"] }], securitySensitiveSurfaceCount: 0, migrationInvolvement: false, architectureBreadth: 0, testingComplexity: 0 };
}

