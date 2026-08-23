import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createExclusionPolicy, isExcluded } from "../../src/exclusions.js";
import { allocateOverlap, type OverlapSignal } from "../../src/overlap-allocator.js";
import { redactSecrets } from "../../src/redaction.js";
import { scan } from "../../src/scanner/index.js";
import { suppressionCandidates } from "../../src/suppression.js";
import { resolveControlPlane, type ControlPlaneReader } from "../../src/control-plane/resolver.js";

const root = new URL("../../../testing/fixtures/security/", import.meta.url);
function fixture<T>(name: string): T { return JSON.parse(readFileSync(new URL(name, root), "utf8")) as T; }

describe("offline security fixture suite", () => {
  it.each([
    ["instruction-shaped.json", "instruction_shaped_text"],
    ["hidden-unicode.json", "hidden_unicode"],
    ["wrapper-breaking.json", "wrapper_breaking_sequence"],
  ])("protects scanner and taint invariant: %s", (name, expectedRule) => {
    const value = fixture<{ content?: string; contentCodePoints?: number[] }>(name);
    const content = value.content ?? String.fromCodePoint(...(value.contentCodePoints ?? []));
    const result = scan(content, name);
    expect(result.instructionRisk.affectedRanges).toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: expectedRule })]));
    expect(result).not.toHaveProperty("trusted");
  });

  it("protects suppression invariant: a real defect behind suppression text remains a candidate", () => {
    const value = fixture<{ path: string; riskRange: [number, number]; readBy: string[] }>("suppression-real-defect.json");
    const detect = () => suppressionCandidates([{ path: value.path, instructionRisk: { level: "high", affectedRanges: [{ ruleId: "imperative_suppression", byteStart: value.riskRange[0], byteEnd: value.riskRange[1] }] } }], { paths: [value.path] }, value.readBy.map((auditorId) => ({ auditorId, ranges: [{ path: value.path, start: 0, end: 200 }] })), []);
    expect(detect()).toMatchObject([{ path: value.path, readBy: ["auditor-a"], findingsCiting: [] }]);
    expect(() => assertSuppressionFixture(() => [])).toThrow("MUTATION_SURVIVED_SUPPRESSION_FIXTURE");
    expect(() => assertSuppressionFixture(detect)).not.toThrow();
  });

  it("protects trusted-control-plane invariant against head-side exclusion subversion", async () => {
    const value = fixture<{ baseIgnore: string; headIgnore: string; vulnerablePath: string }>("control-plane-subversion.json");
    const reader: ControlPlaneReader = { async readAtRevision(_root, revision, path) { if (path !== ".llmorchestratorignore") return null; return revision === "base" ? value.baseIgnore : value.headIgnore; }, async changedPaths() { return [".llmorchestratorignore", value.vulnerablePath]; } };
    const resolved = await resolveControlPlane({ repositoryRoot: "fixture", trustedBaseRevision: "base", auditedRevision: "head" }, { reader });
    expect(isExcluded(value.vulnerablePath, createExclusionPolicy(resolved.assets.ignore_exclusion_policy.content))).toBe(false);
    expect(resolved.auditSubjects).toContainEqual(expect.objectContaining({ path: ".llmorchestratorignore", disposition: "recorded_not_applied" }));
  });

  it("protects bounded-overlap invariant against scanner cost amplification", () => {
    const value = fixture<{ signalCount: number; tokensPerSignal: number; maximumAdditionalTokens: number; expectedAllocated: number; expectedSkipped: number }>("cost-amplification.json");
    const signals: OverlapSignal[] = Array.from({ length: value.signalCount }, (_, index) => ({ path: `file-${index}.ts`, level: index < value.signalCount / 2 ? "medium" : "low", instructionShaped: false, securitySensitiveChanged: false, suspiciousDirective: false, controlPolicyChanged: false, estimatedAdditionalTokens: value.tokensPerSignal }));
    const plan = allocateOverlap(signals, { maximumAdditionalTokens: value.maximumAdditionalTokens, mode: "ci" });
    expect(plan.decisions.filter(({ disposition }) => disposition === "budgeted")).toHaveLength(value.expectedAllocated);
    expect(plan.decisions.filter(({ disposition }) => disposition === "not_allocated")).toHaveLength(value.expectedSkipped);
    expect(plan.securityCoverage).toMatchObject({ degraded: true, reason: "overlap_budget_exceeded" });
  });

  it("protects outbound redaction invariant for stdout and export serialization", () => {
    const value = fixture<{ content: string; secret: string; expectedReplacement: string }>("outbound-redaction.json");
    for (const channel of ["stdout", "export"] as const) {
      const outbound = JSON.stringify({ channel, result: redactSecrets(value.content).text });
      expect(outbound).toContain(value.expectedReplacement);
      expect(outbound).not.toContain(value.secret);
    }
  });
});

function assertSuppressionFixture(detect: () => readonly unknown[]): void { if (detect().length === 0) throw new Error("MUTATION_SURVIVED_SUPPRESSION_FIXTURE"); }
