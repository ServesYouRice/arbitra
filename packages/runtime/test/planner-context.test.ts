import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { planIRSchema, type PlanIR } from "@arbitra/schemas/plan.js";
import type { PlannerBrief, PlannerOutline } from "@arbitra/schemas/planner-composition.js";
import type { PlannerInput } from "@arbitra/workflow/nodes/planner/node.js";
import { planWithContext, taskOutline, type PlannerStage } from "../src/planner-context.js";

async function fixture() {
  const template = planIRSchema.parse(JSON.parse(await readFile(new URL("../../schemas/test/golden/plan-ir.valid.json", import.meta.url), "utf8")));
  const originalTask = template.tasks[0]; if (originalTask === undefined) throw new Error("FIXTURE_TASK_ABSENT");
  const issues: PlannerInput["canonicalIssues"] = [1, 2, 3].map((index) => ({ candidateId: `C-${index}`, disposition: "accepted", sourceFindingIds: [`source-${index}`], claim: { trust: "untrusted_data", title: `Issue ${index}`, description: `Exact original issue ${index}: ` + "Important source context. ".repeat(250) } }));
  const input: PlannerInput = { projectContext: { unresolvedPeerOperations: ["preserve conflict"] }, canonicalIssues: issues, repositoryContext: [{ ref: "source.ts", content: "original repository", trust: "repo" }], constraints: ["read_only"], workflowGoal: "Fix accepted issues", premiseReport: template.premiseReport };
  const tasks = issues.map(({ candidateId }, index) => ({ ...originalTask, id: `TASK-${index + 1}`, addresses: { ...originalTask.addresses, issues: [candidateId] }, dependencies: { dependsOn: index > 0 ? [`TASK-${index}`] : [], blocks: [], conflictsWith: [] } }));
  const plan: PlanIR = { ...template, acceptedIssueIds: issues.map(({ candidateId }) => candidateId), tasks, taskGraph: [{ from: "TASK-1", to: "TASK-2" }, { from: "TASK-2", to: "TASK-3" }],
    traceability: { ...template.traceability, issueToValidation: issues.map(({ candidateId }) => ({ issueId: candidateId, validationIds: ["VAL-001"] })) },
    routingRecommendations: tasks.map(({ id, routing }) => ({ taskId: id, capability: routing.capability, effort: routing.effort, reason: routing.reason })),
  };
  const calls: PlannerStage[] = []; const artifacts = new Map<string, unknown>();
  const port = {
    async fits(stage: PlannerStage) { return stage.activityId !== "planner/plan" && (!stage.activityId.startsWith("planner/brief/") || (stage.input as PlannerInput).canonicalIssues.length <= 1); },
    async call(stage: PlannerStage): Promise<unknown> {
      calls.push(stage);
      if (stage.activityId === "planner/plan") return plan;
      if (stage.activityId.startsWith("planner/brief/")) return { issues: (stage.input as PlannerInput).canonicalIssues.map(({ candidateId }) => ({ issueId: candidateId, summary: `Brief ${candidateId}`, affectedPaths: ["source.ts"], behavioralAssertions: ["Expected behavior"], integrationConstraints: ["Shared authorization boundary"], unresolvedQuestions: [{ id: "Q-1", question: `Clarify ${candidateId}`, blocking: true, blastRadius: "high" }] })) };
      if (stage.activityId === "planner/outline") {
        const briefs = (stage.input as { issueBriefs: PlannerBrief["issues"] }).issueBriefs;
        return { ...plan, tasks: tasks.map(taskOutline), unresolvedQuestions: briefs.flatMap(({ unresolvedQuestions }) => unresolvedQuestions) };
      }
      const id = (stage.input as { selectedTask: { id: string } }).selectedTask.id;
      return { task: tasks.find((task) => task.id === id), unresolvedQuestions: [] };
    },
    async publish(kind: string, value: unknown) { artifacts.set(kind, value); },
  };
  return { plan, input, calls, artifacts, port };
}

describe("one global planner with bounded issue reading and task expansion", () => {
  it("retains complete issues and globally planned dependencies while namespacing local questions", async () => {
    const { plan, input, calls, artifacts, port } = await fixture();
    const result = await planWithContext(input, port);
    expect(calls).toHaveLength(7);
    expect(calls[3]?.activityId).toBe("planner/outline");
    expect(result.tasks).toEqual(plan.tasks); expect(result.taskGraph).toEqual(plan.taskGraph);
    expect(result.acceptedIssueIds).toEqual(["C-1", "C-2", "C-3"]);
    expect(new Set(result.unresolvedQuestions.map(({ id }) => id)).size).toBe(3);
    const originalReads = calls.filter(({ activityId }) => activityId.startsWith("planner/brief/") || activityId.startsWith("planner/expand/"));
    for (const issue of input.canonicalIssues) expect(originalReads.filter(({ input: supplied }) => (supplied as PlannerInput).canonicalIssues.some((record) => JSON.stringify(record) === JSON.stringify(issue)))).toHaveLength(2);
    for (const { input: supplied } of originalReads) expect(supplied).toMatchObject({ projectContext: input.projectContext, constraints: input.constraints, repositoryContext: input.repositoryContext });
    expect(artifacts.get("planner-composition")).toMatchObject({ issueBatches: 3, taskExpansions: 3, logicalModelCalls: 7 });
  });

  it("preserves the original one-call activity when all mandatory input fits", async () => {
    const { plan, input, port, calls } = await fixture();
    expect(await planWithContext(input, { ...port, fits: async () => true })).toEqual(plan);
    expect(calls.map(({ activityId }) => activityId)).toEqual(["planner/plan"]);
  });

  it.each(["missing", "duplicate", "unknown"])("rejects %s issue briefs before global planning", async (mode) => {
    const { input, port, calls } = await fixture();
    await expect(planWithContext(input, { ...port, call: async (stage) => {
      const output = await port.call(stage) as PlannerBrief;
      if (stage.activityId.startsWith("planner/brief/")) {
        if (mode === "missing") output.issues = [];
        if (mode === "duplicate") output.issues.push(...output.issues);
        if (mode === "unknown" && output.issues[0]) output.issues[0].issueId = "unknown";
      }
      return output;
    } })).rejects.toThrow("PLANNER_BRIEF_ISSUE_SET_MISMATCH");
    expect(calls.some(({ activityId }) => activityId === "planner/outline")).toBe(false);
  });

  it.each(["questions", "coverage", "cycle", "provenance"])("rejects invalid global %s before task expansion", async (mode) => {
    const { input, port, calls } = await fixture();
    await expect(planWithContext(input, { ...port, call: async (stage) => {
      const output = await port.call(stage) as PlannerOutline;
      if (stage.activityId === "planner/outline") {
        if (mode === "questions") output.unresolvedQuestions = [];
        if (mode === "coverage") output.acceptedIssueIds = [];
        if (mode === "cycle" && output.tasks[0]) { output.tasks[0].dependencies.dependsOn = ["TASK-3"]; output.taskGraph.push({ from: "TASK-3", to: "TASK-1" }); }
        if (mode === "provenance") output.premiseReport = { ...output.premiseReport, status: "unavailable" };
      }
      return output;
    } })).rejects.toThrow(mode === "questions" ? "PLANNER_OUTLINE_QUESTION_DROPPED" : mode === "provenance" ? "MODEL_PLAN_PROVENANCE_MISMATCH" : "PLANNER_OUTLINE_TRACEABILITY_INVALID");
    expect(calls.some(({ activityId }) => activityId.startsWith("planner/expand/"))).toBe(false);
  });

  it("rejects expansion changes to globally assigned scope and issue ownership", async () => {
    const { input, port } = await fixture();
    await expect(planWithContext(input, { ...port, call: async (stage) => {
      const output = await port.call(stage);
      if (stage.activityId.startsWith("planner/expand/")) (output as { task: PlanIR["tasks"][number] }).task.scope.likelyFiles = ["unexpected.ts"];
      return output;
    } })).rejects.toThrow("PLANNER_TASK_OUTLINE_CHANGED");
  });

  it("rejects silent resolution of new blocking questions after question IDs are scoped", async () => {
    const { input, port } = await fixture();
    await expect(planWithContext(input, { ...port, call: async (stage) => {
      const output = await port.call(stage);
      if (stage.activityId.startsWith("planner/expand/")) {
        const result = output as { task: PlanIR["tasks"][number]; unresolvedQuestions: PlanIR["unresolvedQuestions"] };
        result.unresolvedQuestions = [{ id: "local", question: "Missing requirement", blocking: true, blastRadius: "high" }];
        result.task.context = ["resolves:local"];
      }
      return output;
    } })).rejects.toThrow("HIGH_BLAST_RADIUS_QUESTION_SILENTLY_RESOLVED");
  });

  it.each(["brief", "outline", "expand"])("fails explicitly for individually oversized %s context", async (phase) => {
    const { input, port, calls } = await fixture();
    await expect(planWithContext(input, { ...port, fits: async (stage) => !stage.activityId.startsWith(`planner/${phase}`) && await port.fits(stage) })).rejects.toThrow("CONTEXT_LIMIT_EXCEEDED");
    expect(calls.some(({ activityId }) => activityId.startsWith(`planner/${phase}`))).toBe(false);
  });
});
