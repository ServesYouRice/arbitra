import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { plannerNode, type PlannerInput, type PlannerRequest, type PlannerSchema } from "../../src/nodes/planner/node.js";
import { validateTraceability, type TraceablePlan } from "../../src/nodes/planner/traceability.js";

describe("single coherent Planner", () => {
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

describe("fourteen-dimensional difficulty routing", () => {
  it("uses all dimensions, never file count, and independently recommends capability and effort", async () => {
    const { DIFFICULTY_DIMENSIONS, scoreDifficulty } = await difficultyModule();
    expect(DIFFICULTY_DIMENSIONS).toHaveLength(14); expect(DIFFICULTY_DIMENSIONS).not.toContain("fileCount");
    const signals = Object.fromEntries(DIFFICULTY_DIMENSIONS.map((dimension: string) => [dimension, 2])) as Record<string, 0 | 1 | 2 | 3 | 4>; signals.securitySensitivity = 4;
    const result = scoreDifficulty({ signals });
    expect(result.dimensions).toEqual(signals);
    expect(result.recommendation).toMatchObject({ capability: "frontier", effort: "high", reason: expect.arrayContaining(["securitySensitivity:4"]) });
    expect(result.recommendation).not.toHaveProperty("model");
  });
});

async function planSchema(): Promise<PlannerSchema<TraceablePlan>> { const moduleUrl = new URL("../../../schemas/src/plan.ts", import.meta.url).href; const loaded = await import(moduleUrl) as { planIRSchema: PlannerSchema<TraceablePlan> }; return loaded.planIRSchema; }
async function difficultyModule(): Promise<{ DIFFICULTY_DIMENSIONS: readonly string[]; scoreDifficulty(task: { signals: Record<string, 0 | 1 | 2 | 3 | 4> }): { dimensions: unknown; recommendation: { capability: string; effort: string; reason: readonly string[] } } }> { const moduleUrl = new URL("../../../core/src/routing/difficulty.ts", import.meta.url).href; return await import(moduleUrl) as never; }
function input(): PlannerInput { return { projectContext: { language: "TypeScript" }, canonicalIssues: [{ candidateId: "C-1", disposition: "accepted", claim: { trust: "untrusted_data", title: "Authorization bypass", description: "Header bypasses role checks." }, sourceFindingIds: ["auditor-a/SEC-1"] }], repositoryContext: [{ ref: "artifact:auth", trust: "repo", content: "bounded source context" }], constraints: ["No production writes during planning"], workflowGoal: "Fix accepted issues with mechanical verification.", premiseReport: { status: "positive", interpretation: "smoke_test_only_not_proof", limitations: ["One fixture is not proof."] } }; }
function plan() {
  return { schemaVersion: 1, id: "PLAN-1", title: "Premise fixture remediation", mode: "audit", reasoningOutcome: "Fix the authorization boundary first.", implementationStrategy: ["Enforce authenticated role checks and add regression coverage."], dependencies: [], acceptedIssueIds: ["C-1"], unresolvedQuestions: [] as Array<{ id: string; question: string; blocking: boolean; blastRadius: "low" | "medium" | "high" }>, validationContract: { schemaVersion: 1, validation: [{ id: "VAL-001", assertion: "Support headers cannot bypass authorization.", evidence: ["authorization regression test"] }] }, tasks: [{ schemaVersion: 1, id: "TASK-001", title: "Close authorization bypass", goal: { objective: "Enforce authorization", doneWhen: ["Header cannot bypass"], stopWhen: ["Regression passes"], blockedWhen: ["Identity unavailable"] }, addresses: { issues: ["C-1"], validation: ["VAL-001"], requirements: [] as string[] }, routing: { capability: "frontier", effort: "high", advisor: null, advisorMaxUses: null, reason: ["securitySensitivity:4"] }, dependencies: { dependsOn: [], blocks: [], conflictsWith: [] }, scope: { likelyFiles: ["src/auth.ts", "test/auth.test.ts"], components: ["authorization"], interfaces: ["authorize"] }, filesNotToTouch: [], readFirst: ["src/auth.ts"], context: [] as string[], invariants: ["Deny by default"], outOfScope: ["Identity redesign"], implementationGuidance: ["Keep tests with behavior"], acceptanceCriteria: ["Bypass rejected"], verification: { preconditions: [], commands: [{ command: "pnpm test", expectedExitCode: 0, executionPolicy: "derived_repository_script" }], checks: ["Regression is deterministic"] }, rollbackPlan: ["Revert guard"], escalateIf: ["Identity source ambiguous"], expectedEvidence: ["test output"], estimatedTurns: 2 }], taskGraph: [], traceability: { issueToValidation: [{ issueId: "C-1", validationIds: ["VAL-001"] }], requirementLinks: { schemaVersion: 1, links: [] as Array<{ requirementId: string; validationIds: string[]; taskIds: string[] }> } }, routingRecommendations: [{ taskId: "TASK-001", capability: "frontier", effort: "high", reason: ["securitySensitivity:4"] }], rolloutConcerns: [], migrationConcerns: [], premiseReport: { status: "positive", interpretation: "smoke_test_only_not_proof", limitations: ["One fixture is not proof."] } };
}
function requiredAt<T>(values: readonly T[], index: number): T { const value = values[index]; if (value === undefined) throw new RangeError(`Missing test value at index ${index}`); return value; }
