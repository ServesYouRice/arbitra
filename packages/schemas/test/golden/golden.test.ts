import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import { runConfigSchema, RUN_CONFIG_FIELD_INVENTORY, type RunConfig } from "../../src/config.js";
import { sourceFindingSchema, type SourceFinding } from "../../src/finding.js";
import { harnessProfileSchema, type HarnessProfile } from "../../src/harness-profile.js";
import { issueOpSchema, type IssueOp } from "../../src/issue-ops.js";
import { modelProfileSchema, type ModelProfile } from "../../src/model-profile.js";
import { planIRSchema, type PlanIR } from "../../src/plan.js";
import { taskIRSchema, type TaskIR } from "../../src/task-ir.js";
import { validationContractSchema, type ValidationContract } from "../../src/validation-contract.js";

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(fixtureDirectory, name), "utf8")) as unknown;
}

const cases: ReadonlyArray<{
  name: string;
  schema: ZodType;
  invalidPath: string;
}> = [
  { name: "source-finding", schema: sourceFindingSchema, invalidPath: "sourceFindingId" },
  { name: "issue-op", schema: issueOpSchema, invalidPath: "round" },
  { name: "validation-contract", schema: validationContractSchema, invalidPath: "validation.0.evidence" },
  { name: "task-ir", schema: taskIRSchema, invalidPath: "addresses.requirements" },
  { name: "plan-ir", schema: planIRSchema, invalidPath: "unresolvedQuestions" },
  { name: "model-profile", schema: modelProfileSchema, invalidPath: "capabilityTier" },
  { name: "harness-profile", schema: harnessProfileSchema, invalidPath: "capabilities.structuredEvents" },
  { name: "run-config", schema: runConfigSchema, invalidPath: "maxConsensusRounds" },
];

describe("canonical schema golden fixtures", () => {
  for (const testCase of cases) {
    it(`${testCase.name} accepts its valid fixture`, () => {
      expect(testCase.schema.safeParse(fixture(`${testCase.name}.valid.json`)).success).toBe(true);
    });

    it(`${testCase.name} rejects its invalid fixture at ${testCase.invalidPath}`, () => {
      const result = testCase.schema.safeParse(fixture(`${testCase.name}.invalid.json`));
      expect(result.success).toBe(false);
      if (!result.success) {
        const paths = result.error.issues.map(({ path }) => path.join("."));
        expect(paths).toContain(testCase.invalidPath);
      }
    });
  }

  it("exports the exact UI configuration field inventory", () => {
    expect(RUN_CONFIG_FIELD_INVENTORY).toEqual([
      "mode", "scope", "auditDepth", "consensusPolicy", "maxConsensusRounds", "verification", "models",
      "harness", "workflow", "budgets", "security", "protocols", "promptOverrides", "contextPolicies",
    ]);
  });

  it("round-trips all Task IR address arrays without losing links", () => {
    const populated = taskIRSchema.parse(fixture("task-ir.valid.json"));
    const roundTripped = taskIRSchema.parse(JSON.parse(JSON.stringify(populated)) as unknown);
    expect(roundTripped.addresses).toEqual({
      issues: ["ISSUE-001"],
      validation: ["VAL-001"],
      requirements: ["ACC-001"],
    });

    const empty = taskIRSchema.parse({
      ...populated,
      addresses: { issues: [], validation: [], requirements: [] },
    });
    expect(empty.addresses).toEqual({ issues: [], validation: [], requirements: [] });
  });

  it("provides concrete inferred consumer types", () => {
    const values: [SourceFinding, IssueOp, ValidationContract, TaskIR, PlanIR, ModelProfile, HarnessProfile, RunConfig] = [
      sourceFindingSchema.parse(fixture("source-finding.valid.json")),
      issueOpSchema.parse(fixture("issue-op.valid.json")),
      validationContractSchema.parse(fixture("validation-contract.valid.json")),
      taskIRSchema.parse(fixture("task-ir.valid.json")),
      planIRSchema.parse(fixture("plan-ir.valid.json")),
      modelProfileSchema.parse(fixture("model-profile.valid.json")),
      harnessProfileSchema.parse(fixture("harness-profile.valid.json")),
      runConfigSchema.parse(fixture("run-config.valid.json")),
    ];
    expect(values).toHaveLength(8);
  });
});
