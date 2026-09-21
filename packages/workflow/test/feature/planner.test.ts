import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { planIRSchema } from "@arbitra/schemas/plan.js";
import { featurePlannerNode, validateFeaturePlanTraceability, type RequirementsContract } from "../../src/nodes/requirements/index.js";

const requirements: RequirementsContract = { schemaVersion: 1, featureRequest: "Feature", assumptions: [{ id: "ASM", statement: "Keep compatibility", confidence: "high" }], ambiguities: [], acceptance: [{ id: "ACC", assertion: "Feature works" }], outOfScope: [], decision: { mode: "automatic", acceptedDefaults: [] } };
function plan() {
  const value = planIRSchema.parse(JSON.parse(readFileSync(new URL("../../../schemas/test/golden/plan-ir.valid.json", import.meta.url), "utf8")));
  value.mode = "feature"; value.acceptedIssueIds = []; value.traceability.issueToValidation = [];
  for (const task of value.tasks) { task.addresses.issues = []; task.addresses.requirements = ["ACC"]; }
  value.traceability.requirementLinks.links = [{ requirementId: "ACC", taskIds: ["TASK-001"], validationIds: ["VAL-001"] }];
  return value;
}

describe("Feature planner requirements coverage", () => {
  it("passes the approved contract to planning and validates the resulting links", async () => {
    const output = plan();
    const node = featurePlannerNode({ protocolVersion: "1.0.0", protocolHash: "a".repeat(64), schema: planIRSchema, runtime: { async plan(request) {
      expect(request.input.projectContext).toMatchObject({ requirements }); return output;
    } } });
    expect((await node.run({ requirements, projectContext: {}, canonicalIssues: [], repositoryContext: [], constraints: [], workflowGoal: "Feature", premiseReport: output.premiseReport })).plan).toEqual(output);
  });

  it("rejects omitted acceptance, invented requirements and links unrelated to implementing tasks", () => {
    const missing = plan(); missing.traceability.requirementLinks.links = [];
    expect(validateFeaturePlanTraceability(requirements, missing).length).toBeGreaterThan(0);
    const invented = plan(); const task = invented.tasks[0];
    if (task === undefined) throw new Error("TASK_ABSENT");
    task.addresses.requirements = ["INVENTED"];
    expect(validateFeaturePlanTraceability(requirements, invented).length).toBeGreaterThan(0);
    const detached = plan(); detached.validationContract.validation.push({ id: "VAL-OTHER", assertion: "Other", evidence: ["test"] });
    const link = detached.traceability.requirementLinks.links[0];
    if (link === undefined) throw new Error("LINK_ABSENT");
    link.validationIds = ["VAL-OTHER"];
    expect(validateFeaturePlanTraceability(requirements, detached).length).toBeGreaterThan(0);
    const wrongMode = plan(); wrongMode.mode = "audit";
    expect(validateFeaturePlanTraceability(requirements, wrongMode).length).toBeGreaterThan(0);
  });

  it("does not call the planner while high-impact defaults remain unresolved", async () => {
    const output = plan(); let called = false;
    const node = featurePlannerNode({ protocolVersion: "1.0.0", protocolHash: "a".repeat(64), schema: planIRSchema, runtime: { async plan() { called = true; return output; } } });
    const unresolved: RequirementsContract = { ...requirements, decision: { mode: "interactive", acceptedDefaults: [] }, ambiguities: [{ id: "AMB", question: "Migrate?", proposedDefault: "Keep old", blastRadius: "high" }] };
    await expect(node.run({ requirements: unresolved, projectContext: {}, canonicalIssues: [], repositoryContext: [], constraints: [], workflowGoal: "Feature", premiseReport: output.premiseReport })).rejects.toThrow("FEATURE_REQUIREMENTS_CHECKPOINT_UNRESOLVED");
    expect(called).toBe(false);
  });
});
