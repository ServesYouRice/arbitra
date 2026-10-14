import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { planIRSchema, type PlanIR } from "@arbitra/schemas/plan.js";
import type { PlanRevisionPatch } from "@arbitra/schemas/plan-revision-patch.js";
import type { CanonicalIssue } from "@arbitra/workflow/nodes/canonical-issues.js";
import { reviseWithContext, type ModelRevisionInput } from "../src/revision-context.js";
import type { PlannerStage } from "../src/planner-context.js";

type Supplied = { selectedTasks: PlanIR["tasks"]; selectedTaskIds: string[]; retiredOriginalTasks: PlanIR["tasks"]; critique: { id: string }[]; taskIndex: { id: string }[];
  unresolvedQuestions: PlanIR["unresolvedQuestions"]; validation: { id: string }[]; nextValidationId: string; planHeader: Record<string, unknown> };
const none = { implementationStrategy: [], dependencies: [], rolloutConcerns: [], migrationConcerns: [] };
/** A patch that answers every item of a call and changes nothing. */
function unchanged(supplied: Supplied, extra: Partial<PlanRevisionPatch> = {}): PlanRevisionPatch {
  return { resolutions: supplied.critique.map(({ id }) => ({ critiqueItemId: id, resolution: "Concrete revision" })), tasks: [], retiredTaskIds: [],
    lineage: supplied.selectedTaskIds.map((id) => ({ previousTaskId: id, nextTaskIds: supplied.selectedTasks.some((task) => task.id === id) ? [id] : [], rationale: "Kept" })),
    addedQuestions: [], addedValidation: [], issueToValidation: [], requirementLinks: [], planAdditions: none, ...extra };
}

async function fixture() {
  const plan = planIRSchema.parse(JSON.parse(await readFile(new URL("../../schemas/test/golden/plan-ir.valid.json", import.meta.url), "utf8")));
  const task = requiredAt(plan.tasks, 0);
  plan.tasks.push({ ...task, id: "TASK-002", scope: { ...task.scope, likelyFiles: task.scope.likelyFiles.map((path) => `other/${path}`) }, readFirst: [], implementationGuidance: ["Unchanged detailed task body"] });
  plan.routingRecommendations.push({ ...requiredAt(plan.routingRecommendations, 0), taskId: "TASK-002" });
  const issue: CanonicalIssue = { candidateId: "C-001", claim: { trust: "untrusted_data", title: "Original issue", description: "Complete original description" }, severity: "high", blocker: false, disposition: "accepted", consensusClaim: null, supportCount: 2, reviewDenominator: 3, dissent: [], counterEvidence: [], sourceFindingIds: ["source-1"], verificationOutcome: "CONFIRMED", coverage: { reviewedBy: [], missingReviewers: [] }, singleSource: false };
  const input: { -readonly [K in keyof ModelRevisionInput]: ModelRevisionInput[K] } = { originalPlan: plan, originalGoal: "Fix accepted issue", plannerConfiguration: { modelProfileId: "planner" }, canonicalIssues: [issue], repository: [],
    blockingCritique: [{ id: "critique-1", category: "weak_verification", blocking: true, summary: "Replace task and strengthen tests", taskIds: ["TASK-001"], issueIds: [] }, { id: "critique-2", category: "weak_acceptance_criteria", blocking: true, summary: "Improve replacement acceptance", taskIds: ["TASK-001"], issueIds: [] }],
  };
  const calls: PlannerStage[] = []; const artifacts = new Map<string, unknown>();
  const port = {
    async fits(stage: PlannerStage) { return stage.activityId !== "planner/revision"; },
    async call(stage: PlannerStage): Promise<unknown> {
      calls.push(stage);
      if (stage.activityId === "planner/revision") return { plan, resolutions: input.blockingCritique.map(({ id }) => ({ critiqueItemId: id, resolution: "Resolved" })) };
      const supplied = stage.input as Supplied;
      const selected = supplied.selectedTasks.find(({ id }) => id === "TASK-001"); if (selected === undefined) throw new Error("SELECTED_TASK_ABSENT");
      // Replaces TASK-001 with a new task under a local name.
      return unchanged(supplied, { tasks: [{ ...selected, id: "TASK-900", acceptanceCriteria: ["Acceptance after concrete revision"] }], retiredTaskIds: ["TASK-001"],
        lineage: supplied.selectedTaskIds.map((id) => ({ previousTaskId: id, nextTaskIds: id === "TASK-001" ? ["TASK-900"] : [id], rationale: "Replacement keeps the original responsibility" })) });
    },
    async publish(kind: string, value: unknown) { artifacts.set(kind, structuredClone(value)); },
  };
  return { input, port, calls, artifacts };
}

describe("planner revision in parts", () => {
  it("answers the items on one task in one call that reads that task, not its neighbours, and writes only what it changes", async () => {
    const { input, port, calls, artifacts } = await fixture();
    requiredAt(input.originalPlan.tasks, 1).dependencies = { dependsOn: ["TASK-001"], blocks: [], conflictsWith: [] };
    input.originalPlan.taskGraph = [{ from: "TASK-001", to: "TASK-002" }];
    const result = await reviseWithContext(input, port);
    expect(calls).toHaveLength(1);
    const supplied = requiredAt(calls, 0).input as Supplied;
    expect(supplied.critique.map(({ id }) => id)).toEqual(["critique-1", "critique-2"]);
    expect(supplied.selectedTasks.map(({ id }) => id)).toEqual(["TASK-001"]);
    expect(supplied.taskIndex.map(({ id }) => id)).toEqual(["TASK-001", "TASK-002"]);
    expect(supplied.planHeader).not.toHaveProperty("unresolvedQuestions"); expect(supplied.planHeader).not.toHaveProperty("tasks");
    expect(requiredAt(calls, 0).sourcePaths).toEqual(["src/auth.ts", "test/auth.test.ts"]);
    // The new task is renumbered into the call's own range; the dependent's reference and the graph follow it.
    expect(result.plan.tasks.map(({ id }) => id)).toEqual(["TASK-002", "TASK-003"]);
    expect(result.plan.tasks.find(({ id }) => id === "TASK-002")).toEqual({ ...requiredAt(input.originalPlan.tasks, 1), dependencies: { dependsOn: ["TASK-003"], blocks: [], conflictsWith: [] } });
    expect(result.plan.taskGraph).toEqual([{ from: "TASK-003", to: "TASK-002" }]);
    expect(result.plan.routingRecommendations.map(({ taskId }) => taskId)).toEqual(["TASK-002", "TASK-003"]);
    expect(result.plan.unresolvedQuestions).toEqual(input.originalPlan.unresolvedQuestions);
    expect(result.resolutions.map(({ critiqueItemId }) => critiqueItemId)).toEqual(["critique-1", "critique-2"]);
    expect(result.resolutions[0]?.resolution).toContain("TASK-003");
    expect(artifacts.get("planner-revision-composition")).toMatchObject({ logicalModelCalls: 1, rounds: 1, originalTaskLineage: { "TASK-001": ["TASK-003"], "TASK-002": ["TASK-002"] }, notRevisedCritiqueItemIds: [] });
  });

  it("tells a call that a critic rechecks its result only when one does", async () => {
    // An Audit rechecks a revised plan only when the run asks for it, and the reviser was promised a recheck regardless.
    const promise = "A separate critic will recheck the result";
    const unchecked = await fixture(); await reviseWithContext(unchecked.input, unchecked.port);
    expect(requiredAt(unchecked.calls, 0).instruction).not.toContain(promise);
    const rechecked = await fixture(); await reviseWithContext(rechecked.input, rechecked.port, undefined, { rechecked: true });
    expect(requiredAt(rechecked.calls, 0).instruction).toContain(promise);
  });

  it("revises disjoint tasks side by side and leaves an item that spans both for the next round", async () => {
    const { input, port, calls } = await fixture();
    input.blockingCritique = [
      { id: "on-1", category: "weak_verification", blocking: true, summary: "Strengthen task 1", taskIds: ["TASK-001"], issueIds: [] },
      { id: "on-2", category: "weak_verification", blocking: true, summary: "Strengthen task 2", taskIds: ["TASK-002"], issueIds: [] },
      { id: "on-both", category: "wrong_dependencies", blocking: true, summary: "Order the two", taskIds: ["TASK-001", "TASK-002"], issueIds: [] },
    ];
    const rounds: string[][] = [];
    const result = await reviseWithContext(input, { ...port,
      together: async <T, R>(items: readonly T[], run: (item: T) => Promise<R>) => { rounds.push(items.map((item) => (item as { stage: PlannerStage }).stage.activityId)); return Promise.all(items.map(run)); },
      call: async (stage: PlannerStage) => {
        calls.push(stage); const supplied = stage.input as Supplied;
        if (supplied.critique.some(({ id }) => id === "on-both")) {
          // The second round reads what the first wrote.
          expect(supplied.selectedTasks.map(({ acceptanceCriteria }) => acceptanceCriteria.at(-1))).toEqual(["Strengthened", "Strengthened"]);
          const second = requiredAt(supplied.selectedTasks, 1);
          return unchanged(supplied, { tasks: [{ ...second, dependencies: { ...second.dependencies, dependsOn: ["TASK-001"] } }] });
        }
        return unchanged(supplied, { tasks: supplied.selectedTasks.map((task) => ({ ...task, acceptanceCriteria: [...task.acceptanceCriteria, "Strengthened"] })) });
      } });
    expect(rounds.map((round) => round.length)).toEqual([2, 1]);
    expect(rounds[0]?.every((id) => id.startsWith("planner/revision-batch/1."))).toBe(true);
    expect(result.plan.tasks.find(({ id }) => id === "TASK-002")?.dependencies.dependsOn).toEqual(["TASK-001"]);
    expect(result.plan.taskGraph).toEqual([{ from: "TASK-001", to: "TASK-002" }]);
    expect(result.resolutions.map(({ critiqueItemId }) => critiqueItemId)).toEqual(["on-1", "on-2", "on-both"]);
  });

  it("supplies a retired task's original body to a later item, which can bring its work back", async () => {
    const { input, port, artifacts } = await fixture();
    input.blockingCritique = [requiredAt(input.blockingCritique, 0), { ...requiredAt(input.blockingCritique, 1), taskIds: ["TASK-001", "TASK-002"] }];
    const result = await reviseWithContext(input, { ...port, call: async (stage) => {
      const supplied = stage.input as Supplied;
      if (supplied.critique[0]?.id === "critique-1") return unchanged(supplied, { retiredTaskIds: ["TASK-001"], lineage: [{ previousTaskId: "TASK-001", nextTaskIds: [], rationale: "Other task covers the accepted issue" }] });
      expect(supplied.selectedTaskIds).toEqual(["TASK-001", "TASK-002"]); expect(supplied.selectedTasks.map(({ id }) => id)).toEqual(["TASK-002"]);
      expect(supplied.retiredOriginalTasks).toEqual([input.originalPlan.tasks[0]]);
      expect(stage.input).toMatchObject({ canonicalIssues: input.canonicalIssues });
      return unchanged(supplied, { tasks: [{ ...requiredAt(input.originalPlan.tasks, 0), id: "TASK-901" }], lineage: [{ previousTaskId: "TASK-001", nextTaskIds: ["TASK-901"], rationale: "Reintroduced responsibility" }, { previousTaskId: "TASK-002", nextTaskIds: ["TASK-002"], rationale: "Kept" }] });
    } }, undefined, { maximumItems: 1 });
    expect(result.plan.tasks.map(({ id }) => id)).toEqual(["TASK-002", "TASK-003"]);
    expect(artifacts.get("planner-revision-composition")).toMatchObject({ rounds: 2, originalTaskLineage: { "TASK-001": ["TASK-003"] } });
  });

  it("gives a call the questions and assertions of its tasks only, and renumbers what it adds", async () => {
    const { input, port, calls } = await fixture();
    input.originalPlan.unresolvedQuestions.push({ id: "brief-x/Q-777", question: "Unrelated decision", blocking: false, blastRadius: "low" }, { id: "expansion-TASK-001/Q-1", question: "Scope of the guard", blocking: false, blastRadius: "low" });
    input.blockingCritique = [{ id: "on-1", category: "weak_verification", blocking: true, summary: "Q-001 is unresolved for task 1", taskIds: ["TASK-001"], issueIds: [] }, { id: "on-2", category: "weak_verification", blocking: true, summary: "Strengthen task 2", taskIds: ["TASK-002"], issueIds: [] }];
    const result = await reviseWithContext(input, { ...port, call: async (stage) => {
      calls.push(stage); const supplied = stage.input as Supplied;
      if (supplied.critique[0]?.id === "on-1") expect(supplied.unresolvedQuestions.map(({ id }) => id)).toEqual(["Q-001", "expansion-TASK-001/Q-1"]);
      expect(supplied.validation.map(({ id }) => id)).toEqual(["VAL-001"]); expect(supplied.nextValidationId).toBe("VAL-002");
      const task = requiredAt(supplied.selectedTasks, 0);
      // Both calls of the round name their new assertion VAL-002.
      return unchanged(supplied, { tasks: [{ ...task, addresses: { ...task.addresses, validation: [...task.addresses.validation, "VAL-002"] }, context: ["resolves:Q-new"] }],
        addedValidation: [{ id: "VAL-002", assertion: `Checked by ${task.id}`, evidence: ["test"] }], addedQuestions: [{ id: "Q-new", question: `Open for ${task.id}`, blocking: false, blastRadius: "low" }] });
    } });
    expect(calls).toHaveLength(2);
    expect(result.plan.validationContract.validation.map(({ id, assertion }) => [id, assertion])).toEqual([["VAL-001", "Support headers cannot bypass role enforcement."], ["VAL-002", "Checked by TASK-001"], ["VAL-003", "Checked by TASK-002"]]);
    expect(result.plan.tasks.map(({ addresses }) => addresses.validation)).toEqual([["VAL-001", "VAL-002"], ["VAL-001", "VAL-003"]]);
    expect(result.plan.tasks.map(({ context }) => context)).toEqual([["resolves:revision-1.1/Q-new"], ["resolves:revision-1.2/Q-new"]]);
    expect(result.plan.unresolvedQuestions.slice(-2).map(({ id }) => id)).toEqual(["revision-1.1/Q-new", "revision-1.2/Q-new"]);
  });

  it("uses the original complete-plan revision when it fits", async () => {
    const { input, port, calls } = await fixture();
    const result = await reviseWithContext(input, { ...port, fits: async () => true });
    expect(result.plan).toEqual(input.originalPlan); expect(calls.map(({ activityId }) => activityId)).toEqual(["planner/revision"]);
  });

  it.each(["wrong_critique", "unselected_task", "missing_lineage", "unknown_lineage", "link_scope", "taken_validation", "self_resolution"])("refuses an invalid patch inside the call: %s", async (mode) => {
    const { input, port, calls } = await fixture();
    const expected = { wrong_critique: "REVISION_PATCH_CRITIQUE_MISMATCH", unselected_task: "REVISION_PATCH_TASK_SCOPE_INVALID", missing_lineage: "REVISION_PATCH_LINEAGE_INCOMPLETE", unknown_lineage: "REVISION_PATCH_LINEAGE_INVALID", link_scope: "REVISION_PATCH_LINK_SCOPE_INVALID", taken_validation: "REVISION_PATCH_VALIDATION_ID_TAKEN", self_resolution: "HIGH_BLAST_RADIUS_QUESTION_SILENTLY_RESOLVED" };
    await expect(reviseWithContext(input, { ...port, call: async (stage) => {
      const patch = await port.call(stage) as PlanRevisionPatch;
      if (mode === "wrong_critique") requiredAt(patch.resolutions, 0).critiqueItemId = "different";
      if (mode === "unselected_task") patch.tasks.push(requiredAt(input.originalPlan.tasks, 1));
      if (mode === "missing_lineage") patch.lineage = [];
      if (mode === "unknown_lineage") requiredAt(patch.lineage, 0).nextTaskIds = ["TASK-999"];
      if (mode === "link_scope") patch.issueToValidation = [{ issueId: "C-999", validationIds: ["VAL-001"] }];
      if (mode === "taken_validation") patch.addedValidation = [{ id: "VAL-001", assertion: "Again", evidence: ["test"] }];
      if (mode === "self_resolution") { patch.addedQuestions = [{ id: "new", question: "Need a decision", blocking: true, blastRadius: "high" }]; requiredAt(patch.tasks, 0).context = ["resolves:new"]; }
      return stage.schema.parse(patch);
    } })).rejects.toThrow(expected[mode as keyof typeof expected]);
    expect(calls).toHaveLength(1);
  });

  it("refuses a patch inside the call, so the harness can repair it instead of failing the run", async () => {
    const { input, port } = await fixture();
    const refusals: string[] = [];
    const result = await reviseWithContext(input, { ...port, call: async (stage) => {
      const patch = await port.call(stage) as PlanRevisionPatch;
      // Observed live: a patch added a task that no lineage entry named.
      const unnamed = structuredClone(patch); unnamed.tasks.push({ ...requiredAt(patch.tasks, 0), id: "TASK-901" });
      try { stage.schema.parse(unnamed); } catch (error) { refusals.push(String(error)); }
      return stage.schema.parse(patch);
    } });
    expect(refusals).toEqual([expect.stringContaining("REVISION_NEW_TASK_LINEAGE_ABSENT")]);
    expect(refusals[0]).toContain("unnamed: TASK-901");
    expect(result.plan.tasks.map(({ id }) => id)).toEqual(["TASK-002", "TASK-003"]);
  });

  it("moves a call's references to a task an earlier call of its round retired to that task's successors", async () => {
    const { input, port } = await fixture();
    requiredAt(input.originalPlan.tasks, 1).dependencies = { dependsOn: ["TASK-001"], blocks: [], conflictsWith: [] };
    input.originalPlan.taskGraph = [{ from: "TASK-001", to: "TASK-002" }];
    input.blockingCritique = [{ id: "on-1", category: "task_sizing", blocking: true, summary: "Replace task 1", taskIds: ["TASK-001"], issueIds: [] }, { id: "on-2", category: "weak_verification", blocking: true, summary: "Strengthen task 2", taskIds: ["TASK-002"], issueIds: [] }];
    const result = await reviseWithContext(input, { ...port, call: async (stage) => {
      const supplied = stage.input as Supplied;
      if (supplied.critique[0]?.id === "on-1") return port.call(stage);
      // The second call read the plan as the round began, where task 2 still waits for task 1.
      const task = requiredAt(supplied.selectedTasks, 0);
      return unchanged(supplied, { tasks: [{ ...task, acceptanceCriteria: [...task.acceptanceCriteria, "Strengthened"] }] });
    } });
    expect(result.resolutions.every(({ resolution }) => !resolution.startsWith("Not revised"))).toBe(true);
    expect(result.plan.tasks.find(({ id }) => id === "TASK-002")).toMatchObject({ dependencies: { dependsOn: ["TASK-003"] }, acceptanceCriteria: expect.arrayContaining(["Strengthened"]) as unknown });
    expect(result.plan.taskGraph).toEqual([{ from: "TASK-003", to: "TASK-002" }]);
  });

  it("leaves the items of a call open when its patch cannot be joined with an earlier one of its round", async () => {
    const { input, port, artifacts } = await fixture();
    input.blockingCritique = [{ id: "on-1", category: "wrong_dependencies", blocking: true, summary: "Task 1 waits for task 2", taskIds: ["TASK-001"], issueIds: [] }, { id: "on-2", category: "wrong_dependencies", blocking: true, summary: "Task 2 waits for task 1", taskIds: ["TASK-002"], issueIds: [] }];
    const result = await reviseWithContext(input, { ...port, call: async (stage) => {
      const supplied = stage.input as Supplied; const task = requiredAt(supplied.selectedTasks, 0);
      return unchanged(supplied, { tasks: [{ ...task, dependencies: { ...task.dependencies, dependsOn: [task.id === "TASK-001" ? "TASK-002" : "TASK-001"] } }] });
    } });
    expect(result.plan.tasks.map(({ dependencies }) => dependencies.dependsOn)).toEqual([["TASK-002"], []]);
    expect(result.resolutions[1]?.resolution).toMatch(/^Not revised: its revision could not be joined/u);
    expect(result.plan.unresolvedQuestions.at(-1)).toMatchObject({ blocking: true, blastRadius: "high" });
    expect(artifacts.get("planner-revision-composition")).toMatchObject({ notRevisedCritiqueItemIds: ["on-2"] });
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

  it("leaves a critique item open in the plan when its revision call stopped at the output ceiling, and asks for the rest without it", async () => {
    const { input, port, calls, artifacts } = await fixture();
    const limited = (stage: PlannerStage) => Array.isArray((stage.input as Supplied).critique) && (stage.input as Supplied).critique.some(({ id }) => id === "critique-1");
    const tight = { ...port, fits: async (stage: PlannerStage) => !limited(stage) && await port.fits(stage) };
    // Without the reason it is refused as before.
    await expect(reviseWithContext(input, tight)).rejects.toThrow("PLANNER_REVISION_ITEM_CONTEXT_LIMIT_EXCEEDED:critique-1");
    calls.length = 0;
    const result = await reviseWithContext(input, { ...tight, outputLimited: async (stage) => limited(stage) });
    expect(calls.map((stage) => (stage.input as Supplied).critique.map(({ id }) => id))).toEqual([["critique-2"]]);
    expect(result.resolutions.map(({ critiqueItemId, resolution }) => [critiqueItemId, resolution.startsWith("Not revised")])).toEqual([["critique-1", true], ["critique-2", false]]);
    expect(result.plan.unresolvedQuestions.find(({ id }) => id.startsWith("revision-1.1/not-revised/"))).toMatchObject({ blocking: true, blastRadius: "high" });
    expect(artifacts.get("planner-revision-composition")).toMatchObject({ logicalModelCalls: 1, notRevisedCritiqueItemIds: ["critique-1"] });
  });

  it("splits a call that would rewrite more than its share of tasks, and sends an item that fits no usual size as required input", async () => {
    const { input, port, calls } = await fixture();
    input.blockingCritique = [{ ...requiredAt(input.blockingCritique, 0), taskIds: ["TASK-001", "TASK-002"] }, requiredAt(input.blockingCritique, 1)];
    // The first item alone names both tasks; the second would make no difference to the call's tasks but more items than allowed.
    await reviseWithContext(input, { ...port, call: async (stage) => { calls.push(stage); return unchanged(stage.input as Supplied); } }, undefined, { maximumItems: 1 });
    expect(calls.map((stage) => (stage.input as Supplied).critique.map(({ id }) => id))).toEqual([["critique-1"], ["critique-2"]]);
    calls.length = 0;
    const asked: string[] = [];
    const result = await reviseWithContext(input, { ...port, fits: async () => false, admits: async (stage) => { asked.push(stage.activityId); return true; }, call: async (stage) => { calls.push(stage); return unchanged(stage.input as Supplied); } });
    expect(asked.every((id) => id.startsWith("planner/revision-batch/"))).toBe(true);
    expect(calls).toHaveLength(2);
    expect(result.resolutions).toHaveLength(input.blockingCritique.length);
  });
});

function requiredAt<T>(values: readonly T[], index: number): T { const value = values[index]; if (value === undefined) throw new Error('FIXTURE_RECORD_ABSENT'); return value; }
