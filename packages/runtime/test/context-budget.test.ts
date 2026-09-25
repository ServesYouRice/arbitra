import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { planIRSchema, type PlanIR } from "@arbitra/schemas/plan.js";
import type { PlannerInput } from "@arbitra/workflow/nodes/planner/node.js";
import { ModelOutputLimitError, isCapacityError, outputRecordLimit, replanOnOutputLimit } from "../src/context-budget.js";
import { peerReviewBatches } from "../src/peer-review-batches.js";
import { planWithContext, taskOutline, type PlannerStage } from "../src/planner-context.js";

describe("output capacity accounting", () => {
  it("sizes per-record batches from the output allowance and fails explicitly when one record cannot fit", async () => {
    expect(outputRecordLimit(2_000, 160, "peer-review")).toBe(12);
    expect(() => outputRecordLimit(100, 160, "peer-review")).toThrow("MODEL_OUTPUT_CAPACITY_INSUFFICIENT:peer-review:100<160");
    // Input would admit every candidate; output capacity still splits the review.
    const ids = Array.from({ length: 7 }, (_, index) => `c${index}`);
    const batches = await peerReviewBatches(ids, async () => true, outputRecordLimit(480, 160, "peer-review"));
    expect(batches.filter(({ kind }) => kind === "review").map(({ candidateIds }) => candidateIds)).toEqual([["c0", "c1", "c2"], ["c3", "c4", "c5"], ["c6"]]);
    for (const left of ids) for (const right of ids) expect(batches.some(({ candidateIds }) => candidateIds.includes(left) && candidateIds.includes(right))).toBe(true);
    expect(isCapacityError(new ModelOutputLimitError("x"))).toBe(true);
    expect(isCapacityError(new Error("MODEL_REQUIRED_CONTEXT_LIMIT_EXCEEDED"))).toBe(true);
    expect(isCapacityError(new Error("OTHER"))).toBe(false);
  });

  it("replans after an output-limited activity without repeating completed or retired calls", async () => {
    const template = planIRSchema.parse(JSON.parse(await readFile(new URL("../../schemas/test/golden/plan-ir.valid.json", import.meta.url), "utf8")));
    const baseTask = template.tasks[0]; if (baseTask === undefined) throw new Error("FIXTURE_TASK_ABSENT");
    const issues: PlannerInput["canonicalIssues"] = [1, 2, 3, 4].map((index) => ({ candidateId: `C-${index}`, disposition: "accepted", sourceFindingIds: [`s-${index}`], claim: { trust: "untrusted_data", title: `Issue ${index}`, description: `Complete issue ${index}` } }));
    const tasks = issues.map(({ candidateId }, index) => ({ ...baseTask, id: `TASK-${index + 1}`, addresses: { ...baseTask.addresses, issues: [candidateId] } }));
    const plan: PlanIR = { ...template, acceptedIssueIds: issues.map(({ candidateId }) => candidateId), tasks, taskGraph: [],
      traceability: { ...template.traceability, issueToValidation: issues.map(({ candidateId }) => ({ issueId: candidateId, validationIds: ["VAL-001"] })) },
      routingRecommendations: tasks.map(({ id, routing }) => ({ taskId: id, capability: routing.capability, effort: routing.effort, reason: routing.reason })) };
    const input: PlannerInput = { projectContext: {}, canonicalIssues: issues, repositoryContext: [], constraints: [], workflowGoal: "Fix", premiseReport: template.premiseReport };
    // A durable activity cache and output-limit ledger, as provided by ModelActivities/ModelHarness.
    const durable = new Map<string, unknown>(); const limited = new Set<string>(); const spent: string[] = [];
    const respond = (stage: PlannerStage): unknown => {
      if (stage.activityId === "planner/plan" || (stage.activityId.startsWith("planner/brief/") && (stage.input as PlannerInput).canonicalIssues.length > 2)) throw new ModelOutputLimitError(stage.activityId);
      if (stage.activityId.startsWith("planner/brief/")) return { issues: (stage.input as PlannerInput).canonicalIssues.map(({ candidateId }) => ({ issueId: candidateId, summary: "Brief", affectedPaths: [], behavioralAssertions: ["Holds"], integrationConstraints: [], unresolvedQuestions: [] })) };
      if (stage.activityId === "planner/outline") return { ...plan, tasks: tasks.map(taskOutline) };
      return { task: tasks.find(({ id }) => id === (stage.input as { selectedTask: { id: string } }).selectedTask.id), unresolvedQuestions: [] };
    };
    const port = {
      async fits(stage: PlannerStage) { return !limited.has(stage.activityId); },
      async call(stage: PlannerStage) {
        if (limited.has(stage.activityId)) throw new ModelOutputLimitError(stage.activityId);
        if (durable.has(stage.activityId)) return durable.get(stage.activityId);
        spent.push(stage.activityId);
        try { const value = respond(stage); durable.set(stage.activityId, value); return value; }
        catch (error) { if (error instanceof ModelOutputLimitError) limited.add(error.activityId); throw error; }
      },
      async publish() { return undefined; },
    };
    const result = await replanOnOutputLimit(() => planWithContext(input, port, { maximumBriefRecords: 3 }));
    expect(result.acceptedIssueIds).toEqual(["C-1", "C-2", "C-3", "C-4"]);
    expect(result.tasks.map(({ id }) => id)).toEqual(["TASK-1", "TASK-2", "TASK-3", "TASK-4"]);
    expect(new Set(spent).size).toBe(spent.length);
    expect(spent[0]).toBe("planner/plan");
    // One three-issue brief exceeded output capacity; two two-issue briefs replaced it.
    expect(spent.filter((id) => id.startsWith("planner/brief/"))).toHaveLength(3);
    expect([...limited]).toHaveLength(2);
    // A resumed composition with the same ledger spends nothing further.
    const before = spent.length;
    expect(await replanOnOutputLimit(() => planWithContext(input, port, { maximumBriefRecords: 3 }))).toEqual(result);
    expect(spent).toHaveLength(before);
  });

  it("does not loop when a retired activity is requested again", async () => {
    let calls = 0;
    await expect(replanOnOutputLimit(async () => { calls += 1; throw new ModelOutputLimitError("same"); })).rejects.toThrow("MODEL_OUTPUT_LIMIT_REACHED:same");
    expect(calls).toBe(2);
  });
});
