import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHARED_WRITE_ORDER_NOTE } from "@arbitra/workflow/nodes/planner/traceability.js";
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

it("shows what the verifier said in an unsure check's prompt, and reads an issue set saved before it said anything", async () => {
  // Observed on the real-project runs (October 2026): a "cannot tell" outcome carried no reason, so checking one meant reading its tool trace.
  const repository = await mkdtemp(join(tmpdir(), "arbitra-plan-export-"));
  try {
    const content = {
      "plan-ir": { title: "Plan", tasks: [task("TASK-1", "frontier")], unresolvedQuestions: [] },
      "canonical-issues": { issues: [{ candidateId: "C-1", severity: "high", disposition: "accepted", claim: { title: "A defect", description: "It breaks." } },
        { candidateId: "C-2", severity: "high", disposition: "needs_verification", verificationOutcome: "STILL_NEEDS_VERIFICATION", verificationReason: "Whether the upload route is public is set in the deployment's proxy configuration.", claim: { title: "An open defect", description: "The upload route has no auth." } },
        { candidateId: "C-3", severity: "medium", disposition: "needs_verification", verificationOutcome: "STILL_NEEDS_VERIFICATION", claim: { title: "An older open defect", description: "It may leak." } }] },
      "plan-scope": { minimumSeverity: "medium" },
    };
    const orchestrator = {
      overview: async () => ({ repository, workflowId: "audit-deep" }), repositoryMatches: async () => true, modules: async () => [],
      artifacts: async () => Object.keys(content).map((kind) => ({ kind, artifactId: kind })),
      artifact: async (_runId: string, id: keyof typeof content) => ({ content: JSON.stringify(content[id]) }),
    } as unknown as Orchestrator;
    const { directory } = await exportPlan(orchestrator, "run-12345678-abcd");
    expect(await readFile(join(directory, "prompts", "4-unsure", "01-C-2.md"), "utf8")).toContain("<what_the_verifier_said>\nstill needs verification: Whether the upload route is public is set in the deployment's proxy configuration.\n</what_the_verifier_said>");
    expect(await readFile(join(directory, "prompts", "4-unsure", "02-C-3.md"), "utf8")).not.toContain("<what_the_verifier_said>");
  } finally { await rm(repository, { recursive: true, force: true }); }
});

it("writes the plan into the repository as prompts by model tier, in dependency order, beside any earlier copy", async () => {
  const repository = await mkdtemp(join(tmpdir(), "arbitra-plan-export-"));
  try {
    await mkdir(join(repository, "src"));
    await writeFile(join(repository, "src", "a.ts"), "export {};\n");
    // TASK-3 waits for TASK-1 only because both edit src/a.ts, and creates a test file the repository lacks.
    const ordered = { ...task("TASK-3", "balanced", ["TASK-1"]), addresses: { issues: ["C-5"], validation: [] }, scope: { likelyFiles: ["src/a.ts", "test/retry.test.ts"] },
      context: [`${SHARED_WRITE_ORDER_NOTE} waits for TASK-1 because both edit src/a.ts, so their changes land one after the other.`] };
    const content = {
      "plan-ir": { title: "Section one; Section two", tasks: [task("TASK-2", "fast", ["TASK-1"]), { ...task("TASK-1", "frontier"), addresses: { issues: ["C-1"], validation: ["VAL-1"] }, context: ["Per Q-2, keep the default.", "VAL-3 no longer holds; VAL-4 covers retries."] }, ordered],
        unresolvedQuestions: [{ id: "Q-1", question: "Which way?", blocking: true }, { id: "Q-2", question: "Which colour? Default if unanswered: blue.", blocking: false }],
        validationContract: { validation: [{ id: "VAL-1", assertion: "A broken input is refused.", evidence: ["A test that sends one"] }, { id: "VAL-2", assertion: "Not cited.", evidence: [] },
          { id: "VAL-3", assertion: "Superseded wording.", evidence: [] }, { id: "VAL-4", assertion: "Retries are bounded.", evidence: [] }] },
        traceability: { issueToValidation: [{ issueId: "C-1", validationIds: ["VAL-1", "VAL-4"] }] } },
      "canonical-issues": { issues: [{ candidateId: "C-1", severity: "high", disposition: "accepted", claim: { title: "A defect", description: "It breaks." } },
        { candidateId: "C-2", severity: "medium", disposition: "needs_verification", verificationOutcome: "STILL_NEEDS_VERIFICATION", claim: { title: "A disputed defect", description: "fetchAll keeps retrying the upload after its timeout fires." },
          dissent: [{ authorId: "auditor-a", disposition: "reject", reason: "The caller guards it." }] },
        { candidateId: "C-5", severity: "medium", disposition: "accepted", claim: { title: "Retries outlive the timeout", description: "After the timeout fires, fetchAll keeps retrying the upload." } },
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
      modules: async () => [],
      artifacts: async () => Object.keys(content).map((kind) => ({ kind, artifactId: kind })),
      artifact: async (_runId: string, id: keyof typeof content) => ({ content: JSON.stringify(content[id]) }),
    } as unknown as Orchestrator;
    const first = await exportPlan(orchestrator, "run-12345678-abcd");
    expect(first.files).toEqual(expect.arrayContaining([expect.stringMatching(/prompts[\\/]1-strong-model[\\/]01-TASK-1\.md$/u), expect.stringMatching(/prompts[\\/]3-fast-model[\\/]02-TASK-2\.md$/u)]));
    const readme = await readFile(join(first.directory, "README.md"), "utf8");
    expect(readme).toMatch(/^# Plan · 3 tasks for 2 issues\n\n- Section one\n- Section two\n/u);
    // A wait the run added only so that edits to one file land in turn is a merge hint, not an order of work.
    expect(readme).toContain("2. `TASK-2` Fix TASK-2 · 3-fast-model · after TASK-1\n3. `TASK-3` Fix TASK-3 · 2-balanced-model · same files as TASK-1\n");
    const balanced = await readFile(join(first.directory, "prompts", "2-balanced-model", "03-TASK-3.md"), "utf8");
    expect(balanced).not.toContain("<done_before_this>");
    expect(balanced).toContain("<shares_files_with>\nNothing here waits for these tasks; they edit the same files.");
    expect(balanced).toContain("- TASK-1 Fix TASK-1 (both edit src/a.ts)\n</shares_files_with>");
    expect(balanced).toContain("<context>\n- none\n</context>");
    // A note a revision added to stays as context, and its wait stays an order.
    const amended = { ...ordered, id: "TASK-4", dependencies: { dependsOn: ["TASK-3"] }, context: [`${SHARED_WRITE_ORDER_NOTE} waits for TASK-3 because both edit src/a.ts, so their changes land one after the other. Apply it to the new parser.`] };
    content["plan-ir"].tasks.push(amended);
    const withAmended = await exportPlan(orchestrator, "run-12345678-abcd");
    const fourth = await readFile(join(withAmended.directory, "prompts", "2-balanced-model", "04-TASK-4.md"), "utf8");
    expect(fourth).toContain("<done_before_this>\n- TASK-3 Fix TASK-3\n</done_before_this>");
    expect(fourth).toContain("Apply it to the new parser.");
    content["plan-ir"].tasks.pop();
    await rm(withAmended.directory, { recursive: true });
    // A file the task is to create is listed apart from the ones to read.
    expect(balanced).toContain("<read_first>\n- src/a.ts\n</read_first>\n\n<new_files>\nNot in the repository when the plan was saved; this task or an earlier one creates them:\n- test/retry.test.ts\n</new_files>");
    // A report elsewhere in the plan that reads like this task's issue is named, both ways.
    expect(balanced).toContain("<related_reports>\nThese reports elsewhere in the plan read like this one");
    expect(balanced).toContain("- check 01 (`C-2`) A disputed defect\n</related_reports>");
    expect(await readFile(join(first.directory, "prompts", "4-unsure", "01-C-2.md"), "utf8")).toContain("- TASK-3 Fix TASK-3\n</related_reports>");
    expect(await readFile(join(first.directory, "prompts", "1-strong-model", "01-TASK-1.md"), "utf8")).not.toContain("<related_reports>");
    // The prompt's claims about the code are claims to check; its commands are to run, and a boundary-crossing fix is
    // checked end to end.
    expect(balanced).toContain("This prompt is a starting point, not a script. What it says about the code (line numbers, quoted code, how something behaves) was written from the code as the audit read it, so treat it as claims to check");
    expect(balanced).toContain("Commands (run them yourself; read each before running it, and ask first only for one that would install software, delete data outside the project's build output, or reach the network):\n- `npm test` should exit 0");
    expect(balanced).not.toContain("ask before running");
    expect(balanced).toContain("also check it end to end: the project's browser or integration tests, or the app itself, run for real.");
    expect(balanced).toContain("If an existing test asserts the defective behaviour, change it as little as keeps its intent and name it in results.json");
    expect(readme).toContain("**Q-1**: Which way?");
    // What changed since the audit, and text that reads like instructions, come before the work.
    expect(readme).toContain("## Read this first\n\n- The project's files changed after the audit read them");
    expect(readme).toContain("- The `claude-code` CLI moved from version 2.1.296 to 2.1.301 when the run resumed");
    expect(readme).toContain("- `src/auth.ts` lines 2 reads like instructions to a model (model_directed_phrase), and no finding cites it.");
    // An issue of the plan's scope the audit left open gets a prompt to settle it, after the tasks; one below the scope
    // is only counted.
    expect(readme.indexOf("## Unsure: check after the tasks, if at all")).toBeGreaterThan(readme.indexOf("## Order of work"));
    expect(readme).toContain("1. `C-2` A disputed defect · medium");
    expect(readme).toContain("In the first plan carried out this way (nextra, October 2026), 7 of 20 such reports held");
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
    // The validation ids a task cites come with their assertion, and only those; one the task neither addresses nor
    // reaches through its issues is marked as a reference.
    expect(await readFile(join(first.directory, "prompts", "1-strong-model", "01-TASK-1.md"), "utf8")).toContain("<validation>\n- VAL-1: A broken input is refused.\n  Evidence: A test that sends one\n"
      + "- VAL-3 (cited for reference, not one of this task's checks): Superseded wording.\n- VAL-4: Retries are bounded.\n</validation>");
    expect(await readFile(join(first.directory, "prompts", "3-fast-model", "02-TASK-2.md"), "utf8")).not.toContain("<validation>");
    // So do the open questions it cites; the ones that do not block are listed in questions.md, with their defaults.
    expect(await readFile(join(first.directory, "prompts", "1-strong-model", "01-TASK-1.md"), "utf8")).toContain("- Q-2: Which colour? Default if unanswered: blue.\n</open_questions>");
    expect(await readFile(join(first.directory, "prompts", "3-fast-model", "02-TASK-2.md"), "utf8")).not.toContain("<open_questions>");
    expect(readme).toContain("`questions.md` lists 1 more open question the plan went ahead on with a default.");
    expect(await readFile(join(first.directory, "questions.md"), "utf8")).toContain("- **Q-2**: Which colour? Default if unanswered: blue.");
    const agents = await readFile(join(first.directory, "AGENTS.md"), "utf8");
    expect(agents).toContain("7. Do not change anything in this folder except PROGRESS.md and results.json.");
    expect(agents).toContain("5. Run the checks yourself: each prompt's commands and the project's own commands below build, test or lint the project; read each before running it");
    expect(agents).toContain("A defect you find while fixing that no issue names goes under `foundWhileFixing`");
    expect(agents).toContain("Leave them until every task is done");
    // The project's own commands, as the run read them, so a proving test runs the way the project runs its tests.
    expect(agents).toContain("- test: `pnpm run test` (from `package.json`)\n- test: `go test ./...` in `api` (from `api/go.mod`)");
    const results = JSON.parse(await readFile(join(first.directory, "results.json"), "utf8")) as { run: string; issues: unknown[]; foundWhileFixing: unknown[] };
    expect(results.run).toBe("run-12345678-abcd");
    expect(results.issues).toEqual([
      { issue: "C-1", title: "A defect", severity: "high", task: "TASK-1", result: null, failedBefore: null, test: null, proof: null, checkedEndToEnd: null },
      { issue: "C-5", title: "Retries outlive the timeout", severity: "medium", task: "TASK-3", result: null, failedBefore: null, test: null, proof: null, checkedEndToEnd: null },
      { issue: "C-2", title: "A disputed defect", severity: "medium", task: "check 01", result: null, failedBefore: null, test: null, proof: null, checkedEndToEnd: null },
    ]);
    expect(results.foundWhileFixing).toEqual([]);
    // Nothing is reported until the executor fills an entry in.
    expect(await planResults(repository, "run-12345678-abcd")).toMatchObject({ issues: 3, reported: 0, provenByFailingTest: 0, checkedEndToEnd: 0, foundWhileFixing: { reported: 0, provenByFailingTest: 0 } });
    // Git leaves saved plans out, since they list open defects; a person's own .gitignore there is kept.
    expect(await readFile(join(repository, ".arbitra", ".gitignore"), "utf8")).toMatch(/\n\*\n$/u);
    await writeFile(join(repository, ".arbitra", ".gitignore"), "# tracked on purpose\n");
    const second = await exportPlan(orchestrator, "run-12345678-abcd");
    expect(second.directory).toBe(`${first.directory}-2`);
    expect(await readFile(join(repository, ".arbitra", ".gitignore"), "utf8")).toBe("# tracked on purpose\n");
    // The executor worked in the first copy; arbitra reads the newest results.json, checking every field it reads.
    await writeFile(join(first.directory, "results.json"), JSON.stringify({ issues: [
      { issue: "C-2", result: "no_change_needed", failedBefore: false, test: null, proof: "The caller guards it." },
      { issue: "C-1", result: "fixed", failedBefore: true, test: "test/a.test.ts", proof: "expected 1, got 2", checkedEndToEnd: true },
      { issue: "C-9", result: "solved", failedBefore: "yes", checkedEndToEnd: "yes" }, "not an entry"],
    foundWhileFixing: [{ title: "The port search runs past 65535", failedBefore: true }, { title: "", failedBefore: true }, { title: "Untested", failedBefore: false }, 7] }));
    expect(await planResults(repository, "run-12345678-abcd")).toEqual({ directory: first.directory, issues: 3, reported: 2,
      results: { fixed: 1, not_reproducible: 0, no_change_needed: 1, blocked: 0 }, provenByFailingTest: 1, notProvenByTest: 1, checkedEndToEnd: 1, foundWhileFixing: { reported: 2, provenByFailingTest: 1 } });
    expect(await planResults(repository, "run-87654321-abcd")).toBeNull();
  } finally { await rm(repository, { recursive: true, force: true }); }
});

it("does not say the auditors disagreed about a report no auditor reviewed", async () => {
  // Observed live (commentanywhere, October 23, 2026): a run with no peer-review round recorded no vote on any issue,
  // so the reports it left open were not disputed, only unchecked by a second auditor.
  const repository = await mkdtemp(join(tmpdir(), "arbitra-plan-export-"));
  try {
    await mkdir(join(repository, "src"));
    await writeFile(join(repository, "src", "a.ts"), "export {};\n");
    const open = (candidateId: string, reviewedBy: readonly string[]) => ({ candidateId, severity: "medium", disposition: "needs_verification", verificationOutcome: "STILL_NEEDS_VERIFICATION", claim: { title: `Open ${candidateId}`, description: "It may retry forever." },
      dissent: [], coverage: { reviewedBy, missingReviewers: [] }, singleSource: false });
    const plan = { title: "One section", tasks: [task("TASK-1", "frontier")], unresolvedQuestions: [], validationContract: { validation: [] }, traceability: { issueToValidation: [] } };
    const run = async (issues: readonly unknown[]) => {
      const content: Record<string, unknown> = { "plan-ir": plan, "canonical-issues": { issues: [{ candidateId: "C-1", severity: "high", disposition: "accepted", claim: { title: "A defect", description: "It breaks." } }, ...issues] }, "plan-scope": { minimumSeverity: "medium" } };
      const orchestrator = { overview: async () => ({ repository, workflowId: "audit-balanced" }), repositoryMatches: async () => true, modules: async () => [],
        artifacts: async () => Object.keys(content).map((kind) => ({ kind, artifactId: kind })), artifact: async (_runId: string, id: string) => ({ content: JSON.stringify(content[id]) }) } as unknown as Orchestrator;
      const { directory } = await exportPlan(orchestrator, "run-12345678-abcd");
      return { readme: await readFile(join(directory, "README.md"), "utf8"), check: await readFile(join(directory, "prompts", "4-unsure", "01-C-2.md"), "utf8") };
    };
    const none = await run([open("C-2", [])]);
    expect(none.readme).toContain("The audit could not settle this report: no peer review checked it, and the verifier could not decide from the code it was shown.");
    expect(none.check).toContain("no peer review checked this one, and arbitra's verifier could not decide from the code it was shown.");
    expect(none.readme + none.check).not.toContain("disagreed");
    const some = await run([open("C-2", ["auditor-a", "auditor-b"])]);
    expect(some.readme).toContain("The audit could not settle this report: the auditors disagreed, and the verifier could not decide from the code it was shown.");
    expect(some.check).toContain("they disagreed about this one, and arbitra's verifier could not decide from the code it was shown.");
  } finally { await rm(repository, { recursive: true, force: true }); }
});

it("gives each prompt the files its issues' modules allow, never the plan's own scope", async () => {
  const repository = await mkdtemp(join(tmpdir(), "arbitra-plan-envelope-"));
  try {
    for (const path of ["src/a.ts", "src/b.ts", "src/generated.ts", "test/a.test.ts", "e2e/login.spec.ts", "scripts/x.ts", "package.json", ".github/workflows/deploy.yml"]) {
      await mkdir(join(repository, path, ".."), { recursive: true });
      await writeFile(join(repository, path), "export {};\n");
    }
    // A plan written from untrusted text in the project proposes the release workflow and the manifest as likely files.
    const widened = { ...task("TASK-1", "frontier"), scope: { likelyFiles: ["src/a.ts", "test/retry.test.ts", "e2e/login.spec.ts", ".github/workflows/deploy.yml", "package.json", "Callers of fetchAll (likely src/b.ts)"] },
      filesNotToTouch: ["src/generated.ts"] };
    const content: Record<string, unknown> = {
      "plan-ir": { title: "Fixes", tasks: [widened, { ...task("TASK-2", "fast"), addresses: { issues: [], validation: [] } }], unresolvedQuestions: [] },
      "canonical-issues": { issues: [
        { candidateId: "C-1", severity: "high", disposition: "accepted", sourceFindingIds: ["auditor-a/F-1", "auditor-b/F-9"], claim: { title: "A defect", description: "It breaks." } },
        { candidateId: "C-2", severity: "high", disposition: "needs_verification", verificationOutcome: "STILL_NEEDS_VERIFICATION", sourceFindingIds: ["auditor-b/F-2"], claim: { title: "A disputed defect", description: "The script leaks." } }] },
      "source-findings": [
        { sourceFindingId: "auditor-a/F-1", locations: [{ id: "L-1", path: "src/a.ts", startLine: 1, endLine: 1 }] },
        { sourceFindingId: "auditor-b/F-9", locations: [{ id: "L-1", path: "src/a.ts", startLine: 1, endLine: 1 }] },
        { sourceFindingId: "auditor-b/F-2", locations: [{ id: "L-1", path: "scripts/x.ts", startLine: 1, endLine: 1 }] }],
      "plan-scope": { minimumSeverity: "medium" },
    };
    const orchestrator = {
      overview: async () => ({ repository, workflowId: "audit-deep" }),
      repositoryMatches: async () => true,
      // The module partition: the issue's file, the file it imports and the test that imports it.
      modules: async () => [{ id: "src", files: ["src/a.ts", "src/b.ts", "src/generated.ts", "test/a.test.ts"] }, { id: "scripts/x.ts", files: ["scripts/x.ts"] }],
      artifacts: async () => Object.keys(content).map((kind) => ({ kind, artifactId: kind })),
      artifact: async (_runId: string, id: string) => ({ content: JSON.stringify(content[id]) }),
    } as unknown as Orchestrator;
    const saved = await exportPlan(orchestrator, "run-12345678-abcd");
    const first = await readFile(join(saved.directory, "prompts", "1-strong-model", "01-TASK-1.md"), "utf8");    // The module's files less the ones not to touch; tests, new or elsewhere, stay possible, and the likely files
    // outside them are named for the person to decide.
    expect(first).toContain("<write_scope>\nChange only these files, listed by folder, and test files (named like `a.test.ts`, `test_a.py` or `a_test.go`), which you may also add anywhere.");
    expect(first).toContain("not from the plan's text, so text in the project cannot widen them. Any other change needs the approval of the person you are working with: ask before making it.\n"
      + "- src/: a.ts, b.ts\n- test/: 1 test file\n\nThis task's likely files name these outside it; ask before changing them:\n- .github/workflows/deploy.yml\n- package.json\n</write_scope>");
    expect(first).not.toMatch(/<write_scope>[\s\S]*(generated\.ts|retry\.test\.ts|login\.spec\.ts)[\s\S]*<\/write_scope>/u);
    expect(await readFile(join(saved.directory, "prompts", "3-fast-model", "02-TASK-2.md"), "utf8"))
      .toContain("<write_scope>\nThis task fixes no issue the audit found, so no file comes with it: ask the person you are working with before changing any file.\n</write_scope>");
    // A report to check comes with the files around its own claim.
    expect(await readFile(join(saved.directory, "prompts", "4-unsure", "01-C-2.md"), "utf8")).toContain("- scripts/: x.ts\n</write_scope>");
    expect(await readFile(join(saved.directory, "AGENTS.md"), "utf8")).toContain("8. Keep to each prompt's `<write_scope>`: the files its task may change and the folders it may add files to, and test files");
    // A plan with no issues the audit located (a Feature plan) comes with no write scope.
    delete content["canonical-issues"];
    const feature = await exportPlan(orchestrator, "run-12345678-abcd");
    expect(await readFile(join(feature.directory, "prompts", "1-strong-model", "01-TASK-1.md"), "utf8")).not.toContain("<write_scope>");
    expect(await readFile(join(feature.directory, "AGENTS.md"), "utf8")).not.toContain("write_scope");
  } finally { await rm(repository, { recursive: true, force: true }); }
});
