import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { planIRSchema } from "@arbitra/schemas/plan.js";
import { testInventory } from "@arbitra/workflow/nodes/test-inventory.js";
import { testingWriteSchedule, type TestingWriteAuthorization } from "../src/testing-write-schedule.js";

function fixture() {
  const plan = planIRSchema.parse(JSON.parse(readFileSync(new URL("../../schemas/test/golden/plan-ir.valid.json", import.meta.url), "utf8")));
  plan.mode = "testing"; plan.acceptedIssueIds = []; plan.traceability.issueToValidation = [];
  const first = plan.tasks[0]; if (first === undefined) throw new Error("FIXTURE_TASK_ABSENT");
  plan.tasks = ["001", "002", "003", "004"].map((number) => ({ ...structuredClone(first), id: `TASK-${number}`, addresses: { issues: [], requirements: ["gap"], validation: ["VAL-001"] }, scope: { likelyFiles: [`tests/${number}.ts`], interfaces: [], components: [] } }));
  plan.routingRecommendations = plan.tasks.map((task) => ({ taskId: task.id, capability: task.routing.capability, effort: task.routing.effort, reason: task.routing.reason }));
  plan.traceability.requirementLinks.links = [{ requirementId: "gap", taskIds: plan.tasks.map(({ id }) => id), validationIds: ["VAL-001"] }];
  const inventory = testInventory([{ path: "src/auth.ts", kind: "file" }]);
  const authorization: TestingWriteAuthorization = { maximumParallelTasks: 4, partitions: [{ id: "tests", paths: [...plan.tasks.flatMap(({ scope }) => scope.likelyFiles), "tests/shared.ts"] }], tasks: plan.tasks.map(({ id }) => ({ taskId: id, partitionId: "tests", exclusive: false })) };
  return { plan, inventory, authorization };
}

it("schedules non-overlapping tests in parallel after prerequisites", () => {
  const { plan, inventory, authorization } = fixture();
  const first = plan.tasks[0]; const second = plan.tasks[1]; if (first === undefined || second === undefined) throw new Error("FIXTURE_TASK_ABSENT");
  first.dependencies.blocks = [second.id]; second.dependencies.dependsOn = [first.id]; plan.taskGraph = [{ from: first.id, to: second.id }];
  const schedule = testingWriteSchedule(plan, inventory, authorization);
  expect(schedule.batches.map((batch) => batch.map(({ taskId }) => taskId))).toEqual([["TASK-001", "TASK-003", "TASK-004"], ["TASK-002"]]);
  expect(testingWriteSchedule(plan, inventory, authorization)).toEqual(schedule);
});

it("serializes shared fixture paths, declared conflicts and exclusive preparation", () => {
  const { plan, inventory, authorization } = fixture();
  for (const task of plan.tasks.slice(0, 2)) task.scope.likelyFiles.push("tests/shared.ts");
  const third = plan.tasks[2]; if (third === undefined) throw new Error("FIXTURE_TASK_ABSENT");
  third.dependencies.conflictsWith = ["TASK-004"];
  expect(testingWriteSchedule(plan, inventory, authorization).batches.map((batch) => batch.map(({ taskId }) => taskId))).toEqual([["TASK-001", "TASK-003"], ["TASK-002", "TASK-004"]]);
  const exclusive = { ...authorization, tasks: authorization.tasks.map((task) => ({ ...task, exclusive: task.taskId === "TASK-001" })) };
  expect(testingWriteSchedule(plan, inventory, exclusive).batches[0]?.map(({ taskId }) => taskId)).toEqual(["TASK-001"]);
  expect(testingWriteSchedule(plan, inventory, { ...authorization, maximumParallelTasks: 1 }).batches).toHaveLength(4);
});

it("rejects incomplete authority and unauthorized later writes before returning any schedule", () => {
  const { plan, inventory, authorization } = fixture();
  expect(() => testingWriteSchedule(plan, inventory, { ...authorization, tasks: authorization.tasks.slice(1) })).toThrow("TESTING_WRITE_AUTHORIZATION_INCOMPLETE");
  const last = plan.tasks.at(-1); if (last === undefined) throw new Error("FIXTURE_TASK_ABSENT");
  last.scope.likelyFiles.push("tests/unapproved.ts");
  expect(() => testingWriteSchedule(plan, inventory, authorization)).toThrow("WRITE_SCOPE_REQUIRES_APPROVAL");
  last.scope.likelyFiles = ["src/auth.ts"];
  expect(() => testingWriteSchedule(plan, inventory, authorization)).toThrow("TESTING_EXECUTION_PRODUCTION_WRITE_FORBIDDEN");
});

it("rejects invalid dependencies and blocking decisions", () => {
  const { plan, inventory, authorization } = fixture();
  plan.taskGraph.push({ from: "unknown", to: "TASK-001" });
  expect(() => testingWriteSchedule(plan, inventory, authorization)).toThrow("TESTING_EXECUTION_PLAN_INVALID");
  plan.taskGraph = []; plan.unresolvedQuestions.push({ id: "open", question: "Choose behavior", blastRadius: "high", blocking: true });
  expect(() => testingWriteSchedule(plan, inventory, authorization)).toThrow("TESTING_EXECUTION_PLAN_INVALID");
});
