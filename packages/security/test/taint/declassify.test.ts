import { describe, expect, it } from "vitest";

import {
  DECLASSIFIER_CATEGORIES,
  declassify,
  proveBoolean,
  proveBoundedNumber,
  proveEvidenceId,
  proveLineRange,
  proveOrchestratorId,
  proveSchemaEnum,
  proveSnapshotPath,
  type DeclassificationProof,
  type DeclassifiableSchemaPath,
} from "../../src/declassify/index.js";
import type { FieldTrust } from "../../src/provenance.js";
import { taintedBy } from "../../src/taint.js";

const taintedModelData: FieldTrust = {
  provenance: "model",
  taint: taintedBy("repo:fixture"),
  controlClass: "data",
};

describe("declassifier registry", () => {
  it("contains exactly the seven deterministic categories from the specification", () => {
    expect(DECLASSIFIER_CATEGORIES).toEqual([
      "schema_enum",
      "boolean",
      "bounded_number",
      "snapshot_path",
      "line_range",
      "evidence_id",
      "orchestrator_id",
    ]);
  });

  it("declassifies only when the proof category matches the field family", () => {
    const proof = proveSchemaEnum("high", ["critical", "high", "medium", "low"]);
    const result = declassify("sourceFinding.severity", "high", proof, taintedModelData);
    expect(result.trust.taint).toEqual({ tainted: false, sources: [] });
    expect(result.proof.category).toBe("schema_enum");

    expect(() => declassify(
      "sourceFinding.severity",
      "high",
      proveOrchestratorId("high", new Set(["high"])),
      taintedModelData,
    )).toThrow(/DECLASSIFIER_PROOF_MISMATCH/u);
  });

  it("proves the consumer-relevant property for every allowed category", () => {
    expect(proveBoolean(true).category).toBe("boolean");
    expect(proveBoundedNumber(0.8, { minimum: 0, maximum: 1 }).category).toBe("bounded_number");
    expect(proveSnapshotPath("src/a.ts", new Set(["src/a.ts"])).category).toBe("snapshot_path");
    expect(proveLineRange({ startLine: 2, endLine: 4 }, 5).category).toBe("line_range");
    expect(proveEvidenceId("artifact-1", new Set(["artifact-1"])).category).toBe("evidence_id");
    expect(proveOrchestratorId("node-1", new Set(["node-1"])).category).toBe("orchestrator_id");
  });

  it.each([
    ["sourceFinding.title", "finding_title"],
    ["sourceFinding.problem", "problem_description"],
    ["sourceFinding.evidence[0].text", "evidence_quotation"],
    ["sourceFinding.recommendedFix", "remediation_prose"],
    ["task.implementationGuidance", "implementation_guidance"],
    ["plan.criticRationale", "critic_rationale"],
    ["plan.plannerRationale", "planner_rationale"],
  ])("rejects never-declassifiable free text at %s", (field, reason) => {
    const unsafeCall = declassify as unknown as (
      path: string,
      value: string,
      proof: DeclassificationProof<string>,
      trust: FieldTrust,
    ) => unknown;
    expect(() => unsafeCall(
      field,
      "prose",
      proveSchemaEnum("prose", ["prose"]),
      taintedModelData,
    )).toThrow(new RegExp(`FREE_TEXT_NEVER_DECLASSIFIABLE: ${reason}`, "u"));
  });

  it("excludes a finding title from the typed public interface", () => {
    type TitlePath = Extract<"sourceFinding.title", DeclassifiableSchemaPath>;
    const titleIsExcluded: TitlePath extends never ? true : false = true;
    expect(titleIsExcluded).toBe(true);
  });

  it("rejects failed proofs instead of treating structural validity as authority", () => {
    expect(() => proveSnapshotPath("outside.ts", new Set(["inside.ts"]))).toThrow(
      /PATH_NOT_IN_IMMUTABLE_SNAPSHOT/u,
    );
    expect(() => proveLineRange({ startLine: 1, endLine: 12 }, 10)).toThrow(
      /LINE_RANGE_OUTSIDE_ACTUAL_FILE/u,
    );
    expect(() => proveEvidenceId("missing", new Set())).toThrow(/EVIDENCE_ID_DOES_NOT_RESOLVE/u);
    expect(() => proveOrchestratorId("model-made", new Set())).toThrow(/ID_NOT_ORCHESTRATOR_GENERATED/u);
  });

  it("rejects forged proofs and control-bearing values", () => {
    const forged = {
      category: "schema_enum",
      value: "high",
      property: "claimed",
    } as unknown as DeclassificationProof<string>;
    expect(() => declassify("sourceFinding.severity", "high", forged, taintedModelData)).toThrow(
      /UNREGISTERED_DECLASSIFIER_PROOF/u,
    );
    expect(() => declassify(
      "sourceFinding.severity",
      "high",
      proveSchemaEnum("high", ["high"]),
      { ...taintedModelData, controlClass: "instruction" },
    )).toThrow(/CONTROL_CLASS_NOT_DECLASSIFIABLE/u);
  });
});
