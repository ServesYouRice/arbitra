import { expect, it } from "vitest";
import { featureExecutionSchema } from "../src/feature-execution.js";

it("defaults to one bounded requirements revision and rejects unbounded settings", () => {
  const settings = { request: "Feature", mode: "automatic", roles: { requirements: "a", exploration: "a", planner: "b" } };
  expect(featureExecutionSchema.parse(settings).maximumRequirementsRevisions).toBe(1);
  expect(featureExecutionSchema.parse({ ...settings, maximumRequirementsRevisions: 0 }).maximumRequirementsRevisions).toBe(0);
  for (const maximumRequirementsRevisions of [-1, 4, 1.5, "1"]) expect(featureExecutionSchema.safeParse({ ...settings, maximumRequirementsRevisions }).success).toBe(false);
});
