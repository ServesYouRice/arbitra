import { describe, expect, it } from "vitest";

import { CONTROL_CLASSES, type ControlClass } from "../../src/control-class.js";
import { PROVENANCES, annotateTrust, type Provenance } from "../../src/provenance.js";
import { CLEAN_TAINT, propagate, taintForOutput, taintedBy } from "../../src/taint.js";

describe("taint propagation", () => {
  const combinations = PROVENANCES.flatMap((provenance) =>
    CONTROL_CLASSES.map((controlClass) => ({ provenance, controlClass })),
  );

  it.each(combinations)(
    "preserves one tainted input for $provenance/$controlClass output",
    ({ provenance }: { provenance: Provenance; controlClass: ControlClass }) => {
      const output = taintForOutput(provenance, `output:${provenance}`, [
        CLEAN_TAINT,
        taintedBy("repo:poisoned-fixture"),
      ]);

      expect(output.tainted).toBe(true);
      expect(output.sources).toContain("repo:poisoned-fixture");
    },
  );

  it("always taints repository bytes and does not infer taint from provenance alone otherwise", () => {
    expect(taintForOutput("repo", "repo:src/a.ts")).toEqual({
      tainted: true,
      sources: ["repo:src/a.ts"],
    });
    expect(taintForOutput("system", "system:protocol")).toBe(CLEAN_TAINT);
    expect(taintForOutput("user", "user:intent")).toBe(CLEAN_TAINT);
    expect(taintForOutput("tool", "tool:test")).toBe(CLEAN_TAINT);
    expect(taintForOutput("model", "model:answer")).toBe(CLEAN_TAINT);
  });

  it("deduplicates, sorts and freezes propagated source metadata", () => {
    const result = propagate([taintedBy("b", "a"), taintedBy("a")]);
    expect(result.sources).toEqual(["a", "b"]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.sources)).toBe(true);
  });

  it("requires field-family trust metadata on annotated artifacts", () => {
    const artifact = annotateTrust(
      { title: "untrusted", severity: "high" },
      {
        title: { provenance: "model", taint: taintedBy("repo:a"), controlClass: "data" },
        severity: { provenance: "model", taint: CLEAN_TAINT, controlClass: "data" },
      },
    );
    expect(artifact.fieldTrust.title.taint.tainted).toBe(true);
    expect(artifact.fieldTrust.severity.taint.tainted).toBe(false);
    expect(() => annotateTrust(artifact.value, {})).toThrow(/TRUST_METADATA_REQUIRED/u);
    expect(() => annotateTrust(artifact.value, {
      title: { provenance: "repo", taint: CLEAN_TAINT, controlClass: "data" },
    })).toThrow(/REPOSITORY_CONTENT_MUST_BE_TAINTED/u);
  });
});
