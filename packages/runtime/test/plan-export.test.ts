import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { Orchestrator } from "../src/orchestrator.js";
import { exportPlan } from "../src/plan-export.js";

const task = (id: string, capability: "frontier" | "balanced" | "fast", dependsOn: string[] = []) => ({
  id, title: `Fix ${id}`, goal: { objective: `Objective of ${id}`, doneWhen: ["the defect is gone"] }, addresses: { issues: ["C-1"], validation: [] },
  routing: { capability, effort: "high", reason: [] }, dependencies: { dependsOn }, scope: { likelyFiles: ["src/a.ts"] },
  filesNotToTouch: [], readFirst: [], context: [], invariants: [], outOfScope: [], implementationGuidance: ["Change it."], acceptanceCriteria: ["Tests pass."],
  verification: { preconditions: [], commands: [{ command: "npm test", expectedExitCode: 0, executionPolicy: "requires_approval" }], checks: [] }, rollbackPlan: [],
});

it("writes the plan into the repository as prompts by model tier, in dependency order, beside any earlier copy", async () => {
  const repository = await mkdtemp(join(tmpdir(), "arbitra-plan-export-"));
  try {
    const content = {
      "plan-ir": { title: "Section one; Section two", tasks: [task("TASK-2", "fast", ["TASK-1"]), task("TASK-1", "frontier")], unresolvedQuestions: [{ id: "Q-1", question: "Which way?", blocking: true }] },
      "canonical-issues": { issues: [{ candidateId: "C-1", severity: "high", disposition: "accepted", claim: { title: "A defect", description: "It breaks." } }] },
    };
    const orchestrator = {
      overview: async () => ({ repository, workflowId: "audit-deep" }),
      artifacts: async () => Object.keys(content).map((kind) => ({ kind, artifactId: kind })),
      artifact: async (_runId: string, id: keyof typeof content) => ({ content: JSON.stringify(content[id]) }),
    } as unknown as Orchestrator;
    const first = await exportPlan(orchestrator, "run-12345678-abcd");
    expect(first.files).toEqual(expect.arrayContaining([expect.stringMatching(/prompts[\\/]1-strong-model[\\/]01-TASK-1\.md$/u), expect.stringMatching(/prompts[\\/]3-fast-model[\\/]02-TASK-2\.md$/u)]));
    const readme = await readFile(join(first.directory, "README.md"), "utf8");
    expect(readme).toMatch(/^# Plan · 2 tasks for 1 issue\n\n- Section one\n- Section two\n/u);
    expect(readme).toContain("**Q-1**: Which way?");
    expect(await readFile(join(first.directory, "prompts", "3-fast-model", "02-TASK-2.md"), "utf8")).toContain("<done_before_this>\n- TASK-1 Fix TASK-1\n</done_before_this>");
    const second = await exportPlan(orchestrator, "run-12345678-abcd");
    expect(second.directory).toBe(`${first.directory}-2`);
  } finally { await rm(repository, { recursive: true, force: true }); }
});
