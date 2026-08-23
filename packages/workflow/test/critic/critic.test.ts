import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { criticNode, CRITIQUE_CATEGORIES, criticRequired, selectCritic, type CritiqueItem, type StructuredCritique } from "../../src/nodes/critic/index.js";
import { revisePlanOnce } from "../../src/nodes/revision.js";

const protocolHash = "b".repeat(64);
const planner = { id: "planner", capability: "balanced", independenceGroup: "group-a" } as const;
const input = { plan: { tasks: [{ id: "TASK-1" }] }, validationContract: { assertions: ["VAL-1"] }, canonicalIssues: [{ candidateId: "ISSUE-1" }], necessaryContext: [] } as const;
const mapped: CritiqueItem = { id: "CRIT-1", category: "weak_verification", blocking: false, summary: "Add a failure-path assertion.", taskIds: ["TASK-1"], issueIds: [] };

describe("critic requirement and capability selection", () => {
  it.each([
    "hasCriticalIssue", "hasHighSecurityIssue", "schemaOrDatabaseMigration", "deploymentArchitectureChange",
    "authenticationRedesign", "majorCrossServiceChange", "largeTaskGraph", "deepMode",
  ] as const)("makes %s independently mandatory", (condition) => {
    expect(criticRequired({ [condition]: true })).toMatchObject({ required: true, reasons: [expect.any(String)] });
  });

  it("is not mandatory with no condition", () => expect(criticRequired({})).toEqual({ required: false, reasons: [] }));

  it("prefers an independent equal-or-greater critic and records rejected alternatives", () => {
    expect(selectCritic([
      { id: "weak", capability: "fast", independenceGroup: "group-b", available: true },
      { id: "same", capability: "balanced", independenceGroup: "group-a", available: true },
      { id: "independent", capability: "balanced", independenceGroup: "group-b", available: true },
    ], planner)).toMatchObject({ kind: "selected", critic: { id: "independent" }, reducedIndependence: false, rejectedAlternatives: [
      { id: "weak", reason: "capability_below_planner" },
      { id: "same", reason: "not_preferred_independence_group" },
    ] });
  });

  it("skips honestly with degraded coverage rather than choosing a weak critic", () => {
    expect(selectCritic([{ id: "weak", capability: "fast", independenceGroup: "group-b", available: true }], planner)).toEqual({ kind: "skipped", reason: "no_available_critic_at_or_above_planner_capability", degradedReviewCoverage: true, rejectedAlternatives: [{ id: "weak", reason: "capability_below_planner" }] });
  });
});

describe("structured critic and conditional revision", () => {
  it("pins all fourteen protocol categories", () => expect(CRITIQUE_CATEGORIES).toHaveLength(14));

  it("ships a versioned protocol containing every mechanical review category and mapping rule", () => {
    const protocol = readFileSync(new URL("../../../protocols/assets/plan-critic/1.0.0/protocol.md", import.meta.url), "utf8");
    for (const category of ["missing issues", "incomplete requirements", "wrong dependencies", "unsafe parallelisation", "migration hazards", "weak acceptance criteria", "weak verification", "too large or fragmented", "hidden architecture decisions", "incorrect capability routing", "regressions", "conflicting scopes", "missing rollout considerations", "invariant violations"]) expect(protocol).toContain(category);
    expect(protocol).toContain("at least one known task ID or canonical issue ID");
  });

  it("records the skip and makes no call when no qualifying critic exists", async () => {
    const critique = vi.fn(); const node = criticNode({ protocolVersion: "1.0.0", protocolHash, runtime: { critique }, schema: schema({ items: [], summary: "clear" }) });
    await expect(node.run(input, { requirement: { deepMode: true }, planner, pool: [{ id: "weak", capability: "fast", independenceGroup: "group-b", available: true }] })).resolves.toMatchObject({ status: "skipped", degradedReviewCoverage: true, criticCalls: 0 });
    expect(critique).not.toHaveBeenCalled();
  });

  it("rejects an unmapped item before revision", async () => {
    const unmapped = { ...mapped, id: "CRIT-UNMAPPED", taskIds: [], issueIds: [] };
    const node = criticNode({ protocolVersion: "1.0.0", protocolHash, runtime: { critique: vi.fn().mockResolvedValue({}) }, schema: schema({ items: [mapped, unmapped], summary: "review" }) });
    const result = await node.run(input, { requirement: { deepMode: true }, planner, pool: [{ id: "critic", capability: "frontier", independenceGroup: "group-b", available: true }] });
    expect(result).toMatchObject({ status: "completed", critique: { items: [mapped] }, rejected: [{ item: { id: "CRIT-UNMAPPED" }, code: "UNACTIONABLE_CRITIQUE_ITEM", reason: "unactionable_no_task_or_issue" }], criticCalls: 1 });
  });

  it("skips revision for non-blocking findings", async () => {
    const revise = vi.fn();
    await expect(revisePlanOnce("goal", input.plan, [mapped], { profile: "planner" }, { revise })).resolves.toMatchObject({ plan: input.plan, resolutions: [], revisionCalls: 0 });
    expect(revise).not.toHaveBeenCalled();
  });

  it("performs exactly one revision and requires every blocking item to be resolved", async () => {
    const blocking = [{ ...mapped, id: "CRIT-B1", blocking: true }, { ...mapped, id: "CRIT-B2", blocking: true }];
    const revise = vi.fn().mockResolvedValue({ plan: { tasks: [{ id: "TASK-1" }], revised: true }, resolutions: blocking.map(({ id }) => ({ critiqueItemId: id, resolution: "resolved" })) });
    await expect(revisePlanOnce("original goal", input.plan, blocking, { profile: "same-planner" }, { revise })).resolves.toMatchObject({ revisionCalls: 1, resolutions: [{ critiqueItemId: "CRIT-B1" }, { critiqueItemId: "CRIT-B2" }] });
    expect(revise).toHaveBeenCalledTimes(1);
    expect(revise.mock.calls[0]?.[0]).toMatchObject({ originalGoal: "original goal", plannerConfiguration: { profile: "same-planner" } });
    await expect(revisePlanOnce("goal", input.plan, blocking, {}, { revise: vi.fn().mockResolvedValue({ plan: input.plan, resolutions: [{ critiqueItemId: "CRIT-B1", resolution: "only one" }] }) })).rejects.toThrow(/EVERY_BLOCKING/u);
    await expect(revisePlanOnce("goal", input.plan, [blocking[0]!], {}, { revise: vi.fn().mockResolvedValue({ plan: input.plan, resolutions: [{ critiqueItemId: "CRIT-B1", resolution: "" }] }) })).rejects.toThrow(/EVERY_BLOCKING/u);
    await expect(revisePlanOnce("goal", input.plan, [blocking[0]!], {}, { revise: vi.fn().mockResolvedValue({ plan: input.plan, resolutions: [{ critiqueItemId: "CRIT-B1", resolution: "one" }, { critiqueItemId: "CRIT-B1", resolution: "duplicate" }] }) })).rejects.toThrow(/EVERY_BLOCKING/u);
  });
});

function schema(value: StructuredCritique) { return { parse() { return value; } }; }
