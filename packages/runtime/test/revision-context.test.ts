import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { planIRSchema, type PlanIR } from "@arbitra/schemas/plan.js";
import type { PlanRevisionPatch } from "@arbitra/schemas/plan-revision-patch.js";
import type { CanonicalIssue } from "@arbitra/workflow/nodes/canonical-issues.js";
import { reviseWithContext, type ModelRevisionInput } from "../src/revision-context.js";
import type { PlannerStage } from "../src/planner-context.js";

async function fixture() {
  const plan = planIRSchema.parse(JSON.parse(await readFile(new URL("../../schemas/test/golden/plan-ir.valid.json", import.meta.url), "utf8")));
  const task = plan.tasks[0]; if (task === undefined) throw new Error("FIXTURE_TASK_ABSENT");
  plan.tasks.push({ ...task, id: "TASK-002", implementationGuidance: ["Unchanged detailed task body"] });
  plan.routingRecommendations.push({ ...requiredAt(plan.routingRecommendations, 0), taskId: "TASK-002" });
  const issue: CanonicalIssue = { candidateId: "C-001", claim: { trust: "untrusted_data", title: "Original issue", description: "Complete original description" }, severity: "high", blocker: false, disposition: "accepted", consensusClaim: null, supportCount: 2, reviewDenominator: 3, dissent: [], counterEvidence: [], sourceFindingIds: ["source-1"], verificationOutcome: "CONFIRMED", coverage: { reviewedBy: [], missingReviewers: [] }, singleSource: false };
  const input: ModelRevisionInput = { originalPlan: plan, originalGoal: "Fix accepted issue", plannerConfiguration: { modelProfileId: "planner" }, canonicalIssues: [issue], repository: [],
    blockingCritique: [{ id: "critique-1", category: "weak_verification", blocking: true, summary: "Replace task and strengthen tests", taskIds: ["TASK-001"], issueIds: [] }, { id: "critique-2", category: "weak_acceptance_criteria", blocking: true, summary: "Improve replacement acceptance", taskIds: ["TASK-001"], issueIds: [] }],
  };
  const calls: PlannerStage[] = []; const artifacts = new Map<string, unknown>();
  const port = {
    async fits(stage: PlannerStage) { return stage.activityId !== "planner/revision"; },
    async call(stage: PlannerStage): Promise<unknown> {
      calls.push(stage);
      if (stage.activityId === "planner/revision") return { plan, resolutions: input.blockingCritique.map(({ id }) => ({ critiqueItemId: id, resolution: "Resolved" })) };
      const supplied = stage.input as { selectedTasks: PlanIR["tasks"]; globalPlan: Omit<PlanIR, "tasks">; critique: { id: string } };
      const selected = supplied.selectedTasks[0]; if (selected === undefined) throw new Error("SELECTED_TASK_ABSENT");
      const newId = supplied.critique.id === "critique-1" ? "TASK-003" : selected.id;
      const patch: PlanRevisionPatch = { critiqueItemId: supplied.critique.id, resolution: "Concrete revision", globalPlan: { ...supplied.globalPlan, routingRecommendations: supplied.globalPlan.routingRecommendations.map((routing) => ({ ...routing, taskId: routing.taskId === selected.id ? newId : routing.taskId })) },
        tasks: [{ ...selected, id: newId, acceptanceCriteria: ["Acceptance after concrete revision"] }], retiredTaskIds: newId === selected.id ? [] : [selected.id], lineage: [{ previousTaskId: selected.id, nextTaskIds: [newId], rationale: "Replacement keeps the original responsibility" }],
      };
      return patch;
    },
    async publish(kind: string, value: unknown) { artifacts.set(kind, structuredClone(value)); },
  };
  return { input, port, calls, artifacts };
}

describe("bounded atomic planner revisions", () => {
  it("includes dependency neighbors so replacement can update reciprocal references atomically", async () => {
    const { input, port } = await fixture();
    requiredAt(input.originalPlan.tasks, 1).dependencies = { dependsOn: ["TASK-001"], blocks: [], conflictsWith: [] };
    input.originalPlan.taskGraph = [{ from: "TASK-001", to: "TASK-002" }];
    const result = await reviseWithContext({ ...input, blockingCritique: input.blockingCritique.slice(0, 1) }, { ...port, call: async (stage) => {
      const supplied = stage.input as { selectedTasks: PlanIR["tasks"]; globalPlan: Omit<PlanIR, "tasks">; critique: { id: string } };
      expect(supplied.selectedTasks.map(({ id }) => id)).toEqual(["TASK-001", "TASK-002"]);
      return { critiqueItemId: supplied.critique.id, resolution: "Replaced predecessor and updated its dependent", globalPlan: { ...supplied.globalPlan, taskGraph: [{ from: "TASK-003", to: "TASK-002" }], routingRecommendations: supplied.globalPlan.routingRecommendations.map((routing) => ({ ...routing, taskId: routing.taskId === "TASK-001" ? "TASK-003" : routing.taskId })) },
        tasks: supplied.selectedTasks.map((task) => ({ ...task, id: task.id === "TASK-001" ? "TASK-003" : task.id, dependencies: { ...task.dependencies, dependsOn: task.dependencies.dependsOn.map((id) => id === "TASK-001" ? "TASK-003" : id) } })), retiredTaskIds: ["TASK-001"],
        lineage: [{ previousTaskId: "TASK-001", nextTaskIds: ["TASK-003"], rationale: "Replacement" }, { previousTaskId: "TASK-002", nextTaskIds: ["TASK-002"], rationale: "Updated dependency" }],
      };
    } });
    expect(result.plan.tasks.find(({ id }) => id === "TASK-002")?.dependencies.dependsOn).toEqual(["TASK-003"]);
    expect(result.plan.taskGraph).toEqual([{ from: "TASK-003", to: "TASK-002" }]);
  });

  it("preserves the original body for a later critique after retirement and tracks reintroduced work", async () => {
    const { input, port, artifacts } = await fixture();
    const result = await reviseWithContext(input, { ...port, call: async (stage) => {
      const supplied = stage.input as { selectedTasks: PlanIR["tasks"]; retiredOriginalTasks: PlanIR["tasks"]; globalPlan: Omit<PlanIR, "tasks">; critique: { id: string } };
      if (supplied.critique.id === "critique-1") return { critiqueItemId: "critique-1", resolution: "Removed redundant task", globalPlan: { ...supplied.globalPlan, routingRecommendations: supplied.globalPlan.routingRecommendations.filter(({ taskId }) => taskId !== "TASK-001") }, tasks: [], retiredTaskIds: ["TASK-001"], lineage: [{ previousTaskId: "TASK-001", nextTaskIds: [], rationale: "Other task covers the accepted issue" }] };
      expect(supplied.selectedTasks).toEqual([]); expect(supplied.retiredOriginalTasks).toEqual([input.originalPlan.tasks[0]]);
      expect(stage.input).toMatchObject({ canonicalIssues: input.canonicalIssues });
      const original = requiredAt(input.originalPlan.tasks, 0);
      return { critiqueItemId: "critique-2", resolution: "Reintroduced the omitted acceptance responsibility", globalPlan: { ...supplied.globalPlan, routingRecommendations: [...supplied.globalPlan.routingRecommendations, { taskId: "TASK-003", capability: original.routing.capability, effort: original.routing.effort, reason: original.routing.reason }] }, tasks: [{ ...original, id: "TASK-003" }], retiredTaskIds: [], lineage: [{ previousTaskId: "TASK-001", nextTaskIds: ["TASK-003"], rationale: "Reintroduced responsibility" }] };
    } });
    expect(result.plan.tasks.map(({ id }) => id)).toEqual(["TASK-002", "TASK-003"]);
    expect(artifacts.get("planner-revision-composition")).toMatchObject({ originalTaskLineage: { "TASK-001": ["TASK-003"] } });
  });

  it("preserves unchanged tasks, complete selected inputs and original critique lineage after replacement", async () => {
    const { input, port, calls, artifacts } = await fixture();
    const result = await reviseWithContext(input, port);
    expect(result.plan.tasks.find(({ id }) => id === "TASK-002")).toEqual(input.originalPlan.tasks[1]);
    expect(result.plan.tasks.find(({ id }) => id === "TASK-001")).toBeUndefined();
    expect(result.plan.tasks.find(({ id }) => id === "TASK-003")?.acceptanceCriteria).toEqual(["Acceptance after concrete revision"]);
    expect(result.resolutions.map(({ critiqueItemId }) => critiqueItemId)).toEqual(["critique-1", "critique-2"]);
    expect(calls[0]?.input).toMatchObject({ selectedTasks: [input.originalPlan.tasks[0]], canonicalIssues: input.canonicalIssues });
    expect(calls[1]?.input).toMatchObject({ selectedTasks: [{ id: "TASK-003" }], originalTaskLineage: { "TASK-001": ["TASK-003"] }, critique: input.blockingCritique[1], priorResolutions: [{ critiqueItemId: "critique-1" }] });
    expect(artifacts.get("planner-revision-composition")).toMatchObject({ logicalModelCalls: 2, originalTaskLineage: { "TASK-001": ["TASK-003"] } });
  });

  it("uses the original complete-plan revision when it fits", async () => {
    const { input, port, calls } = await fixture();
    const result = await reviseWithContext(input, { ...port, fits: async () => true });
    expect(result.plan).toEqual(input.originalPlan); expect(calls.map(({ activityId }) => activityId)).toEqual(["planner/revision"]);
  });

  it.each(["wrong_critique", "unselected_task", "missing_lineage", "unknown_lineage", "questions", "provenance", "coverage", "self_resolution"])("rejects an invalid atomic patch: %s", async (mode) => {
    const { input, port, calls } = await fixture();
    const expected = { wrong_critique: "REVISION_PATCH_CRITIQUE_MISMATCH", unselected_task: "REVISION_PATCH_TASK_SCOPE_INVALID", missing_lineage: "REVISION_PATCH_LINEAGE_INCOMPLETE", unknown_lineage: "REVISION_PATCH_LINEAGE_INVALID", questions: "REVISION_PATCH_QUESTION_DROPPED", provenance: "MODEL_REVISION_PROVENANCE_MISMATCH", coverage: "MODEL_REVISION_TRACEABILITY_INVALID", self_resolution: "HIGH_BLAST_RADIUS_QUESTION_SILENTLY_RESOLVED" };
    await expect(reviseWithContext(input, { ...port, call: async (stage) => {
      const patch = await port.call(stage) as PlanRevisionPatch;
      if (mode === "wrong_critique") patch.critiqueItemId = "different";
      if (mode === "unselected_task") patch.tasks.push(requiredAt(input.originalPlan.tasks, 1));
      if (mode === "missing_lineage") patch.lineage = [];
      if (mode === "unknown_lineage") requiredAt(patch.lineage, 0).nextTaskIds = ["TASK-999"];
      if (mode === "questions") patch.globalPlan.unresolvedQuestions = [];
      if (mode === "provenance") patch.globalPlan.premiseReport = { ...patch.globalPlan.premiseReport, status: "unavailable" };
      if (mode === "coverage") patch.globalPlan.acceptedIssueIds = [];
      if (mode === "self_resolution") { patch.globalPlan.unresolvedQuestions = [...patch.globalPlan.unresolvedQuestions, { id: "new", question: "Need a decision", blocking: true, blastRadius: "high" }]; requiredAt(patch.tasks, 0).context = ["resolves:new"]; }
      return patch;
    } })).rejects.toThrow(expected[mode as keyof typeof expected]);
    expect(calls).toHaveLength(1);
  });

  it("rejects missing complete-plan resolutions before accepting the one-call result", async () => {
    const { input, port } = await fixture();
    await expect(reviseWithContext(input, { ...port, fits: async () => true, call: async () => ({ plan: input.originalPlan, resolutions: [] }) })).rejects.toThrow("REVISION_DID_NOT_RESOLVE_EVERY_BLOCKING_CRITIQUE_ITEM");
  });

  it("fails explicitly when a single critique and its selected records cannot fit", async () => {
    const { input, port, calls } = await fixture();
    await expect(reviseWithContext(input, { ...port, fits: async () => false })).rejects.toThrow("PLANNER_REVISION_ITEM_CONTEXT_LIMIT_EXCEEDED");
    expect(calls).toHaveLength(0);
  });
});

function requiredAt<T>(values: readonly T[], index: number): T { const value = values[index]; if (value === undefined) throw new Error('FIXTURE_RECORD_ABSENT'); return value; }
