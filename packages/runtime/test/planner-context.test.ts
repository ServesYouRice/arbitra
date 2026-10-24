import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { planIRSchema, type PlanIR, type UnresolvedQuestion } from "@arbitra/schemas/plan.js";
import type { PlannerBrief, PlannerOutline, PlannerOutlineLinks, PlannerQuestionGroups, PlannerTaskOutline } from "@arbitra/schemas/planner-composition.js";
import type { PlannerInput } from "@arbitra/workflow/nodes/planner/node.js";
import { auditPlannerRecords, planWithContext, taskOutline, type PlannerStage } from "../src/planner-context.js";

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

  it("gives the outline the record set's compact context and each reading stage the context of its own issues", async () => {
    const { input, calls, port } = await fixture();
    const base = auditPlannerRecords(input);
    await planWithContext(input, port, { records: { ...base, outlineContext: { ties: "identities only" }, scoped: (ids) => ({ ...base.scoped(ids), projectContext: { operationsOf: ids } }) } });
    expect(calls.find(({ activityId }) => activityId === "planner/outline")?.input).toMatchObject({ projectContext: { ties: "identities only" } });
    const reads = calls.filter(({ activityId }) => activityId.startsWith("planner/brief/") || activityId.startsWith("planner/expand/")).map(({ input: supplied }) => supplied as { projectContext: unknown; canonicalIssues: { candidateId: string }[] });
    expect(reads).toHaveLength(6);
    for (const read of reads) expect(read.projectContext).toEqual({ operationsOf: read.canonicalIssues.map(({ candidateId }) => candidateId) });
  });

  it("sends a task expansion that fits no usual size as required input, and gives up only when that is refused too", async () => {
    const { input, port, calls } = await fixture();
    const tight = { ...port, fits: async (stage: PlannerStage) => stage.activityId !== "planner/expand/TASK-2" && await port.fits(stage) };
    await expect(planWithContext(input, tight)).rejects.toThrow("PLANNER_TASK_CONTEXT_LIMIT_EXCEEDED:TASK-2");
    const asked: string[] = [];
    const result = await planWithContext(input, { ...tight, admits: async (stage) => { asked.push(stage.activityId); return true; } });
    // Asked only before giving up, so the grouping of the other stages is as before.
    expect(asked).toEqual(["planner/expand/TASK-2"]);
    expect(result.tasks).toHaveLength(3);
    expect(calls.filter(({ activityId }) => activityId === "planner/expand/TASK-2")).toHaveLength(1);
  });

  it("keeps a task as outlined when its expansion stopped at the output ceiling in every form", async () => {
    const { input, port, calls, artifacts, plan } = await fixture();
    const limited = new Set<string>();
    const tight = { ...port, fits: async (stage: PlannerStage) => !limited.has(stage.activityId) && await port.fits(stage), outputLimited: async (stage: PlannerStage) => limited.has(stage.activityId) };
    // Stopped once: the scoped form is asked for instead.
    limited.add("planner/expand/TASK-2");
    await planWithContext(input, tight);
    expect(calls.map(({ activityId }) => activityId).filter((id) => id.includes("TASK-2"))).toEqual(["planner/expand/TASK-2/scoped"]);
    // Stopped in both forms: the task stays as outlined, and a blocking question names it.
    limited.add("planner/expand/TASK-2/scoped"); calls.length = 0;
    const result = await planWithContext(input, tight);
    expect(calls.some(({ activityId }) => activityId.includes("TASK-2"))).toBe(false);
    expect(result.tasks.map(({ id }) => id)).toEqual(["TASK-1", "TASK-2", "TASK-3"]);
    expect(result.tasks[1]).toMatchObject({ ...taskOutline(plan.tasks[1] as PlanIR["tasks"][number]), implementationGuidance: [], acceptanceCriteria: [], context: [expect.stringContaining("Not expanded")] });
    expect(result.unresolvedQuestions.at(-1)).toMatchObject({ id: "expansion-TASK-2/not-expanded", blocking: true, blastRadius: "high" });
    expect(artifacts.get("planner-composition")).toMatchObject({ taskExpansions: 2, notExpandedTaskIds: ["TASK-2"], logicalModelCalls: 6 });
    // A task that is too large, and not stopped at the ceiling, is still refused.
    await expect(planWithContext(input, { ...tight, outputLimited: async () => false })).rejects.toThrow("PLANNER_TASK_CONTEXT_LIMIT_EXCEEDED:TASK-2");
  });

  it("orders an outline's tasks that write the same files unordered, so no repair has to write the outline again", async () => {
    const { input, port } = await fixture();
    const ordered: PlannerOutline[] = [];
    await planWithContext(input, { ...port, call: async (stage) => {
      const value = await port.call(stage);
      if (stage.activityId !== "planner/outline") return value;
      // Observed live: two tasks shared files and were related only by conflictsWith.
      const outline = value as PlannerOutline;
      const unordered = { ...outline, tasks: outline.tasks.map((task) => ({ ...task, dependencies: { dependsOn: [], blocks: [], conflictsWith: [] } })), taskGraph: [] };
      ordered.push(stage.schema.parse(unordered) as PlannerOutline);
      return stage.schema.parse(value);
    } });
    // Each later task waits for the nearest earlier writer: one chain, not every pair.
    expect(ordered[0]?.tasks.map(({ dependencies }) => dependencies.dependsOn)).toEqual([[], ["TASK-1"], ["TASK-2"]]);
    expect(ordered[0]?.taskGraph).toEqual([{ from: "TASK-1", to: "TASK-2" }, { from: "TASK-2", to: "TASK-3" }]);
  });

  it("preserves the original one-call activity when all mandatory input fits", async () => {
    const { plan, input, port, calls } = await fixture();
    expect(await planWithContext(input, { ...port, fits: async () => true })).toEqual(plan);
    expect(calls.map(({ activityId }) => activityId)).toEqual(["planner/plan"]);
  });

  it("does not ask for a plan in one call when one answer is not expected to hold its records", async () => {
    // Observed live (P20 pilot): the one call for 52 issues stopped at the output ceiling after nine minutes.
    const { input, port, calls } = await fixture();
    const roomy = { ...port, fits: async (stage: PlannerStage) => stage.activityId === "planner/plan" || await port.fits(stage) };
    await planWithContext(input, roomy, { maximumPlanRecords: 3 });
    expect(calls.map(({ activityId }) => activityId)).toEqual(["planner/plan"]);
    calls.length = 0;
    const result = await planWithContext(input, roomy, { maximumPlanRecords: 2 });
    expect(calls.some(({ activityId }) => activityId === "planner/plan")).toBe(false);
    expect(calls.filter(({ activityId }) => activityId.startsWith("planner/expand/"))).toHaveLength(3);
    expect(result.tasks).toHaveLength(3);
  });

  it("expands a large outline against scoped outlines, and each task against its own files when the record set names them", async () => {
    // Observed live (P20 pilot): the whole outline of 31 tasks and the locations of all 52 issues went with each of 31 expansions.
    const { plan, input, port } = await fixture();
    const template = plan.tasks[0] as PlanIR["tasks"][number];
    const issues = Array.from({ length: 9 }, (_, index) => ({ ...(input.canonicalIssues[0] as PlannerInput["canonicalIssues"][number]), candidateId: `C-${index + 1}`, sourceFindingIds: [`source-${index + 1}`] }));
    const tasks = issues.map(({ candidateId }, index) => ({ ...template, id: `TASK-${index + 1}`, addresses: { ...template.addresses, issues: [candidateId] }, scope: { ...template.scope, likelyFiles: [`src/task-${index + 1}.ts`] }, dependencies: { dependsOn: index > 0 ? [`TASK-${index}`] : [], blocks: [], conflictsWith: [] } }));
    const large: PlanIR = { ...plan, acceptedIssueIds: issues.map(({ candidateId }) => candidateId), tasks, taskGraph: tasks.slice(1).map(({ id }, index) => ({ from: `TASK-${index + 1}`, to: id })),
      traceability: { ...plan.traceability, issueToValidation: issues.map(({ candidateId }) => ({ issueId: candidateId, validationIds: ["VAL-001"] })) },
      routingRecommendations: tasks.map(({ id, routing }) => ({ taskId: id, capability: routing.capability, effort: routing.effort, reason: routing.reason })) };
    const calls: PlannerStage[] = [];
    const wide = { ...port, async fits(stage: PlannerStage) { return stage.activityId !== "planner/plan"; }, async call(stage: PlannerStage): Promise<unknown> {
      calls.push(stage);
      if (stage.activityId.startsWith("planner/brief/")) return { issues: (stage.input as PlannerInput).canonicalIssues.map(({ candidateId }) => ({ issueId: candidateId, summary: `Brief ${candidateId}`, affectedPaths: [], behavioralAssertions: ["Expected behavior"], integrationConstraints: [], unresolvedQuestions: [] })) };
      if (stage.activityId === "planner/outline") return { ...large, tasks: tasks.map(taskOutline), unresolvedQuestions: [] };
      const id = (stage.input as { selectedTask: { id: string } }).selectedTask.id;
      return { task: tasks.find((task) => task.id === id), unresolvedQuestions: [] };
    } };
    const wider: PlannerInput = { ...input, canonicalIssues: issues };
    const base = auditPlannerRecords(wider);
    const result = await planWithContext(wider, wide, { records: { ...base, sourcePaths: (ids) => ids.map((id) => `src/cited-by-${id}.ts`) } });
    expect(result.tasks).toHaveLength(9);
    const expansions = calls.filter(({ activityId }) => activityId.startsWith("planner/expand/"));
    expect(expansions.map(({ activityId }) => activityId)).toEqual(tasks.map(({ id }) => `planner/expand/${id}/scoped`));
    // The dependency neighbourhood in full, every task in the index, and the files of the task and of its issue.
    const fifth = expansions[4] as PlannerStage & { input: { planOutline: { tasks: { id: string }[]; outlineScope: { completeOutline: boolean; taskIndex: unknown[] } } } };
    expect(fifth.input.planOutline.tasks.map(({ id }) => id)).toEqual(["TASK-4", "TASK-5", "TASK-6"]);
    expect(fifth.input.planOutline.outlineScope.completeOutline).toBe(false); expect(fifth.input.planOutline.outlineScope.taskIndex).toHaveLength(9);
    expect(fifth.sourcePaths).toEqual(["src/task-5.ts", "src/cited-by-C-5.ts"]);
    // The briefs and the outline read every file as far as it fits, and so does an expansion of a record set that names no files.
    expect(calls.filter(({ activityId }) => !activityId.startsWith("planner/expand/")).every(({ sourcePaths }) => sourcePaths === undefined)).toBe(true);
    calls.length = 0;
    await planWithContext(wider, wide, { records: base });
    expect(calls.every(({ sourcePaths }) => sourcePaths === undefined)).toBe(true);
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

describe("hierarchical global outline when all briefs cannot share one outline", () => {
  async function sectioned(options: { readonly linksFit?: boolean } = {}) {
    const f = await fixture();
    const template = f.plan.tasks[0]; if (template === undefined) throw new Error("FIXTURE_TASK_ABSENT");
    const sectionIds = (stage: PlannerStage) => (stage.input as { outlineScope: { recordIds: string[] } }).outlineScope.recordIds;
    const port = { ...f.port,
      async fits(stage: PlannerStage) {
        if (stage.activityId === "planner/plan" || stage.activityId === "planner/outline") return false;
        if (stage.activityId.startsWith("planner/outline/section/")) return sectionIds(stage).length <= 1;
        if (stage.activityId.startsWith("planner/outline/links/")) return options.linksFit === true || (stage.input as { sections: unknown[] }).sections.length <= 2;
        if (stage.activityId.startsWith("planner/expand/")) return stage.activityId.endsWith("/scoped");
        return f.port.fits(stage);
      },
      async call(stage: PlannerStage): Promise<unknown> {
        if (stage.activityId.startsWith("planner/outline/section/")) {
          f.calls.push(stage);
          const [issueId = ""] = sectionIds(stage); const briefs = (stage.input as { issueBriefs: PlannerBrief["issues"] }).issueBriefs;
          const task = { ...taskOutline(template), id: "TASK-001", scope: { ...template.scope, likelyFiles: [`src/${issueId}.ts`] }, addresses: { ...template.addresses, issues: [issueId], validation: ["VAL-001"] }, dependencies: { dependsOn: [], blocks: [], conflictsWith: [] } };
          return { ...f.plan, id: `section-${issueId}`, acceptedIssueIds: [issueId], tasks: [task], taskGraph: [], rolloutConcerns: [`Rollout ${issueId}`],
            validationContract: { schemaVersion: 1, validation: [{ id: "VAL-001", assertion: `${issueId} is closed`, evidence: ["regression test"] }] },
            traceability: { issueToValidation: [{ issueId, validationIds: ["VAL-001"] }], requirementLinks: { schemaVersion: 1, links: [] } },
            routingRecommendations: [{ taskId: "TASK-001", capability: "frontier", effort: "high", reason: ["security"] }],
            unresolvedQuestions: [...briefs.flatMap(({ unresolvedQuestions }) => unresolvedQuestions), { id: "Q-1", question: `Section question ${issueId}`, blocking: false, blastRadius: "low" }] };
        }
        if (stage.activityId.startsWith("planner/outline/header/")) { f.calls.push(stage); return { id: "plan-global", title: "Global plan", reasoningOutcome: "Merged", implementationStrategy: ["Repair each boundary"], dependencies: [], rolloutConcerns: [], migrationConcerns: [] }; }
        if (stage.activityId.startsWith("planner/outline/links/")) {
          f.calls.push(stage);
          const tasks = (stage.input as { sections: { tasks: { id: string }[] }[] }).sections.flatMap(({ tasks: entries }) => entries.map(({ id }) => id));
          return { dependencies: tasks.includes("TASK-001") && tasks.includes("TASK-002") ? [{ from: "TASK-001", to: "TASK-002", reason: "Shared authorization boundary" }] : [] };
        }
        if (stage.activityId.startsWith("planner/expand/")) {
          f.calls.push(stage);
          const selected = (stage.input as { selectedTask: PlannerTaskOutline }).selectedTask;
          return { task: { ...template, ...selected }, unresolvedQuestions: [] };
        }
        return f.port.call(stage);
      } };
    return { ...f, port };
  }

  it("outlines disjoint sections, links every section pair and expands against scoped outlines", async () => {
    const { input, calls, artifacts, port } = await sectioned();
    const result = await planWithContext(input, port);
    const kinds = calls.map(({ activityId }) => activityId.split("/").slice(0, 3).join("/"));
    expect(kinds.filter((kind) => kind === "planner/outline/section")).toHaveLength(3);
    expect(kinds.filter((kind) => kind === "planner/outline/header")).toHaveLength(1);
    // The complete section set could not share one link context; every pair was linked.
    expect(kinds.filter((kind) => kind === "planner/outline/links")).toHaveLength(3);
    expect(calls.some(({ activityId }) => activityId === "planner/outline")).toBe(false);
    expect(result.tasks.map(({ id }) => id)).toEqual(["TASK-001", "TASK-002", "TASK-003"]);
    expect(result.tasks.map(({ addresses }) => addresses.issues)).toEqual([["C-1"], ["C-2"], ["C-3"]]);
    expect(result.validationContract.validation.map(({ id }) => id)).toEqual(["VAL-001", "VAL-002", "VAL-003"]);
    expect(result.traceability.issueToValidation).toEqual([1, 2, 3].map((index) => ({ issueId: `C-${index}`, validationIds: [`VAL-00${index}`] })));
    expect(result.tasks[1]?.dependencies.dependsOn).toEqual(["TASK-001"]);
    expect(result.taskGraph).toEqual([{ from: "TASK-001", to: "TASK-002" }]);
    expect(result).toMatchObject({ id: "plan-global", acceptedIssueIds: ["C-1", "C-2", "C-3"], rolloutConcerns: ["Rollout C-1", "Rollout C-2", "Rollout C-3"] });
    // Brief questions survive verbatim; section-local questions are namespaced, never merged away.
    expect(result.unresolvedQuestions).toHaveLength(6);
    expect(new Set(result.unresolvedQuestions.map(({ id }) => id)).size).toBe(6);
    // Every expansion re-read its complete original issue against a scoped outline and task index.
    const expansions = calls.filter(({ activityId }) => activityId.startsWith("planner/expand/"));
    expect(expansions.map(({ activityId }) => activityId)).toEqual(["TASK-001", "TASK-002", "TASK-003"].map((id) => `planner/expand/${id}/scoped`));
    for (const [index, issue] of input.canonicalIssues.entries()) {
      const supplied = expansions[index]?.input as { canonicalIssues: unknown[]; planOutline: { outlineScope: { taskIndex: unknown[] } } };
      expect(supplied.canonicalIssues).toEqual([issue]);
      expect(supplied.planOutline.outlineScope.taskIndex).toHaveLength(3);
    }
    expect(artifacts.get("planner-composition")).toMatchObject({ issueBatches: 3, outlineSections: 3, outlineCalls: 7, taskExpansions: 3, logicalModelCalls: 13 });
    expect(artifacts.get("planner-outline-sections")).toHaveLength(3);
  });

  it("asks for the sections side by side and checks each one inside its call, so a reply that breaks a rule is sent back", async () => {
    const { input, calls, port } = await sectioned();
    const groups: number[] = [];
    const result = await planWithContext(input, { ...port, together: async <T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> => { groups.push(items.length); return Promise.all(items.map(run)); } });
    // The reading notes, the sections and the expansions each went as one group.
    expect(groups).toEqual([3, 3, 3]);
    expect(result.tasks.map(({ id }) => id)).toEqual(["TASK-001", "TASK-002", "TASK-003"]);
    const section = calls.find(({ activityId }) => activityId.startsWith("planner/outline/section/")) as PlannerStage;
    const reply = await port.call(section) as PlannerOutline;
    expect(() => section.schema.parse(reply)).not.toThrow();
    expect(() => section.schema.parse({ ...reply, acceptedIssueIds: [] })).toThrow("PLANNER_OUTLINE_SECTION_SCOPE_INVALID");
    expect(() => section.schema.parse({ ...reply, unresolvedQuestions: reply.unresolvedQuestions.slice(1) })).toThrow("PLANNER_OUTLINE_QUESTION_DROPPED");
    expect(() => section.schema.parse({ ...reply, tasks: reply.tasks.map((task) => ({ ...task, dependencies: { ...task.dependencies, dependsOn: ["TASK-404"] } })) })).toThrow("PLANNER_OUTLINE_SECTION_REFERENCE_INVALID");
  });

  it("sections an outline that fits by size when one answer is not expected to hold its records", async () => {
    const { input, calls, port } = await sectioned();
    const roomy = { ...port, fits: async (stage: PlannerStage) => stage.activityId === "planner/outline" || stage.activityId.startsWith("planner/outline/section/") || await port.fits(stage) };
    const result = await planWithContext(input, roomy, { maximumOutlineRecords: 1 });
    expect(calls.some(({ activityId }) => activityId === "planner/outline")).toBe(false);
    expect(calls.filter(({ activityId }) => activityId.startsWith("planner/outline/section/")).map(({ input: supplied }) => (supplied as { outlineScope: { recordIds: string[] } }).outlineScope.recordIds)).toEqual([["C-1"], ["C-2"], ["C-3"]]);
    expect(result.tasks).toHaveLength(3);
  });

  it("links the complete section set in one pass when it fits", async () => {
    const { input, calls, port } = await sectioned({ linksFit: true });
    const result = await planWithContext(input, port);
    expect(calls.filter(({ activityId }) => activityId.startsWith("planner/outline/links/"))).toHaveLength(1);
    expect(result.taskGraph).toEqual([{ from: "TASK-001", to: "TASK-002" }]);
  });

  it.each(["scope", "question", "reference", "link", "cycle"] as const)("rejects an invalid %s in a hierarchical outline before expansion", async (mode) => {
    const { input, calls, port } = await sectioned();
    const cycle = (stage: PlannerStage) => (stage.input as { sections: { tasks: { id: string }[] }[] }).sections.flatMap(({ tasks }) => tasks.map(({ id }) => id)).includes("TASK-001")
      ? [{ from: "TASK-003", to: "TASK-001", reason: "cycle" }] : [{ from: "TASK-002", to: "TASK-003", reason: "cycle" }];
    await expect(planWithContext(input, { ...port, call: async (stage) => {
      const output = await port.call(stage);
      if (stage.activityId.startsWith("planner/outline/section/")) {
        const section = output as PlannerOutline;
        if (mode === "scope" && section.tasks[0]) section.tasks[0].addresses.issues = ["C-9"];
        if (mode === "question") section.unresolvedQuestions = section.unresolvedQuestions.slice(1);
        if (mode === "reference" && section.tasks[0]) section.tasks[0].dependencies.dependsOn = ["TASK-404"];
      }
      if (stage.activityId.startsWith("planner/outline/links/")) {
        const links = output as PlannerOutlineLinks;
        if (mode === "link") links.dependencies = [{ from: "TASK-001", to: "TASK-001", reason: "self" }];
        if (mode === "cycle" && links.dependencies.length === 0) links.dependencies = cycle(stage);
      }
      return output;
    } })).rejects.toThrow({ scope: "PLANNER_OUTLINE_SECTION_SCOPE_INVALID", question: "PLANNER_OUTLINE_QUESTION_DROPPED", reference: "PLANNER_OUTLINE_SECTION_REFERENCE_INVALID", link: "PLANNER_OUTLINE_LINK_INVALID", cycle: "PLANNER_OUTLINE_TRACEABILITY_INVALID" }[mode]);
    expect(calls.some(({ activityId }) => activityId.startsWith("planner/expand/"))).toBe(false);
  });

  it("fails explicitly only when one record cannot fit a section outline", async () => {
    const { input, port, calls } = await sectioned();
    await expect(planWithContext(input, { ...port, fits: async (stage) => !stage.activityId.startsWith("planner/outline/section/") && await port.fits(stage) })).rejects.toThrow("PLANNER_OUTLINE_RECORD_CONTEXT_LIMIT_EXCEEDED:C-1");
    expect(calls.some(({ activityId }) => activityId.startsWith("planner/outline"))).toBe(false);
  });
});

describe("an audit plan written in sections side by side", () => {
  /** Five issues: C-1, C-3 and C-5 cite billing.ts, C-2 and C-4 cite users.ts. Each section call plans its issues
   * with local identifiers, and the section of C-5 shares billing.ts with a task of another section. `ask` gives a
   * section's questions and its tasks' context; `group` answers the call that finds questions asked twice. */
  async function sections(ask = (ids: readonly string[]): { questions: UnresolvedQuestion[]; context: string[] } => ({ questions: [{ id: "Q-1", question: `Decide for ${ids.join(", ")}`, blocking: false, blastRadius: "low" }], context: ["resolves:Q-1"] }),
    group: (questions: readonly { id: string; section: string; question: string }[]) => PlannerQuestionGroups = () => ({ groups: [] })) {
    const { input: base, plan: template } = await fixture();
    const task = template.tasks[0]; if (task === undefined) throw new Error("FIXTURE_TASK_ABSENT");
    const issues = [1, 2, 3, 4, 5].map((index) => ({ ...base.canonicalIssues[0] as PlannerInput["canonicalIssues"][number], candidateId: `C-${index}`, claim: { trust: "untrusted_data" as const, title: `Issue ${index}`, description: `Issue ${index}` } }));
    const input: PlannerInput = { ...base, canonicalIssues: issues };
    const file = (id: string) => ["C-2", "C-4"].includes(id) ? "users.ts" : "billing.ts";
    const records = { ...auditPlannerRecords(input), sourcePaths: (ids: readonly string[]) => [...new Set(ids.map(file))] };
    const calls: PlannerStage[] = []; const artifacts = new Map<string, unknown>(); const together: number[] = [];
    const port = {
      async fits(stage: PlannerStage) { return stage.activityId.startsWith("planner/section/"); },
      together: async <T, R>(items: readonly T[], run: (item: T) => Promise<R>) => { together.push(items.length); return Promise.all(items.map(run)); },
      async call(stage: PlannerStage): Promise<unknown> {
        calls.push(stage);
        if (stage.activityId.startsWith("planner/questions/")) return stage.schema.parse(group((stage.input as { questions: { id: string; section: string; question: string }[] }).questions));
        const ids = (stage.input as { planningScope: { recordIds: string[] } }).planningScope.recordIds;
        const asked = ask(ids);
        const tasks = ids.map((issueId, index) => ({ ...task, id: `TASK-00${index + 1}`, title: `Fix ${issueId}`, addresses: { issues: [issueId], validation: ["VAL-001"], requirements: [] }, scope: { ...task.scope, likelyFiles: [file(issueId)] },
          dependencies: { dependsOn: index > 0 ? [`TASK-00${index}`] : [], blocks: [], conflictsWith: [] }, context: asked.context,
          acceptanceCriteria: ["VAL-001 holds once Q-1 is answered."], implementationGuidance: [index > 0 ? `Build on TASK-00${index}, not TASK-0010.` : "Start here."] }));
        return stage.schema.parse({ ...template, title: `Plan for ${ids.join(", ")}`, acceptedIssueIds: ids, tasks, unresolvedQuestions: asked.questions,
          taskGraph: tasks.slice(1).map(({ id }, index) => ({ from: `TASK-00${index + 1}`, to: id })), traceability: { ...template.traceability, issueToValidation: ids.map((issueId) => ({ issueId, validationIds: ["VAL-001"] })) },
          routingRecommendations: tasks.map(({ id, routing }) => ({ taskId: id, capability: routing.capability, effort: routing.effort, reason: routing.reason })) });
      },
      async publish(kind: string, value: unknown) { artifacts.set(kind, value); },
    };
    return { input, records, port, calls, artifacts, together };
  }

  it("plans related issues together, side by side, and joins them with global numbers and ordered shared writes", async () => {
    const { input, records, port, calls, artifacts, together } = await sections();
    const plan = await planWithContext(input, port, { records, recordsPerSection: 3 });
    // Ordered by the files they cite: the three billing issues, then the two users issues.
    expect(calls.map((stage) => (stage.input as { planningScope: { recordIds: string[] } }).planningScope.recordIds)).toEqual([["C-1", "C-3", "C-5"], ["C-2", "C-4"]]);
    expect(together).toEqual([2]);
    expect(calls[0]?.sourcePaths).toEqual(["billing.ts"]);
    expect((calls[1]?.input as { planningScope: { otherIssues: { candidateId: string }[] } }).planningScope.otherIssues.map(({ candidateId }) => candidateId)).toEqual(["C-1", "C-3", "C-5"]);
    expect(plan.tasks.map(({ id, title }) => [id, title])).toEqual([["TASK-001", "Fix C-1"], ["TASK-002", "Fix C-3"], ["TASK-003", "Fix C-5"], ["TASK-004", "Fix C-2"], ["TASK-005", "Fix C-4"]]);
    expect(plan.validationContract.validation.map(({ id }) => id)).toEqual(["VAL-001", "VAL-002"]);
    expect(plan.tasks.map(({ addresses }) => addresses.validation[0])).toEqual(["VAL-001", "VAL-001", "VAL-001", "VAL-002", "VAL-002"]);
    expect(plan.taskGraph).toEqual([{ from: "TASK-001", to: "TASK-002" }, { from: "TASK-002", to: "TASK-003" }, { from: "TASK-004", to: "TASK-005" }]);
    expect(plan.unresolvedQuestions.map(({ id }) => id)).toEqual([expect.stringMatching(/^section-[0-9a-f]{24}\/Q-1$/u), expect.stringMatching(/^section-[0-9a-f]{24}\/Q-1$/u)]);
    expect(plan.tasks.map(({ context }) => context[0])).toEqual([...Array(3).fill(`resolves:${plan.unresolvedQuestions[0]?.id}`), ...Array(2).fill(`resolves:${plan.unresolvedQuestions[1]?.id}`)]);
    // The text of a later section's tasks names that section's own checks, tasks and questions, not the first section's.
    expect(plan.tasks.map(({ acceptanceCriteria }) => acceptanceCriteria[0])).toEqual([...Array(3).fill(`VAL-001 holds once ${plan.unresolvedQuestions[0]?.id} is answered.`), ...Array(2).fill(`VAL-002 holds once ${plan.unresolvedQuestions[1]?.id} is answered.`)]);
    expect(plan.tasks.map(({ implementationGuidance }) => implementationGuidance[0])).toEqual(["Start here.", "Build on TASK-001, not TASK-0010.", "Build on TASK-002, not TASK-0010.", "Start here.", "Build on TASK-004, not TASK-0010."]);
    expect(plan.acceptedIssueIds).toEqual(["C-1", "C-2", "C-3", "C-4", "C-5"]);
    expect(artifacts.get("planner-composition")).toMatchObject({ kind: "sections_side_by_side", sections: 2, logicalModelCalls: 2 });
  });

  it("plans a section that does not fit as two halves, and leaves a plan within one section to one call", async () => {
    const { input, records, port, calls } = await sections();
    await planWithContext(input, { ...port, fits: async (stage) => stage.activityId.startsWith("planner/section/") && (stage.input as { planningScope: { recordIds: string[] } }).planningScope.recordIds.length < 3 }, { records, recordsPerSection: 3 });
    expect(calls.map((stage) => (stage.input as { planningScope: { recordIds: string[] } }).planningScope.recordIds)).toEqual([["C-1", "C-3"], ["C-5"], ["C-2", "C-4"]]);
    calls.length = 0;
    await expect(planWithContext(input, { ...port, fits: async () => false }, { records, recordsPerSection: 5 })).rejects.toThrow();
    expect(calls.some(({ activityId }) => activityId.startsWith("planner/section/"))).toBe(false);
  });

  it("asks a question two sections asked once, as strictly as either asked it, and points every reference at it", async () => {
    const { input, records, port, calls, artifacts } = await sections((ids) => ids.includes("C-1")
      ? { questions: [{ id: "Q-1", question: "Which forwarded headers are trusted? Default: the rightmost X-Forwarded-For entry.", blocking: false, blastRadius: "medium" }], context: ["resolves:Q-1"] }
      : { questions: [{ id: "Q-1", question: "Which deployment model defines trusted forwarded headers?", blocking: true, blastRadius: "high" }, { id: "Q-2", question: `Decide for ${ids.join(", ")}`, blocking: false, blastRadius: "low" }], context: ["Waits for Q-1."] },
    (questions) => ({ groups: [{ questionIds: questions.filter(({ question }) => question.includes("forwarded headers")).map(({ id }) => id), reason: "Both ask which forwarded headers to trust." }] }));
    const plan = await planWithContext(input, { ...port, fits: async (stage) => /^planner\/(?:section|questions)\//u.test(stage.activityId) }, { records, recordsPerSection: 3 });
    expect(plan.unresolvedQuestions.map(({ question, blocking, blastRadius }) => ({ question, blocking, blastRadius }))).toEqual([
      { question: "Which forwarded headers are trusted? Default: the rightmost X-Forwarded-For entry. Also asked by another section: Which deployment model defines trusted forwarded headers?", blocking: true, blastRadius: "high" },
      { question: "Decide for C-2, C-4", blocking: false, blastRadius: "low" }]);
    const stage = calls.find(({ activityId }) => activityId.startsWith("planner/questions/"));
    // The call reads the sections' questions, not the repository.
    expect(stage?.sourcePaths).toEqual([]);
    const [kept, merged, other] = (stage?.input as { questions: { id: string }[] }).questions.map(({ id }) => id);
    expect(plan.unresolvedQuestions.map(({ id }) => id)).toEqual([kept, other]);
    // The question is now blocking with a high blast radius, so no task settles it by itself.
    expect(plan.tasks.map(({ context }) => context[0])).toEqual([...Array(3).fill(`Waits for the answer to ${kept}.`), ...Array(2).fill(`Waits for ${kept}.`)]);
    expect(plan.tasks.map(({ acceptanceCriteria }) => acceptanceCriteria[0])).toEqual([...Array(3).fill(`VAL-001 holds once ${kept} is answered.`), ...Array(2).fill(`VAL-002 holds once ${kept} is answered.`)]);
    expect(JSON.stringify(plan)).not.toContain(merged);
    expect(artifacts.get("planner-question-groups")).toEqual([{ questionId: kept, merged: [merged], reason: "Both ask which forwarded headers to trust." }]);
    expect(artifacts.get("planner-composition")).toMatchObject({ logicalModelCalls: 3 });
    // A group names questions of different sections, each once.
    expect(() => stage?.schema.parse({ groups: [{ questionIds: [merged, other], reason: "Same section." }] })).toThrow("PLANNER_QUESTION_GROUPS_INVALID");
    expect(() => stage?.schema.parse({ groups: [{ questionIds: [kept, "Q-9"], reason: "Unknown." }] })).toThrow("PLANNER_QUESTION_GROUPS_INVALID");
  });
});
