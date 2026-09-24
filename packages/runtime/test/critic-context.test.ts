import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { planIRSchema, type PlanIR } from "@arbitra/schemas/plan.js";
import { criticContextParts } from "../src/critic-context.js";

async function plan() {
  const original = planIRSchema.parse(JSON.parse(await readFile(new URL("../../schemas/test/golden/plan-ir.valid.json", import.meta.url), "utf8")));
  const task = original.tasks[0]; if (task === undefined) throw new Error("FIXTURE_TASK_ABSENT");
  return { ...original, tasks: [task, { ...task, id: "TASK-002" }, { ...task, id: "TASK-003" }] };
}

describe("critic context partitioning", () => {
  it.each(["missing", "unknown", "duplicate"])("rejects %s revision resolutions before allocating review context", async (mode) => {
    const resolutions = mode === "missing" ? [] : mode === "unknown" ? [{ critiqueItemId: "unknown", resolution: "Claim" }] : [{ critiqueItemId: "feedback-1", resolution: "Claim" }, { critiqueItemId: "feedback-1", resolution: "Duplicate" }];
    let allocations = 0;
    await expect(criticContextParts(await plan(), [], [], async () => { allocations += 1; return true; }, {
      priorCritique: { summary: "Prior review", items: [{ id: "feedback-1", category: "weak_verification", blocking: true, summary: "Missing regression", taskIds: ["TASK-001"], issueIds: [] }] }, proposedResolutions: resolutions,
    })).rejects.toThrow("INVALID_CRITIC_REVISION_CONTEXT");
    expect(allocations).toBe(0);
  });

  it("keeps each prior critique paired with its resolution and covers every current record", async () => {
    const original = await plan();
    const revisionContext = { priorCritique: { summary: "Initial critique", items: [{ id: "feedback-1", category: "weak_verification" as const, blocking: true, summary: "Missing regression", taskIds: ["TASK-001"], issueIds: [] }] }, proposedResolutions: [{ critiqueItemId: "feedback-1", resolution: "Added regression coverage" }] };
    const parts = await criticContextParts(original, [], [], async ({ recordIds }) => recordIds.length <= 2, revisionContext);
    const primary = parts.filter(({ kind }) => kind === "review").flatMap(({ recordIds }) => recordIds);
    expect(primary).toContain("revision-summary"); expect(primary).toContain("revision:feedback-1");
    for (const id of primary) expect(parts.some(({ recordIds }) => recordIds.includes(id) && recordIds.includes("revision:feedback-1"))).toBe(true);
    for (const part of parts) {
      const context = (part.input as { revisionContext: typeof revisionContext }).revisionContext;
      if (part.recordIds.includes("revision:feedback-1")) {
        expect(context.priorCritique.items).toEqual(revisionContext.priorCritique.items);
        expect(context.proposedResolutions).toEqual(revisionContext.proposedResolutions);
      } else { expect(context.priorCritique.items).toEqual([]); expect(context.proposedResolutions).toEqual([]); }
    }
  });

  it("keeps complete records and global relationships with exhaustive pair coverage", async () => {
    const original = await plan();
    const parts = await criticContextParts(original, [], [], async ({ recordIds }) => recordIds.length <= 2);
    const records = parts.filter(({ kind }) => kind === "review").flatMap(({ recordIds }) => recordIds);
    expect(records).toEqual(["task:TASK-001", "task:TASK-002", "task:TASK-003", "validation:VAL-001"]);
    for (const left of records) for (const right of records) expect(parts.some(({ recordIds }) => recordIds.includes(left) && recordIds.includes(right))).toBe(true);
    for (const part of parts) {
      const input = part.input as { plan: PlanIR; reviewScope: { completePlan: boolean; globalIndex: { tasks: unknown[] } } };
      expect(input.reviewScope.completePlan).toBe(false);
      expect(input.reviewScope.globalIndex.tasks).toHaveLength(3);
      expect(input.plan.traceability).toEqual(original.traceability);
      expect(input.plan.taskGraph).toEqual(original.taskGraph);
      for (const task of input.plan.tasks) expect(task).toEqual(original.tasks.find(({ id }) => id === task.id));
    }
  });

  it("reviews supplemental requirement records and segments a pair of records that cannot share a context", async () => {
    const original = await plan();
    const requirements = [{ id: "acc-1", assertion: "A".repeat(1_800) }, { id: "acc-2", assertion: "B".repeat(1_800) }];
    const size = (part: { input: unknown }) => JSON.stringify(part.input).length;
    const base = size({ input: (await criticContextParts(original, [], [], async () => true, null, 1, {}))[0]?.input });
    const parts = await criticContextParts(original, [], [], async (part) => part.kind !== "full" && size(part) <= base + 2_000, null, 20, { requirements });
    const reviewed = parts.filter(({ kind }) => kind === "review").flatMap(({ recordIds }) => recordIds);
    expect(reviewed).toEqual(expect.arrayContaining(["requirements:acc-1", "requirements:acc-2"]));
    for (const left of reviewed) for (const right of reviewed) expect(parts.some(({ recordIds }) => recordIds.includes(left) && recordIds.includes(right))).toBe(true);
    const segments = parts.filter(({ segment, recordIds }) => segment !== undefined && recordIds.includes("requirements:acc-1") && recordIds.includes("requirements:acc-2"));
    expect(segments.length).toBeGreaterThan(1);
    const record = segments[0]?.segment?.candidateId;
    const other = record === "requirements:acc-1" ? requirements[1] : requirements[0];
    const text = segments.map(({ input }) => (input as { segmentedRecord: { exactJsonText: string } }).segmentedRecord.exactJsonText).join("");
    expect(text).toBe(JSON.stringify(requirements.find(({ id }) => `requirements:${id}` === record)));
    for (const { input } of segments) expect((input as { requirements: unknown[] }).requirements).toEqual([other]);
  });

  it("retains the one-call path when the plan fits", async () => {
    const original = await plan();
    const parts = await criticContextParts(original, [], [], async () => true);
    expect(parts).toHaveLength(1); expect(parts[0]?.kind).toBe("full");
    expect(parts[0]?.input).toMatchObject({ plan: original });
  });

  it("fails explicitly when required global context cannot fit", async () => {
    await expect(criticContextParts(await plan(), [], [], async () => false)).rejects.toThrow("CONTEXT_LIMIT_EXCEEDED");
  });
});
