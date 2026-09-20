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
