import { describe, expect, it } from "vitest";
import { validateFeatureExploration } from "../src/feature-exploration.js";
import { featureComplexityGate, type RequirementsContract } from "@arbitra/workflow/nodes/requirements/index.js";

const requirements: RequirementsContract = { schemaVersion: 1, featureRequest: "Preferences", assumptions: [{ id: "ASM", statement: "Keep sessions", confidence: "high" }], ambiguities: [], acceptance: [{ id: "ACC", assertion: "Preferences persist" }], outOfScope: [], decision: { mode: "automatic", acceptedDefaults: [] } };
const snapshot = { root: "unused", files: [{ path: "session.ts", lines: ["export const session = true;"], byteLength: 28, lineStartBytes: [0] }] };
function exploration() {
  return { summary: "Session preferences", preflight: { affectedSurfaces: [{ id: "sessions", paths: ["session.ts"], riskCategories: ["security"], relevantTo: ["ACC"] }], securitySensitiveSurfaceCount: 1, migrationInvolvement: false, architectureBreadth: 1, testingComplexity: 1 }, evidence: [{ surfaceId: "sessions", path: "session.ts", startLine: 1, endLine: 1, text: "export const session = true;" }], limitations: [] };
}

describe("grounded Feature exploration", () => {
  it("accepts source-backed surfaces and routes them against recorded requirements", () => {
    const result = validateFeatureExploration(exploration(), requirements, snapshot);
    expect(featureComplexityGate(requirements, result.preflight).targetedSurfaceIds).toEqual(["sessions"]);
  });

  it("rejects invented requirements, out-of-snapshot paths and missing evidence", () => {
    const unknownRequirement = exploration();
    for (const surface of unknownRequirement.preflight.affectedSurfaces) surface.relevantTo = ["INVENTED"];
    expect(() => validateFeatureExploration(unknownRequirement, requirements, snapshot)).toThrow("FEATURE_EXPLORATION_UNKNOWN_REQUIREMENT");
    const unknownPath = exploration();
    for (const surface of unknownPath.preflight.affectedSurfaces) surface.paths = ["../outside.ts"];
    expect(() => validateFeatureExploration(unknownPath, requirements, snapshot)).toThrow("FEATURE_EXPLORATION_UNKNOWN_PATH");
    expect(() => validateFeatureExploration({ ...exploration(), evidence: [] }, requirements, snapshot)).toThrow("FEATURE_EXPLORATION_EVIDENCE_MISSING");
  });

  it("re-anchors exact quotations whose stated range is miscounted", () => {
    const result = exploration(); const original = structuredClone(result.evidence);
    result.evidence = result.evidence.map((evidence) => ({ ...evidence, endLine: 2 }));
    expect(validateFeatureExploration(result, requirements, snapshot).evidence).toEqual(original);
  });

  it.each([{ text: "fabricated quotation" }, { startLine: 40, endLine: 40 }, { startLine: 2 }, { surfaceId: "unknown" }])("rejects ungrounded citations: %j", (patch) => {
    const result = exploration(); result.evidence = result.evidence.map((evidence) => ({ ...evidence, ...patch }));
    expect(() => validateFeatureExploration(result, requirements, snapshot)).toThrow();
  });

  it.each([{ securitySensitiveSurfaceCount: 2 }, { architectureBreadth: 0.5 }, { testingComplexity: "1" }, { migrationInvolvement: "false" }])("rejects malformed routing metrics: %j", (patch) => {
    const result = exploration();
    expect(() => validateFeatureExploration({ ...result, preflight: { ...result.preflight, ...patch } }, requirements, snapshot)).toThrow();
  });
});
