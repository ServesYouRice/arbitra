import { expect, it } from "vitest";
import { testingPlanExecutionOptionsSchema } from "../src/testing-executor.js";

function options() {
  return { authorization: { maximumParallelTasks: 2, partitions: [{ id: "tests", paths: ["tests/session.ts"] }], tasks: [{ taskId: "TASK-001", partitionId: "tests", exclusive: false }] },
    verification: { execution: { driver: "docker", image: `local/node@sha256:${"a".repeat(64)}`, maximumRuns: 8, checks: [{ id: "test", executable: "/usr/bin/node", arguments: ["--test"], sourcePaths: ["tests/session.ts"] }] },
      bindings: [{ command: "node --test", checkId: "test", authorization: "allowlisted", expectedExitCode: 0 }] },
    models: { fast: "writer", balanced: "writer", frontier: "reviewer" }, maximumAttempts: 4 };
}

it("accepts explicit execution authority and returns an isolated validated configuration", () => {
  const input = options(); const parsed = testingPlanExecutionOptionsSchema.parse(input);
  input.authorization.partitions.push({ id: "extra", paths: ["production.ts"] });
  expect(parsed.authorization.partitions).toHaveLength(1);
  expect(parsed.models.frontier).toBe("reviewer");
});

it.each(["partition", "duplicate-partition", "duplicate-task", "unknown-field", "cap", "missing-frontier"])("rejects invalid trusted execution configuration: %s", (scenario) => {
  const input = options();
  if (scenario === "partition") input.authorization.tasks = [{ taskId: "TASK-001", partitionId: "unknown", exclusive: false }];
  if (scenario === "duplicate-partition") input.authorization.partitions.push({ id: "tests", paths: ["other.test.ts"] });
  if (scenario === "duplicate-task") input.authorization.tasks.push({ taskId: "TASK-001", partitionId: "tests", exclusive: true });
  if (scenario === "cap") input.maximumAttempts = 11;
  const value = scenario === "unknown-field" ? { ...input, shell: true } : scenario === "missing-frontier" ? { ...input, models: { fast: "writer", balanced: "writer" } } : input;
  expect(() => testingPlanExecutionOptionsSchema.parse(value)).toThrow();
});
