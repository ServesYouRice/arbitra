import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { controlPlaneCore } from "@arbitra/runtime/control-plane-core.js";
import { Orchestrator } from "@arbitra/runtime/orchestrator.js";
import { registerHandoffRoutes } from "../src/handoff.js";
import { buildServer } from "../src/main.js";

const task = (id: string, capability: "frontier" | "balanced" | "fast", dependsOn: string[] = []) => ({
  id, title: `Fix ${id}`, goal: { objective: `Objective of ${id}`, doneWhen: ["the defect is gone"] }, addresses: { issues: ["C-1"], validation: [] },
  routing: { capability, effort: "high", reason: [] }, dependencies: { dependsOn }, scope: { likelyFiles: ["src/a.ts"] },
  filesNotToTouch: [], readFirst: [], context: ["`undoAll()` replays the steps."], invariants: [], outOfScope: [], implementationGuidance: ["Change it."], acceptanceCriteria: ["Tests pass."],
  verification: { preconditions: [], commands: [], checks: [] }, rollbackPlan: [],
});

/** A run with a plan, as the orchestrator reads it back: two tasks, one question, one report to check after them. */
function planRun(repository: string, withPlan = true): Orchestrator {
  const content: Record<string, unknown> = {
    ...(withPlan ? { "plan-ir": { title: "Plan", tasks: [task("TASK-2", "fast", ["TASK-1"]), task("TASK-1", "frontier")], unresolvedQuestions: [{ id: "Q-1", question: "Which way?", blocking: true }] } } : {}),
    "canonical-issues": { issues: [{ candidateId: "C-1", severity: "high", disposition: "accepted", claim: { title: "A defect", description: "It breaks." } },
      { candidateId: "C-2", severity: "medium", disposition: "needs_verification", verificationOutcome: "STILL_NEEDS_VERIFICATION", claim: { title: "A report to check", description: "It may break." } }] },
  };
  return { overview: async () => ({ repository, workflowId: "audit-deep" }), repositoryMatches: async () => true, modules: async () => [],
    artifacts: async () => Object.keys(content).map((kind) => ({ kind, artifactId: kind })), artifact: async (_runId: string, id: string) => ({ content: JSON.stringify(content[id]) }) } as unknown as Orchestrator;
}

describe("the plan's hand-over routes", () => {
  it("saves the plan with what the premise check did not find, lists it with those counts, and outlines the order of work", async () => {
    const repository = await mkdtemp(join(tmpdir(), "arbitra-handoff-"));
    const app = buildServer(controlPlaneCore(new Orchestrator({ repository })));
    registerHandoffRoutes(app, planRun(repository));
    try {
      await mkdir(join(repository, "src"));
      await writeFile(join(repository, "src", "a.ts"), "export const a = 1;\n");
      const saved = await app.inject({ method: "POST", url: "/handoff/runs/run-12345678-abcd" });
      expect(saved.statusCode).toBe(200);
      const body = saved.json<{ directory: string; files: string[]; premises: { named: number; notFound: number; prompts: number } }>();
      // `undoAll` is in both prompts and in no code.
      expect(body.premises).toMatchObject({ notFound: 2, prompts: 2 });
      expect(body.premises.named).toBeGreaterThanOrEqual(body.premises.notFound);
      const listed = (await app.inject({ method: "GET", url: "/handoff/runs/run-12345678-abcd" })).json<{ saved: { directory: string; premises: unknown }[] }>();
      expect(listed.saved).toEqual([expect.objectContaining({ directory: body.directory, premises: body.premises })]);
      const outline = await app.inject({ method: "GET", url: "/handoff/runs/run-12345678-abcd/outline" });
      expect(outline.statusCode).toBe(200);
      expect(outline.json()).toMatchObject({ questions: [{ id: "Q-1", blocking: true }], tasks: [{ id: "TASK-1", folder: "1-strong-model", after: [] }, { id: "TASK-2", folder: "3-fast-model", after: ["TASK-1"] }],
        checks: [{ candidateId: "C-2", title: "A report to check", severity: "medium" }], checksFolder: "4-unsure" });
    } finally { await app.close(); await rm(repository, { recursive: true, force: true }); }
  });

  it("reads back what the executing agent recorded, with any credential it quoted masked, and says when nothing is recorded", async () => {
    const repository = await mkdtemp(join(tmpdir(), "arbitra-handoff-results-"));
    const app = buildServer(controlPlaneCore(new Orchestrator({ repository })));
    registerHandoffRoutes(app, planRun(repository));
    try {
      expect((await app.inject({ method: "GET", url: "/handoff/runs/run-12345678-abcd/results" })).json()).toEqual({ results: null });
      const folder = join(repository, ".arbitra", "plans", "2026-10-25-12345678");
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, "results.json"), JSON.stringify({ issues: [{ issue: "C-1", task: "TASK-1", result: "fixed", failedBefore: true, test: "test/a.test.ts", proof: "printed sk-abcdefghijklmnopqrstuv", checkedEndToEnd: false }] }));
      const response = await app.inject({ method: "GET", url: "/handoff/runs/run-12345678-abcd/results" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ results: { relative: ".arbitra/plans/2026-10-25-12345678", summary: { issues: 1, reported: 1, provenByFailingTest: 1 },
        issues: [{ issue: "C-1", task: "TASK-1", result: "fixed", failedBefore: true, checkedEndToEnd: false }], foundWhileFixing: [] } });
      expect(response.body).not.toContain("sk-abcdefghijklmnop");
    } finally { await app.close(); await rm(repository, { recursive: true, force: true }); }
  });

  it("refuses to outline a run that wrote no plan, as saving it does", async () => {
    const repository = await mkdtemp(join(tmpdir(), "arbitra-handoff-none-"));
    const app = buildServer(controlPlaneCore(new Orchestrator({ repository })));
    registerHandoffRoutes(app, planRun(repository, false));
    try {
      const outline = await app.inject({ method: "GET", url: "/handoff/runs/run-12345678-abcd/outline" });
      expect(outline.statusCode).toBe(409);
      expect(outline.json()).toMatchObject({ message: "RUN_HAS_NO_PLAN" });
    } finally { await app.close(); await rm(repository, { recursive: true, force: true }); }
  });
});
