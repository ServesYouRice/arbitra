import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { Orchestrator } from "../src/orchestrator.js";
import { exportPlan } from "../src/plan-export.js";
import { planResults } from "../src/plan-results.js";

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
      "plan-ir": { title: "Section one; Section two", tasks: [task("TASK-2", "fast", ["TASK-1"]), { ...task("TASK-1", "frontier"), addresses: { issues: ["C-1"], validation: ["VAL-1"] }, context: ["Per Q-2, keep the default."] }],
        unresolvedQuestions: [{ id: "Q-1", question: "Which way?", blocking: true }, { id: "Q-2", question: "Which colour? Default if unanswered: blue.", blocking: false }],
        validationContract: { validation: [{ id: "VAL-1", assertion: "A broken input is refused.", evidence: ["A test that sends one"] }, { id: "VAL-2", assertion: "Not cited.", evidence: [] }] } },
      "canonical-issues": { issues: [{ candidateId: "C-1", severity: "high", disposition: "accepted", claim: { title: "A defect", description: "It breaks." } },
        { candidateId: "C-2", severity: "medium", disposition: "needs_verification", verificationOutcome: "STILL_NEEDS_VERIFICATION", claim: { title: "A disputed defect", description: "It may break." },
          dissent: [{ authorId: "auditor-a", disposition: "reject", reason: "The caller guards it." }] },
        { candidateId: "C-3", severity: "low", disposition: "needs_verification", verificationOutcome: null, claim: { title: "A minor defect", description: "It is untidy." } },
        { candidateId: "C-4", severity: "low", disposition: "accepted", verificationOutcome: null, claim: { title: "An agreed small defect", description: "It leaks a handle." } }],
        coverage: { suppressionCandidates: [{ path: "src/auth.ts", lines: [{ startLine: 2, endLine: 2 }], scannerHits: ["model_directed_phrase"] }] } },
      "environment-versions": { cli: { "claude-code": "2.1.301" }, changedOnResume: { "claude-code": { from: "2.1.296", to: "2.1.301" } } },
      "plan-scope": { minimumSeverity: "medium" },
      "severity-restored": { minimumSeverity: "medium", issues: [{ candidateId: "C-1", foundAs: "high", loweredTo: "low", by: "auditor-a", reason: "Only a dev script." }] },
      "repository-commands": { commands: [{ purpose: "test", command: "pnpm run test", directory: "", sourcePath: "package.json", source: "vitest run" }, { purpose: "test", command: "go test ./...", directory: "api", sourcePath: "api/go.mod", source: "go.mod" }] },
    };
    const orchestrator = {
      overview: async () => ({ repository, workflowId: "audit-deep" }),
      repositoryMatches: async () => false,
      artifacts: async () => Object.keys(content).map((kind) => ({ kind, artifactId: kind })),
      artifact: async (_runId: string, id: keyof typeof content) => ({ content: JSON.stringify(content[id]) }),
    } as unknown as Orchestrator;
    const first = await exportPlan(orchestrator, "run-12345678-abcd");
    expect(first.files).toEqual(expect.arrayContaining([expect.stringMatching(/prompts[\\/]1-strong-model[\\/]01-TASK-1\.md$/u), expect.stringMatching(/prompts[\\/]3-fast-model[\\/]02-TASK-2\.md$/u)]));
    const readme = await readFile(join(first.directory, "README.md"), "utf8");
    expect(readme).toMatch(/^# Plan · 2 tasks for 1 issue\n\n- Section one\n- Section two\n/u);
    expect(readme).toContain("**Q-1**: Which way?");
    // What changed since the audit, and text that reads like instructions, come before the work.
    expect(readme).toContain("## Read this first\n\n- The project's files changed after the audit read them");
    expect(readme).toContain("- The `claude-code` CLI moved from version 2.1.296 to 2.1.301 when the run resumed");
    expect(readme).toContain("- `src/auth.ts` lines 2 reads like instructions to a model (model_directed_phrase), and no finding cites it.");
    // An issue of the plan's scope the audit left open gets a prompt to settle it, after the tasks; one below the scope
    // is only counted.
    expect(readme.indexOf("## Unsure: check after the tasks, if at all")).toBeGreaterThan(readme.indexOf("## Order of work"));
    expect(readme).toContain("1. `C-2` A disputed defect · medium");
    expect(readme).toContain("1 lower-severity issue was left unverified and is not planned");
    // A lowering one reviewer made alone is shown with its reason; accepted issues no task fixes are listed apart.
    expect(readme).toContain("- `C-1` A defect: found as high; auditor-a proposed low: Only a dev script.");
    expect(readme).toContain("`also-found.md` lists 1 more issue");
    expect(await readFile(join(first.directory, "also-found.md"), "utf8")).toContain("## An agreed small defect\n\nlow · C-4\n\nIt leaks a handle.");
    const check = await readFile(join(first.directory, "prompts", "4-unsure", "01-C-2.md"), "utf8");
    expect(check).toContain("<what_the_reviewers_said>\n- auditor-a (reject): The caller guards it.\n</what_the_reviewers_said>");
    expect(await readFile(join(first.directory, "PROGRESS.md"), "utf8")).toMatch(/- \[ \] 01 `TASK-1`[\s\S]*## Unsure, after the tasks \(optional\)[\s\S]*- \[ \] check 01 `C-2` A disputed defect/u);
    expect(await readFile(join(first.directory, "prompts", "3-fast-model", "02-TASK-2.md"), "utf8")).toContain("<done_before_this>\n- TASK-1 Fix TASK-1\n</done_before_this>");
    // Each defect is proven by a failing test before it is fixed, and its result goes into results.json.
    expect(await readFile(join(first.directory, "prompts", "1-strong-model", "01-TASK-1.md"), "utf8")).toMatch(/<reproduce_first>\nFor the issue this task fixes \(`C-1`\): Before changing code, write a test that fails on the current code/u);
    // The validation ids a task cites come with their assertion, and only those.
    expect(await readFile(join(first.directory, "prompts", "1-strong-model", "01-TASK-1.md"), "utf8")).toContain("<validation>\n- VAL-1: A broken input is refused.\n  Evidence: A test that sends one\n</validation>");
    expect(await readFile(join(first.directory, "prompts", "3-fast-model", "02-TASK-2.md"), "utf8")).not.toContain("<validation>");
    // So do the open questions it cites; the ones that do not block are listed in questions.md, with their defaults.
    expect(await readFile(join(first.directory, "prompts", "1-strong-model", "01-TASK-1.md"), "utf8")).toContain("- Q-2: Which colour? Default if unanswered: blue.\n</open_questions>");
    expect(await readFile(join(first.directory, "prompts", "3-fast-model", "02-TASK-2.md"), "utf8")).not.toContain("<open_questions>");
    expect(readme).toContain("`questions.md` lists 1 more open question the plan went ahead on with a default.");
    expect(await readFile(join(first.directory, "questions.md"), "utf8")).toContain("- **Q-2**: Which colour? Default if unanswered: blue.");
    const agents = await readFile(join(first.directory, "AGENTS.md"), "utf8");
    expect(agents).toContain("5. Do not change anything in this folder except PROGRESS.md and results.json.");
    expect(agents).toContain("Leave them until every task is done");
    // The project's own commands, as the run read them, so a proving test runs the way the project runs its tests.
    expect(agents).toContain("- test: `pnpm run test` (from `package.json`)\n- test: `go test ./...` in `api` (from `api/go.mod`)");
    const results = JSON.parse(await readFile(join(first.directory, "results.json"), "utf8")) as { run: string; issues: unknown[] };
    expect(results.run).toBe("run-12345678-abcd");
    expect(results.issues).toEqual([
      { issue: "C-1", title: "A defect", severity: "high", task: "TASK-1", result: null, failedBefore: null, test: null, proof: null },
      { issue: "C-2", title: "A disputed defect", severity: "medium", task: "check 01", result: null, failedBefore: null, test: null, proof: null },
    ]);
    // Nothing is reported until the executor fills an entry in.
    expect(await planResults(repository, "run-12345678-abcd")).toMatchObject({ issues: 2, reported: 0, provenByFailingTest: 0 });
    // Git leaves saved plans out, since they list open defects; a person's own .gitignore there is kept.
    expect(await readFile(join(repository, ".arbitra", ".gitignore"), "utf8")).toMatch(/\n\*\n$/u);
    await writeFile(join(repository, ".arbitra", ".gitignore"), "# tracked on purpose\n");
    const second = await exportPlan(orchestrator, "run-12345678-abcd");
    expect(second.directory).toBe(`${first.directory}-2`);
    expect(await readFile(join(repository, ".arbitra", ".gitignore"), "utf8")).toBe("# tracked on purpose\n");
    // The executor worked in the first copy; arbitra reads the newest results.json, checking every field it reads.
    await writeFile(join(first.directory, "results.json"), JSON.stringify({ issues: [
      { issue: "C-2", result: "no_change_needed", failedBefore: false, test: null, proof: "The caller guards it." },
      { issue: "C-1", result: "fixed", failedBefore: true, test: "test/a.test.ts", proof: "expected 1, got 2" },
      { issue: "C-9", result: "solved", failedBefore: "yes" }, "not an entry"] }));
    expect(await planResults(repository, "run-12345678-abcd")).toEqual({ directory: first.directory, issues: 3, reported: 2,
      results: { fixed: 1, not_reproducible: 0, no_change_needed: 1, blocked: 0 }, provenByFailingTest: 1, notProvenByTest: 1 });
    expect(await planResults(repository, "run-87654321-abcd")).toBeNull();
  } finally { await rm(repository, { recursive: true, force: true }); }
});
