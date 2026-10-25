import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { plannerNode, withoutSelfReferences, type PlannerInput, type PlannerRequest, type PlannerSchema } from "../../src/nodes/planner/node.js";
import { SHARED_WRITE_ORDER_NOTE, validateTraceability, withSharedWritesOrdered, type TraceablePlan } from "../../src/nodes/planner/traceability.js";

describe("single coherent Planner", () => {
  it("reports staged logical model calls without equating them with provider attempts", async () => {
    const node = plannerNode({ protocolVersion: "1.0.0", protocolHash: "a".repeat(64), schema: await planSchema(), runtime: { logicalModelCalls: 7, async plan() { return plan(); } } });
    expect((await node.run(input())).modelCalls).toBe(7);
  });

  it("receives only bounded inputs, preserves taint and emits unresolved questions before tasks", async () => {
    const requests: PlannerRequest[] = []; const raw = plan(); const node = plannerNode({ protocolVersion: "1.0.0", protocolHash: "a".repeat(64), schema: await planSchema(), runtime: { async plan(request) { requests.push(request); return raw; } } });
    const result = await node.run(input());
    expect(result.modelCalls).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ session: "single_coherent_planner", outputSchema: "PlanIR", forbiddenInputs: ["raw_audit_transcripts"], input: { canonicalIssues: [{ claim: { trust: "untrusted_data" } }], premiseReport: { interpretation: "smoke_test_only_not_proof" } } });
    const keys = Object.keys(result.plan); expect(keys.indexOf("unresolvedQuestions")).toBeLessThan(keys.indexOf("tasks"));
    expect(JSON.stringify(result.plan.tasks[0]?.routing)).not.toMatch(/model/iu);
  });

  it("hard-fails with a named diagnostic when a task omits its validation link", async () => {
    const invalid = plan(); requiredAt(invalid.tasks, 0).addresses.validation = [];
    const node = plannerNode({ protocolVersion: "1.0.0", protocolHash: "a".repeat(64), schema: await planSchema(), runtime: { async plan() { return invalid; } } });
    await expect(node.run(input())).rejects.toMatchObject({ name: "PlannerTraceabilityError", diagnostics: [expect.objectContaining({ code: "TASK_REQUIRES_VALIDATION_ASSERTION" })] });
  });

  it("requires every accepted issue to map to a real assertion", async () => {
    const missing = plan(); missing.traceability.issueToValidation = [];
    expect(validateTraceability((await planSchema()).parse(missing), ["C-1"])).toEqual([expect.objectContaining({ code: "ACCEPTED_ISSUE_REQUIRES_VALIDATION_ASSERTION" })]);
  });

  it("does not allow the planner to omit an accepted input issue from its declared set", async () => {
    const omitted = plan(); omitted.acceptedIssueIds = [];
    expect(validateTraceability((await planSchema()).parse(omitted), ["C-1"])).toContainEqual(expect.objectContaining({ code: "ACCEPTED_ISSUE_SET_MISMATCH" }));
  });

  it("retains additive versioned Feature requirement links without replacing validation links", async () => {
    const feature = plan(); feature.mode = "feature"; feature.acceptedIssueIds = []; feature.traceability.issueToValidation = []; const task = requiredAt(feature.tasks, 0); task.addresses.issues = []; task.addresses.requirements = ["REQ-1"]; feature.traceability.requirementLinks = { schemaVersion: 1, links: [{ requirementId: "REQ-1", validationIds: ["VAL-001"], taskIds: ["TASK-001"] }] };
    const parsed = (await planSchema()).parse(feature);
    expect(parsed.tasks[0]?.addresses).toEqual({ issues: [], validation: ["VAL-001"], requirements: ["REQ-1"] });
    expect(validateTraceability(parsed)).toEqual([]);
  });

  it("rejects raw transcript-shaped input and silent resolution of a high-blast-radius question", async () => {
    const node = plannerNode({ protocolVersion: "1.0.0", protocolHash: "a".repeat(64), schema: await planSchema(), runtime: { async plan() { return plan(); } } });
    await expect(node.run({ ...input(), rawAuditTranscript: "not reachable" } as PlannerInput)).rejects.toThrow("RAW_AUDIT_TRANSCRIPT_FORBIDDEN");
    const silent = plan(); silent.unresolvedQuestions = [{ id: "UQ-1", question: "Migration strategy?", blocking: true, blastRadius: "high" }]; requiredAt(silent.tasks, 0).context = ["resolves:UQ-1"];
    expect(validateTraceability((await planSchema()).parse(silent))).toEqual([expect.objectContaining({ code: "HIGH_BLAST_RADIUS_QUESTION_SILENTLY_RESOLVED" })]);
  });

  it("ships a lean pinned planner protocol that references schemas and capability routing", () => {
    const protocol = readFileSync(new URL("../../../protocols/assets/planner/1.0.0/protocol.md", import.meta.url), "utf8");
    const metadata = JSON.parse(readFileSync(new URL("../../../protocols/assets/planner/1.0.0/metadata.json", import.meta.url), "utf8")) as { compatibilityNotes: string[] };
    expect(protocol).toContain("unresolvedQuestions"); expect(protocol).toContain("never name a model"); expect(metadata.compatibilityNotes).toContain("Plan IR version 1");
  });

  it("rejects duplicate identifiers, orphan task references and accepted issues without tasks", async () => {
    const base = (await planSchema()).parse(plan()); const task = requiredAt(base.tasks, 0);
    expect(validateTraceability({ ...base, tasks: [task, task] })).toContainEqual(expect.objectContaining({ code: "DUPLICATE_PLAN_ID" }));
    expect(validateTraceability({ ...base, tasks: [] })).toContainEqual(expect.objectContaining({ code: "ACCEPTED_ISSUE_REQUIRES_TASK" }));
    expect(validateTraceability({ ...base, tasks: [{ ...task, addresses: { ...task.addresses, issues: ["unaccepted"] } }] })).toContainEqual(expect.objectContaining({ code: "UNKNOWN_TASK_ISSUE" }));
    expect(validateTraceability({ ...base, taskGraph: [{ from: task.id, to: "missing" }] })).toContainEqual(expect.objectContaining({ code: "INVALID_TASK_GRAPH" }));
  });

  it("rejects cycles and disagreements between task dependencies and the rendered graph", async () => {
    const base = (await planSchema()).parse(plan()); const first = requiredAt(base.tasks, 0);
    const second = { ...first, id: "TASK-002", dependencies: { dependsOn: [first.id], blocks: [], conflictsWith: [] } };
    const both = { ...base, tasks: [first, second], routingRecommendations: [...base.routingRecommendations, { taskId: second.id }] };
    expect(validateTraceability({ ...both, taskGraph: [] })).toContainEqual(expect.objectContaining({ code: "INVALID_TASK_GRAPH" }));
    expect(validateTraceability({ ...both, taskGraph: [{ from: first.id, to: second.id }] })).toEqual([]);
    const cyclic = { ...both, tasks: [{ ...first, dependencies: { dependsOn: [second.id], blocks: [], conflictsWith: [] } }, second], taskGraph: [{ from: first.id, to: second.id }, { from: second.id, to: first.id }] };
    expect(validateTraceability(cyclic)).toContainEqual(expect.objectContaining({ code: "TASK_GRAPH_CYCLE" }));
  });
});

describe("shared write scope ordering", () => {
  it("requires a dependency path between Audit or Feature tasks that write the same files", async () => {
    const base = (await planSchema()).parse(plan()); const first = requiredAt(base.tasks, 0);
    // Observed live: two tasks shared files and were related only by conflictsWith.
    const second = { ...first, id: "TASK-002", dependencies: { dependsOn: [], blocks: [], conflictsWith: [first.id] } };
    const unordered = { ...base, tasks: [first, second], routingRecommendations: [...base.routingRecommendations, { taskId: second.id }] };
    expect(validateTraceability(unordered)).toEqual([expect.objectContaining({ code: "SHARED_WRITE_SCOPE_UNORDERED", message: expect.stringContaining("TASK-001 and TASK-002 both write src/auth.ts, test/auth.test.ts") })]);
    const ordered = { ...unordered, tasks: [first, { ...second, dependencies: { dependsOn: [first.id], blocks: [], conflictsWith: [] } }], taskGraph: [{ from: first.id, to: second.id }] };
    expect(validateTraceability(ordered)).toEqual([]);
    const third = { ...first, id: "TASK-003", dependencies: { dependsOn: [second.id], blocks: [], conflictsWith: [] } };
    expect(validateTraceability({ ...ordered, tasks: [...ordered.tasks, third], taskGraph: [...ordered.taskGraph, { from: second.id, to: third.id }], routingRecommendations: [...ordered.routingRecommendations, { taskId: third.id }] })).toEqual([]);
    expect(validateTraceability({ ...unordered, tasks: [first, { ...second, scope: { ...second.scope, likelyFiles: ["src/other.ts"] } }] })).toEqual([]);
    expect(validateTraceability({ ...unordered, tasks: [first, { ...second, scope: { ...second.scope, likelyFiles: ["src/auth.ts", "src/other.ts"] }, filesNotToTouch: ["./src/auth.ts"] }] })).toEqual([]);
    expect(validateTraceability({ ...unordered, tasks: [first, { ...second, scope: { ...second.scope, likelyFiles: ["SRC/"] } }] })).toContainEqual(expect.objectContaining({ code: "SHARED_WRITE_SCOPE_UNORDERED" }));
    // Testing execution serialises shared writes with leases, so its plans are not refused.
    expect(validateTraceability({ ...unordered, mode: "testing" })).toEqual([]);
  });

  it("treats a glob in likelyFiles as the files it covers, so globs and files they match are ordered", async () => {
    // The check compared paths as text, so 'src/**/*.ts' never met 'src/auth.ts' and shared writes went unordered.
    const base = (await planSchema()).parse(plan()); const first = requiredAt(base.tasks, 0);
    const free = { dependsOn: [], blocks: [], conflictsWith: [] };
    const task = (id: string, likelyFiles: readonly string[]) => ({ ...first, id, dependencies: free, scope: { ...first.scope, likelyFiles: [...likelyFiles] } });
    const pair = (left: readonly string[], right: readonly string[]): TraceablePlan => { const tasks = [task("TASK-001", left), task("TASK-002", right)]; return { ...base, tasks, taskGraph: [], routingRecommendations: tasks.map(({ id }) => ({ taskId: id })) }; };
    const unordered = (left: readonly string[], right: readonly string[]) => validateTraceability(pair(left, right)).some(({ code }) => code === "SHARED_WRITE_SCOPE_UNORDERED");
    const overlapping: readonly (readonly [string, string])[] = [
      ["src/**/*.ts", "src/auth.ts"], ["src/*", "src/auth.ts"], ["src/*.ts", "src/**/*.ts"], ["*.md", "README.md"], ["*.md", "docs/guide.md"],
      ["packages/*/package.json", "packages/core/package.json"], ["packages/*/package.json", "packages/core/*.json"], ["src/**", "src/a/b.ts"],
      ["src/{auth,session}.ts", "src/session.ts"], ["src/auth.?s", "src/auth.ts"], ["src/[ab]uth.ts", "src/auth.ts"], ["src/*", "src/auth/login.ts"], ["**/*.test.ts", "test/auth.test.ts"],
    ];
    for (const [left, right] of overlapping) { expect(unordered([left], [right]), `${left} / ${right}`).toBe(true); expect(unordered([right], [left]), `${right} / ${left}`).toBe(true); }
    const disjoint: readonly (readonly [string, string])[] = [
      ["src/**/*.ts", "src/styles/app.css"], ["test/*.ts", "src/auth.ts"], ["src/a*.ts", "src/b*.ts"], ["*.md", "README.txt"], ["packages/*/package.json", "apps/cli/package.json"],
      ["src/{auth,session}.ts", "src/other.ts"], ["src/*.ts", "docs/**/*.ts"], ["src/auth.?s", "src/auth.tsx"],
    ];
    for (const [left, right] of disjoint) { expect(unordered([left], [right]), `${left} / ${right}`).toBe(false); expect(unordered([right], [left]), `${right} / ${left}`).toBe(false); }
    // The run orders them, and a glob dropped by filesNotToTouch (the same text) is not a write.
    const ordered = withSharedWritesOrdered(pair(["src/**/*.ts"], ["src/auth.ts"]));
    expect(ordered.taskGraph).toEqual([{ from: "TASK-001", to: "TASK-002" }]);
    expect(validateTraceability(ordered)).toEqual([]);
    const excluded = pair(["src/**/*.ts"], ["src/auth.ts"]);
    expect(validateTraceability({ ...excluded, tasks: [{ ...requiredAt(excluded.tasks, 0), filesNotToTouch: ["./src/**/*.ts"] }, requiredAt(excluded.tasks, 1)] })).toEqual([]);
  });

  it("reads a bare '.' in likelyFiles as the whole repository", async () => {
    // '.' met no file at all, so a task that names the whole repository went unordered beside every other.
    const unordered = await sharedWriteCheck();
    for (const [left, right] of [[".", "src/auth.ts"], ["./", "src/auth.ts"], [".", "."], [".", "src/**/*.ts"], [".", "*.md"]] as const) {
      expect(unordered(left, right), `${left} / ${right}`).toBe(true); expect(unordered(right, left), `${right} / ${left}`).toBe(true);
    }
  });

  it("subtracts filesNotToTouch from likelyFiles as the files it covers", async () => {
    // filesNotToTouch subtracted only an entry of the same text, so 'src/generated/**' left 'src/**' writing the
    // generated files, and the tasks writing them were ordered as if it did. An exclusion takes away what it covers and no more.
    const unordered = await sharedWriteCheck();
    const subtracted: readonly (readonly [string, string])[] = [
      ["src/** - src/generated/**", "src/generated/types.ts"], ["src/**/*.ts - src/generated", "src/generated/types.ts"], [". - docs", "docs/guide.md"],
      ["src/** - **/*.test.ts", "src/auth.test.ts"], ["src/** - src/auth.ts", "src/auth.ts"], ["src/auth.ts", "src/** - src/auth.ts"], ["src/** - src/*.ts", "src/*.ts"],
      ["src/** - src/{auth,session}.ts", "src/session.ts"], ["src/auth.ts", ". - ."],
    ];
    for (const [left, right] of subtracted) { expect(unordered(left, right), `${left} / ${right}`).toBe(false); expect(unordered(right, left), `${right} / ${left}`).toBe(false); }
    const overlapping: readonly (readonly [string, string])[] = [
      ["src/** - src/generated/**", "src/auth.ts"], [".", "src/a.ts - docs"], ["src/** - src/*.test.ts", "src/*.ts"], ["src/** - **/*.test.ts", "src/auth.ts"],
    ];
    for (const [left, right] of overlapping) { expect(unordered(left, right), `${left} / ${right}`).toBe(true); expect(unordered(right, left), `${right} / ${left}`).toBe(true); }
  });

  it("orders the tasks a plan leaves unordered on the same files, so no repair has to write the plan again", async () => {
    // Observed live (P20 pilot): a plan for 45 issues was refused for such pairs and written a second time.
    const base = (await planSchema()).parse(plan()); const first = requiredAt(base.tasks, 0);
    const free = { dependsOn: [], blocks: [], conflictsWith: [] };
    const task = (id: string, likelyFiles: readonly string[] = first.scope?.likelyFiles ?? []) => ({ ...first, id, dependencies: free, scope: { ...first.scope, likelyFiles: [...likelyFiles] } });
    const routed = (list: readonly { readonly id: string }[]) => list.map(({ id }) => ({ taskId: id }));
    const waits = (candidate: TraceablePlan) => candidate.tasks.map(({ dependencies }) => dependencies?.dependsOn);
    const tasks = [first, task("TASK-002"), task("TASK-003"), task("TASK-004", ["docs/unrelated.md"])];
    const unordered: TraceablePlan = { ...base, tasks, taskGraph: [], routingRecommendations: routed(tasks) };
    expect(validateTraceability(unordered)).toContainEqual(expect.objectContaining({ code: "SHARED_WRITE_SCOPE_UNORDERED" }));
    const ordered = withSharedWritesOrdered(unordered);
    // Each later task waits for the nearest earlier writer: one chain, and a task on other files stays free.
    expect(waits(ordered)).toEqual([[], ["TASK-001"], ["TASK-002"], []]);
    expect(ordered.taskGraph).toEqual([{ from: "TASK-001", to: "TASK-002" }, { from: "TASK-002", to: "TASK-003" }]);
    expect(validateTraceability(ordered)).toEqual([]);
    // The waiting task says why, so a critic does not take the edge for a functional dependency.
    const notes = ordered.tasks[1]?.context ?? [];
    expect(notes.filter((line) => line.startsWith(SHARED_WRITE_ORDER_NOTE))).toEqual([expect.stringContaining("waits for TASK-001 because both edit")]);
    // An order the plan states is kept, whichever way it runs, and a plan with nothing to order is returned as it is.
    const stated: TraceablePlan = { ...unordered, tasks: [{ ...first, dependencies: { ...free, dependsOn: ["TASK-003"] } }, task("TASK-002"), task("TASK-003")], taskGraph: [{ from: "TASK-003", to: "TASK-001" }], routingRecommendations: routed(tasks.slice(0, 3)) };
    const kept = withSharedWritesOrdered(stated);
    expect(waits(kept)).toEqual([["TASK-003"], ["TASK-001"], []]);
    expect(validateTraceability(kept)).toEqual([]);
    expect(withSharedWritesOrdered(ordered)).toBe(ordered);
    // A directory covers its files, and Testing plans are left to their write leases.
    expect(withSharedWritesOrdered({ ...unordered, tasks: [first, task("TASK-002", ["SRC/"])], routingRecommendations: routed(tasks.slice(0, 2)) }).taskGraph).toEqual([{ from: "TASK-001", to: "TASK-002" }]);
    const testing: TraceablePlan = { ...unordered, mode: "testing" };
    expect(withSharedWritesOrdered(testing)).toBe(testing);
  });

  it("completes the task graph and the dependencies from each other, so no repair has to write the plan again", async () => {
    // Observed live (P20 pilot): a plan section was refused for one dependsOn missing from taskGraph and written again.
    const base = (await planSchema()).parse(plan()); const first = requiredAt(base.tasks, 0);
    const free = { dependsOn: [], blocks: [], conflictsWith: [] };
    const second = { ...first, id: "TASK-002", dependencies: { ...free, dependsOn: [first.id] } };
    const third = { ...first, id: "TASK-003", dependencies: free, scope: { ...first.scope, likelyFiles: ["docs/unrelated.md"] } };
    const tasks = [first, second, third];
    const stated: TraceablePlan = { ...base, tasks, taskGraph: [], routingRecommendations: tasks.map(({ id }) => ({ taskId: id })) };
    expect(validateTraceability(stated)).toContainEqual(expect.objectContaining({ code: "INVALID_TASK_GRAPH" }));
    // A dependsOn missing from the graph is added to it, an edge only in the graph to the later task's dependsOn,
    // and an edge stated twice is kept once.
    const completed = withSharedWritesOrdered({ ...stated, taskGraph: [{ from: second.id, to: third.id }, { from: second.id, to: third.id }] });
    expect(completed.taskGraph).toEqual([{ from: second.id, to: third.id }, { from: first.id, to: second.id }]);
    expect(completed.tasks.map(({ dependencies }) => dependencies?.dependsOn)).toEqual([[], [first.id], [second.id]]);
    expect(validateTraceability(completed)).toEqual([]);
    expect(withSharedWritesOrdered(completed)).toBe(completed);
    // An edge to an unknown task is not made up for: the full check still reports it.
    expect(validateTraceability(withSharedWritesOrdered({ ...stated, taskGraph: [{ from: first.id, to: second.id }, { from: first.id, to: "TASK-404" }] }))).toEqual([expect.objectContaining({ code: "INVALID_TASK_GRAPH", message: "Invalid dependency TASK-001 -> TASK-404." })]);
    // Testing plans have no shared-write ordering, but their two statements of order are made to agree as well.
    expect(withSharedWritesOrdered({ ...stated, mode: "testing" }).taskGraph).toEqual([{ from: first.id, to: second.id }]);
  });

  it("returns the ordered plan from the node instead of failing the stage", async () => {
    const base = plan(); const first = requiredAt(base.tasks, 0);
    const raw = { ...base, tasks: [first, { ...first, id: "TASK-002" }], routingRecommendations: [...base.routingRecommendations, { ...requiredAt(base.routingRecommendations, 0), taskId: "TASK-002" }] };
    const node = plannerNode({ protocolVersion: "1.0.0", protocolHash: "a".repeat(64), schema: await planSchema(), runtime: { async plan() { return raw; } } });
    const result = await node.run(input());
    expect(result.plan.tasks[1]?.dependencies?.dependsOn).toEqual(["TASK-001"]);
    expect(result.plan.taskGraph).toEqual([{ from: "TASK-001", to: "TASK-002" }]);
  });
});

async function planSchema(): Promise<PlannerSchema<TraceablePlan>> { const moduleUrl = new URL("../../../schemas/src/plan.ts", import.meta.url).href; const loaded = await import(moduleUrl) as { planIRSchema: PlannerSchema<TraceablePlan> }; return loaded.planIRSchema; }
function input(): PlannerInput { return { projectContext: { language: "TypeScript" }, canonicalIssues: [{ candidateId: "C-1", disposition: "accepted", claim: { trust: "untrusted_data", title: "Authorization bypass", description: "Header bypasses role checks." }, sourceFindingIds: ["auditor-a/SEC-1"] }], repositoryContext: [{ ref: "artifact:auth", trust: "repo", content: "bounded source context" }], constraints: ["No production writes during planning"], workflowGoal: "Fix accepted issues with mechanical verification.", premiseReport: { status: "positive", interpretation: "smoke_test_only_not_proof", limitations: ["One fixture is not proof."] } }; }
function plan() {
  return { schemaVersion: 1, id: "PLAN-1", title: "Premise fixture remediation", mode: "audit", reasoningOutcome: "Fix the authorization boundary first.", implementationStrategy: ["Enforce authenticated role checks and add regression coverage."], dependencies: [], acceptedIssueIds: ["C-1"], unresolvedQuestions: [] as Array<{ id: string; question: string; blocking: boolean; blastRadius: "low" | "medium" | "high" }>, validationContract: { schemaVersion: 1, validation: [{ id: "VAL-001", assertion: "Support headers cannot bypass authorization.", evidence: ["authorization regression test"] }] }, tasks: [{ schemaVersion: 1, id: "TASK-001", title: "Close authorization bypass", goal: { objective: "Enforce authorization", doneWhen: ["Header cannot bypass"], stopWhen: ["Regression passes"], blockedWhen: ["Identity unavailable"] }, addresses: { issues: ["C-1"], validation: ["VAL-001"], requirements: [] as string[] }, routing: { capability: "frontier", effort: "high", advisor: null, advisorMaxUses: null, reason: ["securitySensitivity:4"] }, dependencies: { dependsOn: [], blocks: [], conflictsWith: [] }, scope: { likelyFiles: ["src/auth.ts", "test/auth.test.ts"], components: ["authorization"], interfaces: ["authorize"] }, filesNotToTouch: [], readFirst: ["src/auth.ts"], context: [] as string[], invariants: ["Deny by default"], outOfScope: ["Identity redesign"], implementationGuidance: ["Keep tests with behavior"], acceptanceCriteria: ["Bypass rejected"], verification: { preconditions: [], commands: [{ command: "pnpm test", expectedExitCode: 0, executionPolicy: "derived_repository_script" }], checks: ["Regression is deterministic"] }, rollbackPlan: ["Revert guard"], escalateIf: ["Identity source ambiguous"], expectedEvidence: ["test output"], estimatedTurns: 2 }], taskGraph: [], traceability: { issueToValidation: [{ issueId: "C-1", validationIds: ["VAL-001"] }], requirementLinks: { schemaVersion: 1, links: [] as Array<{ requirementId: string; validationIds: string[]; taskIds: string[] }> } }, routingRecommendations: [{ taskId: "TASK-001", capability: "frontier", effort: "high", reason: ["securitySensitivity:4"] }], rolloutConcerns: [], migrationConcerns: [], premiseReport: { status: "positive", interpretation: "smoke_test_only_not_proof", limitations: ["One fixture is not proof."] } };
}
function requiredAt<T>(values: readonly T[], index: number): T { const value = values[index]; if (value === undefined) throw new RangeError(`Missing test value at index ${index}`); return value; }
/** Whether two unordered tasks are refused as writing the same files. Each side reads "likely file - file not to touch". */
async function sharedWriteCheck(): Promise<(left: string, right: string) => boolean> {
  const base = (await planSchema()).parse(plan()); const first = requiredAt(base.tasks, 0);
  const task = (id: string, side: string) => {
    const [likely = "", excluded] = side.split(" - ");
    return { ...first, id, dependencies: { dependsOn: [], blocks: [], conflictsWith: [] }, scope: { ...first.scope, likelyFiles: [likely] }, filesNotToTouch: excluded === undefined ? [] : [excluded] };
  };
  return (left, right) => {
    const tasks = [task("TASK-001", left), task("TASK-002", right)];
    return validateTraceability({ ...base, tasks, taskGraph: [], routingRecommendations: tasks.map(({ id }) => ({ taskId: id })) }).some(({ code }) => code === "SHARED_WRITE_SCOPE_UNORDERED");
  };
}

describe("planner self-references", () => {
  it("drops only a task's references to itself before validation", () => {
    const raw = { mode: "feature", taskGraph: [{ from: "TASK-1", to: "TASK-1" }, { from: "TASK-1", to: "TASK-2" }],
      tasks: [{ id: "TASK-1", dependencies: { dependsOn: ["TASK-1"], blocks: ["TASK-1", "TASK-2"], conflictsWith: [] } }, { id: "TASK-2", dependencies: { dependsOn: ["TASK-1"], blocks: [], conflictsWith: ["TASK-2", "TASK-3"] } }] };
    expect(withoutSelfReferences(raw)).toEqual({ mode: "feature", taskGraph: [{ from: "TASK-1", to: "TASK-2" }],
      tasks: [{ id: "TASK-1", dependencies: { dependsOn: [], blocks: ["TASK-2"], conflictsWith: [] } }, { id: "TASK-2", dependencies: { dependsOn: ["TASK-1"], blocks: [], conflictsWith: ["TASK-3"] } }] });
    expect(withoutSelfReferences("not a plan")).toBe("not a plan");
    expect(withoutSelfReferences({ tasks: [{ id: "A" }] })).toEqual({ tasks: [{ id: "A" }] });
  });
});
