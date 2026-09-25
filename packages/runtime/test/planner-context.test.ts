import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { planIRSchema, type PlanIR } from "@arbitra/schemas/plan.js";
import type { PlannerBrief, PlannerOutline, PlannerOutlineLinks, PlannerTaskOutline } from "@arbitra/schemas/planner-composition.js";
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
          const task = { ...taskOutline(template), id: "TASK-001", addresses: { ...template.addresses, issues: [issueId], validation: ["VAL-001"] }, dependencies: { dependsOn: [], blocks: [], conflictsWith: [] } };
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
