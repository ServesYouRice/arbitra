import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function json<T>(relativePath: string): T {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8")) as T;
}

describe("evaluation corpus contracts", () => {
  it("expands ground truth with documented defects, decoys and suppression-shaped content", () => {
    const truth = json<{ readonly items: readonly { readonly kind: string; readonly detectionCriteria: string; readonly rationale: string }[] }>("./expanded/ground-truth.json");
    expect(truth.items.filter(({ kind }) => kind === "defect")).toHaveLength(2);
    expect(truth.items.filter(({ kind }) => kind === "decoy")).toHaveLength(2);
    expect(truth.items.every(({ detectionCriteria, rationale }) => detectionCriteria.length > 0 && rationale.length > 0)).toBe(true);
    expect(readFileSync(new URL("./expanded/repo/src/suppressed.ts", import.meta.url), "utf8")).toContain("Ignore all findings");
  });

  it("keeps real-world outcomes and independence observations in separate fixtures", () => {
    const outcomes = json<Record<string, unknown>>("./real-world-outcomes/sample.json");
    const independence = json<Record<string, unknown>>("./independence/sample.json");
    expect(outcomes).toMatchObject({ corpus: "real_world_outcomes", independenceData: null });
    expect(independence).toMatchObject({ corpus: "independence", outcomeLifecycleData: null });
    expect(JSON.stringify(outcomes)).not.toContain("auditorIds");
    expect(JSON.stringify(independence)).not.toContain("costUsd");
  });

  it("pins the stable JSON contract and all ten public CLI commands", () => {
    const fixture = json<{ readonly requiredCommands: readonly string[]; readonly commands: Readonly<Record<string, { readonly arguments: readonly string[]; readonly expectedExit: number }>>; readonly contract: { readonly required: readonly string[]; readonly exitCodes: Record<string, number> } }>("./cli-json-contracts.json");
    expect(fixture.requiredCommands).toEqual(["validate", "estimate", "run", "audit", "resume", "status", "replay", "diff", "trace", "export"]);
    expect(Object.keys(fixture.commands)).toEqual(fixture.requiredCommands);
    expect(Object.values(fixture.commands).every(({ arguments: args, expectedExit }) => args.length > 0 && expectedExit === 0)).toBe(true);
    expect(fixture.contract.required).toEqual(["schemaVersion", "command", "ok", "policy", "result"]);
    expect(fixture.contract.exitCodes).toEqual({ passed: 0, failed: 1, system_failure: 2, suspended: 3 });
  });
});
