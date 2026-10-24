import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../src/redaction.js";
import { scan } from "../../src/scanner/index.js";
import { suppressionCandidates } from "../../src/suppression.js";

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
