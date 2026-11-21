import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SHARED_WRITE_ORDER_NOTE } from "@arbitra/workflow/nodes/planner/traceability.js";
import { expect, it } from "vitest";
import type { Orchestrator } from "../src/orchestrator.js";
import { exportPlan, planOutline, savedPlans } from "../src/plan-export.js";
import { planResultRecord, planResults } from "../src/plan-results.js";

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

it("gives an unsure report's prompt where it is and what would show it, lists the reports most severe first, and asks for each result like a task's", async () => {
  // Observed on a messaging app's plan (saved October 25, carried out October 31 to November 11, 2026): the check
  // prompts gave neither the lines a report cites nor what would show it; 24 of the 35 reports still in the code were
  // real, yet the verdicts went into PROGRESS.md and 40 of the 42 entries in results.json were left empty.
  const repository = await mkdtemp(join(tmpdir(), "arbitra-plan-unsure-"));
  try {
    await mkdir(join(repository, "src"));
    await writeFile(join(repository, "src", "upload.ts"), ["export function upload(request) {", "  const file = request.body;", "  store(file);", "  return file;", "}", ""].join("\n"));
    await writeFile(join(repository, "src", "routes.ts"), ["import { upload } from './upload';", "app.post('/upload', upload);", ""].join("\n"));
    const open = { disposition: "needs_verification", verificationOutcome: "STILL_NEEDS_VERIFICATION" };
    const content = {
      "plan-ir": { title: "Plan", tasks: [task("TASK-1", "frontier")], unresolvedQuestions: [] },
      // The medium report comes first in the issue set; the high one is checked first.
      "canonical-issues": { issues: [{ candidateId: "C-1", severity: "high", disposition: "accepted", claim: { title: "A defect", description: "It breaks." } },
        { ...open, candidateId: "C-3", severity: "medium", claim: { title: "A medium open defect", description: "It may leak." } },
        { ...open, candidateId: "C-2", severity: "high", sourceFindingIds: ["auditor-a/F-1", "auditor-b/F-4"], verificationReason: "Whether a proxy in front of the route checks a session is set outside the repository.",
          dissent: [{ authorId: "auditor-b", disposition: "reject", reason: "The proxy checks it." }], claim: { title: "The upload route has no auth", description: "upload() stores the request body without checking a session." } }] },
      "source-findings": [
        { sourceFindingId: "auditor-a/F-1", locations: [{ id: "L-1", path: "src/upload.ts", startLine: 1, endLine: 4 }, { id: "L-2", path: "src/routes.ts", startLine: 2, endLine: 2 }],
          trigger: "A client with no session posts a file.", verification: "Write a test that calls upload() with no session and expects a refusal." },
        // A second auditor saying the same thing adds nothing; an empty field adds no line.
        { sourceFindingId: "auditor-b/F-4", locations: [{ id: "L-1", path: "src/upload.ts", startLine: 1, endLine: 4 }], trigger: "A client  with no session posts a file.", verification: "" }],
      "plan-scope": { minimumSeverity: "medium" },
    };
    const orchestrator = {
      overview: async () => ({ repository, workflowId: "audit-deep" }), repositoryMatches: async () => true, modules: async () => [],
      artifacts: async () => Object.keys(content).map((kind) => ({ kind, artifactId: kind })),
      artifact: async (_runId: string, id: keyof typeof content) => ({ content: JSON.stringify(content[id]) }),
    } as unknown as Orchestrator;
    const { directory } = await exportPlan(orchestrator, "run-12345678-abcd");
    const check = await readFile(join(directory, "prompts", "4-unsure", "01-C-2.md"), "utf8");
    expect(check).toContain("<where>\nThe places the audit cites for it, as it read them (step 1 prints any that moved since):\n- src/upload.ts:1-4\n- src/routes.ts:2\n</where>");
    expect(check).toContain("<what_would_show_it>\nWhat the auditors who reported it said sets it off, and how they said to check it:\n- auditor-a, what sets it off: A client with no session posts a file.\n"
      + "- auditor-a, how to check it: Write a test that calls upload() with no session and expects a refusal.\n</what_would_show_it>");
    // Where it is, what it claims, why the audit could not settle it, and what would show it, in that order.
    const order = ["<claim>", "<where>", "<what_the_reviewers_said>", "<what_the_verifier_said>", "<what_would_show_it>", "<steps>"].map((tag) => check.indexOf(tag));
    expect(order.every((at, index) => at >= 0 && (index === 0 || at > (order[index - 1] ?? 0)))).toBe(true);
    // Neither a fact nor a false alarm: nothing changes for it until a test or a run shows it, and the verdict is recorded either way.
    expect(check).toContain("On the plans carried out so far, between a third and two thirds of such reports held, so treat this one as a claim to test, neither a fact nor a false alarm.");
    expect(check).not.toContain("may be wrong");
    expect(check).toContain("4. If the claim does not hold, change nothing and say why");
    expect(check).toContain("5. If it holds, show it before changing code: a test that fails on the current code for the reason the claim gives, or, where no test can, a run that shows the defect;");
    expect(check).toContain("record the result in results.json as for a task, not only in PROGRESS.md: `no_change_needed` when the claim does not hold");
    // A report whose findings were not recorded has no places to give.
    expect(await readFile(join(directory, "prompts", "4-unsure", "02-C-3.md"), "utf8")).not.toMatch(/<where>|<what_would_show_it>/u);
    // The places it cites are looked up like any prompt's, so the premise check can say where they moved.
    const premises = JSON.parse(await readFile(join(directory, "premises.json"), "utf8")) as { prompts: Record<string, { premises: unknown[] }> };
    expect(premises.prompts["C-2"]?.premises).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "lines", text: "src/upload.ts:1-4", flagged: false, saved: expect.objectContaining({ status: "found" }) })]));
    const progress = await readFile(join(directory, "PROGRESS.md"), "utf8");
    expect(progress).toContain("## Unsure reports, after the tasks\n\nThe audit could not settle these. They are part of the work: once the tasks are done, check each one, most severe first,"
      + " and change nothing for it until a failing test or a run shows the defect. Record each result in results.json like a task's, one that does not hold as `no_change_needed`; a note here is not read back.");
    expect(progress).toContain("- [ ] check 01 `C-2` The upload route has no auth · high\n- [ ] check 02 `C-3` A medium open defect · medium\n");
    expect(await readFile(join(directory, "README.md"), "utf8")).toContain("They are part of the work, after the tasks above");
    expect(await readFile(join(directory, "AGENTS.md"), "utf8")).toContain("There is 1 task, then 2 unsure reports to check and record.");
    const results = JSON.parse(await readFile(join(directory, "results.json"), "utf8")) as { issues: { issue: string; task: string }[] };
    expect(results.issues.map(({ issue, task: work }) => `${issue} ${work}`)).toEqual(["C-1 TASK-1", "C-2 check 01", "C-3 check 02"]);
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
    // A plan saved before the sections' titles were recorded apart lists the titles its own title joined.
    expect(readme).toMatch(/^# Plan · 3 tasks for 2 issues\n\n- Section one\n- Section two\n/u);
    // A plan written in sections now has one short title, and its sections' titles are listed from the record of how
    // it was written. Observed live (memoria, November 2026): 24 section titles joined with ";" were the plan's title.
    const sectioned = content as Record<string, unknown>;
    sectioned["plan-ir"] = { ...content["plan-ir"], title: "Audit plan in 2 sections" };
    sectioned["planner-composition"] = { kind: "sections_side_by_side", sections: 2, sectionTitles: ["Harden billing; refunds", "Fix users"] };
    const titled = await exportPlan(orchestrator, "run-12345678-abcd");
    expect(await readFile(join(titled.directory, "README.md"), "utf8")).toMatch(/^# Plan · 3 tasks for 2 issues\n\n- Harden billing; refunds\n- Fix users\n\nFrom arbitra run/u);
    await rm(titled.directory, { recursive: true });
    sectioned["plan-ir"] = { ...content["plan-ir"], title: "Section one; Section two" };
    delete sectioned["planner-composition"];
    // A wait the run added only so that edits to one file land in turn is a merge hint, not an order of work.
    // TASK-3's issue says fetchAll retries, and the project has no fetchAll: the README counts it.
    expect(readme).toContain("2. `TASK-2` Fix TASK-2 · 3-fast-model · after TASK-1\n3. `TASK-3` Fix TASK-3 · 2-balanced-model · same files as TASK-1 · 1 not found\n");
    // The run page shows the same order of work before and after saving: the questions first, the tasks in their
    // order and folder, and the reports to check after them.
    expect(await planOutline(orchestrator, "run-12345678-abcd")).toEqual({
      questions: [{ id: "Q-1", question: "Which way?", blocking: true }, { id: "Q-2", question: "Which colour? Default if unanswered: blue.", blocking: false }],
      tasks: [{ id: "TASK-1", title: "Fix TASK-1", tier: "frontier", folder: "1-strong-model", after: [], sameFilesAs: [], issues: ["C-1"] },
        { id: "TASK-2", title: "Fix TASK-2", tier: "fast", folder: "3-fast-model", after: ["TASK-1"], sameFilesAs: [], issues: ["C-1"] },
        { id: "TASK-3", title: "Fix TASK-3", tier: "balanced", folder: "2-balanced-model", after: [], sameFilesAs: ["TASK-1"], issues: ["C-5"] }],
      checks: [{ candidateId: "C-2", title: "A disputed defect", severity: "medium" }], checksFolder: "4-unsure", alsoFound: 1, unverified: 1,
    });
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
    expect(readme).toContain("- `src/auth.ts` line 2 reads like instructions to a model (model_directed_phrase), and no finding cites it.");
    // An issue of the plan's scope the audit left open gets a prompt to settle it, as part of the work after the tasks;
    // one below the scope is only counted. The README gives how many such reports held where it was measured, both
    // ways, rather than saying most do not.
    expect(readme.indexOf("## Unsure reports: check after the tasks")).toBeGreaterThan(readme.indexOf("## Order of work"));
    expect(readme).toContain("1. `C-2` A disputed defect · medium");
    expect(readme).toContain("It is part of the work, after the tasks above, which are surer and may change or fix the same code.");
    expect(readme).toContain("On the two plans carried out with such reports so far, 7 of 20 held on one project (October 2026); on another, 24 of the 35 still in the code when they were checked held");
    expect(readme).toContain("Record each result in `results.json` like a task's, one that does not hold as `no_change_needed` with what decided it.");
    expect(readme).not.toMatch(/most such reports do not hold|if at all|not part of the work/u);
    expect(readme).toContain("1 lower-severity issue was left unverified and is not planned");
    // A lowering one reviewer made alone is shown with its reason; accepted issues no task fixes are listed apart.
    expect(readme).toContain("- `C-1` A defect: found as high; auditor-a proposed low: Only a dev script.");
    expect(readme).toContain("`also-found.md` lists 1 more issue");
    expect(await readFile(join(first.directory, "also-found.md"), "utf8")).toContain("## An agreed small defect\n\nlow · C-4\n\nIt leaks a handle.");
    const check = await readFile(join(first.directory, "prompts", "4-unsure", "01-C-2.md"), "utf8");
    expect(check).toContain("<what_the_reviewers_said>\n- auditor-a (reject): The caller guards it.\n</what_the_reviewers_said>");
    const progress = await readFile(join(first.directory, "PROGRESS.md"), "utf8");
    expect(progress).toMatch(/- \[ \] 01 `TASK-1`[\s\S]*## Unsure reports, after the tasks\n[\s\S]*- \[ \] check 01 `C-2` A disputed defect · medium\n/u);
    expect(progress).not.toMatch(/optional|do not hold/u);
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
    expect(agents).toContain("7. Do not change anything in this folder except PROGRESS.md and results.json; check-premises.mjs reads premises.json as the plan saved it.");
    expect(agents).toContain("5. Run the checks yourself: each prompt's commands and the project's own commands below build, test or lint the project; read each before running it");
    expect(agents).toContain("A defect you find while fixing that no issue names goes under `foundWhileFixing`");
    expect(agents).toContain("They are part of the work: once every task is done, check each one as its prompt says, most severe first.");
    expect(agents).toContain("record its result in results.json like a task's, whatever the verdict (arbitra reads that file back, not PROGRESS.md).");
    expect(agents).toContain("There are 3 tasks, then 1 unsure report to check and record.");
    expect(agents).not.toMatch(/most do not hold|if wanted|wants them/u);
    // The project's own commands, as the run read them, so a proving test runs the way the project runs its tests.
    expect(agents).toContain("- test: `pnpm run test` (from `package.json`)\n- test: `go test ./...` in `api` (from `api/go.mod`)");
    const results = JSON.parse(await readFile(join(first.directory, "results.json"), "utf8")) as { run: string; instructions: string; issues: unknown[]; foundWhileFixing: unknown[] };
    expect(results.run).toBe("run-12345678-abcd");
    expect(results.issues).toEqual([
      { issue: "C-1", title: "A defect", severity: "high", task: "TASK-1", result: null, failedBefore: null, test: null, proof: null, checkedEndToEnd: null },
      { issue: "C-5", title: "Retries outlive the timeout", severity: "medium", task: "TASK-3", result: null, failedBefore: null, test: null, proof: null, checkedEndToEnd: null },
      { issue: "C-2", title: "A disputed defect", severity: "medium", task: "check 01", result: null, failedBefore: null, test: null, proof: null, checkedEndToEnd: null },
    ]);
    expect(results.foundWhileFixing).toEqual([]);
    // The folder carries a check of results.json, and every place that asks for a result says to run it. Observed live
    // (a messaging app's plan, November 2026): every task was ticked while half the entries had no result.
    const resultsCheck = `node .arbitra/plans/${basename(first.directory)}/check-results.mjs`;
    expect(first.files).toEqual(expect.arrayContaining([expect.stringMatching(/check-results\.mjs$/u)]));
    expect(agents).toContain(`   Then run \`${resultsCheck} --task <task id>\` (an unsure report's issue id for one of those) and correct what it reports before the next task.`);
    expect(readme).toContain(`\`check-results.mjs\` checks that file by the rules arbitra reads it with: run \`${resultsCheck} --task <task id>\` when a task is done`);
    expect(balanced).toContain(`Then run \`${resultsCheck} --task TASK-3\` from the repository root and correct what it reports`);
    expect(check).toContain(`Then run \`${resultsCheck} --task C-2\` from the repository root and correct what it reports`);
    expect(await readFile(join(first.directory, "PROGRESS.md"), "utf8")).toContain(`its issues' results are in results.json (\`${resultsCheck} --task <task id>\` checks both)`);
    expect(results.instructions).toContain(`When a task is done, run \`${resultsCheck} --task <task id>\``);
    // Nothing is reported until the executor fills an entry in.
    expect(await planResults(repository, "run-12345678-abcd")).toMatchObject({ issues: 3, reported: 0, provenByFailingTest: 0, checkedEndToEnd: 0, foundWhileFixing: { reported: 0, provenByFailingTest: 0 }, invalid: 0 });
    // Plans may be pushed, so no ignore is written; the README says a public repository would publish the open issues.
    await expect(readFile(join(repository, ".arbitra", ".gitignore"), "utf8")).rejects.toThrow("ENOENT");
    expect(await readFile(join(first.directory, "README.md"), "utf8")).toContain("A public repository that commits it publishes them all");
    // A .gitignore a project already has there is kept.
    await writeFile(join(repository, ".arbitra", ".gitignore"), "# kept as it was\n");
    const second = await exportPlan(orchestrator, "run-12345678-abcd");
    expect(second.directory).toBe(`${first.directory}-2`);
    expect(await readFile(join(repository, ".arbitra", ".gitignore"), "utf8")).toBe("# kept as it was\n");
    // The executor worked in the first copy; arbitra reads the newest results.json, checking every field it reads.
    await writeFile(join(first.directory, "results.json"), JSON.stringify({ issues: [
      { issue: "C-2", result: "no_change_needed", failedBefore: false, test: null, proof: "The caller guards it." },
      { issue: "C-1", result: "fixed", failedBefore: true, test: "test/a.test.ts", proof: "expected 1, got 2", checkedEndToEnd: true },
      { issue: "C-9", result: "solved", failedBefore: "yes", checkedEndToEnd: "yes" }, "not an entry"],
    foundWhileFixing: [{ title: "The port search runs past 65535", failedBefore: true }, { title: "", failedBefore: true }, { title: "Untested", failedBefore: false }, 7] }));
    expect(await planResults(repository, "run-12345678-abcd")).toEqual({ directory: first.directory, issues: 3, reported: 2,
      results: { fixed: 1, not_reproducible: 0, no_change_needed: 1, blocked: 0 }, provenByFailingTest: 1, notProvenByTest: 1, checkedEndToEnd: 1, foundWhileFixing: { reported: 2, provenByFailingTest: 1 }, invalid: 6 });
    // Each entry as the executor wrote it, for the run page: a result arbitra does not know is kept as written, and a
    // field of the wrong type reads as not recorded.
    const record = await planResultRecord(repository, "run-12345678-abcd");
    expect(record?.summary).toEqual(await planResults(repository, "run-12345678-abcd"));
    expect(record?.relative).toBe(`.arbitra/plans/${basename(first.directory)}`);
    expect(Number.isNaN(Date.parse(record?.modifiedAt ?? ""))).toBe(false);
    const none = { title: null, severity: null, task: null, test: null, proof: null, checkedEndToEnd: null };
    expect(record?.issues).toEqual([{ ...none, issue: "C-2", result: "no_change_needed", failedBefore: false, proof: "The caller guards it." },
      { ...none, issue: "C-1", result: "fixed", failedBefore: true, test: "test/a.test.ts", proof: "expected 1, got 2", checkedEndToEnd: true },
      { ...none, issue: "C-9", result: "solved", failedBefore: null }]);
    expect(record?.foundWhileFixing).toEqual([{ title: "The port search runs past 65535", severity: null, where: null, result: null, failedBefore: true, test: null, proof: null },
      { title: "Untested", severity: null, where: null, result: null, failedBefore: false, test: null, proof: null }]);
    // An entry that breaks the rules the plan's check-results.mjs applies is listed with what is wrong, by the same
    // rules: a sentence where true or false belongs is reported, not trusted and not a crash.
    expect(record?.invalid.map(({ entry }) => entry)).toEqual(["issues[2] C-9", "issues[3]", "foundWhileFixing[0] \"The port search runs past 65535\"", "foundWhileFixing[1]", "foundWhileFixing[2] \"Untested\"", "foundWhileFixing[3]"]);
    expect(record?.invalid[0]?.problems).toEqual(["failedBefore is \"yes\", not true or false (write it without quotes; a sentence belongs in proof).",
      "checkedEndToEnd is \"yes\", not true or false (write it without quotes; a sentence belongs in proof).", "result is \"solved\", not one of fixed, not_reproducible, no_change_needed, blocked.",
      "proof is empty: give the failing output, or why no test could show the defect."]);
    expect(record?.invalid[1]?.problems).toEqual([expect.stringMatching(/^is "not an entry", not an entry: each is an object with issue, title,/u)]);
    expect(record?.invalid[2]?.problems).toEqual(expect.arrayContaining(["where is empty: name the file and the symbol.", "failedBefore is true, but test is empty: name the test's file and the test."]));
    expect(await planResults(repository, "run-87654321-abcd")).toBeNull();
    expect(await planResultRecord(repository, "run-87654321-abcd")).toBeNull();
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

it("leaves out of a prompt's write scope every file its filesNotToTouch covers, by folder or by glob", async () => {
  // Only an exact path, `folder/` or `folder/**` was taken away, so a prompt listed as files to change the ones its
  // constraints said not to touch.
  const repository = await mkdtemp(join(tmpdir(), "arbitra-plan-untouched-"));
  try {
    const files = ["src/app.ts", "src/app.gen.ts", "src/generated/types.ts", "src/session.ts", "src/view.tsx"];
    for (const path of files) {
      await mkdir(join(repository, path, ".."), { recursive: true });
      await writeFile(join(repository, path), "export {};\n");
    }
    // A likely file outside the modules that the task must not touch is not offered to ask about either.
    const untouched = { ...task("TASK-1", "frontier"), scope: { likelyFiles: ["src/app.ts", "build/out.js"] }, filesNotToTouch: ["src/generated", "src/*.gen.ts", "src/{session,view}.ts*", "build"] };
    const content: Record<string, unknown> = {
      "plan-ir": { title: "Fixes", tasks: [untouched], unresolvedQuestions: [] },
      "canonical-issues": { issues: [{ candidateId: "C-1", severity: "high", disposition: "accepted", sourceFindingIds: ["auditor-a/F-1"], claim: { title: "A defect", description: "It breaks." } }] },
      "source-findings": [{ sourceFindingId: "auditor-a/F-1", locations: [{ id: "L-1", path: "src/app.ts", startLine: 1, endLine: 1 }] }],
    };
    const orchestrator = {
      overview: async () => ({ repository, workflowId: "audit-deep" }), repositoryMatches: async () => true, modules: async () => [{ id: "src", files }],
      artifacts: async () => Object.keys(content).map((kind) => ({ kind, artifactId: kind })),
      artifact: async (_runId: string, id: string) => ({ content: JSON.stringify(content[id]) }),
    } as unknown as Orchestrator;
    const { directory } = await exportPlan(orchestrator, "run-12345678-abcd");
    expect(await readFile(join(directory, "prompts", "1-strong-model", "01-TASK-1.md"), "utf8")).toContain("ask before making it.\n- src/: app.ts\n</write_scope>");
  } finally { await rm(repository, { recursive: true, force: true }); }
});

it("lists the folders a run's plan was saved to, newest first, and none for a run never saved", async () => {
  const repository = await mkdtemp(join(tmpdir(), "arbitra-plan-saved-"));
  try {
    const content = { "plan-ir": { title: "Plan", tasks: [task("TASK-1", "frontier")], unresolvedQuestions: [] }, "canonical-issues": { issues: [{ candidateId: "C-1", severity: "high", disposition: "accepted", claim: { title: "A defect", description: "It breaks." } }] } };
    const orchestrator = {
      overview: async () => ({ repository, workflowId: "audit-deep" }), repositoryMatches: async () => true, modules: async () => [],
      artifacts: async () => Object.keys(content).map((kind) => ({ kind, artifactId: kind })),
      artifact: async (_runId: string, id: keyof typeof content) => ({ content: JSON.stringify(content[id]) }),
    } as unknown as Orchestrator;
    expect(await savedPlans(orchestrator, "run-12345678-abcd")).toEqual({ saved: [] });
    const first = await exportPlan(orchestrator, "run-12345678-abcd");
    const second = await exportPlan(orchestrator, "run-12345678-abcd");
    // Another run's plan in the same project is not this run's.
    await exportPlan(orchestrator, "run-87654321-abcd");
    const { saved } = await savedPlans(orchestrator, "run-12345678-abcd");
    expect(new Set(saved.map(({ directory }) => directory))).toEqual(new Set([first.directory, second.directory]));
    expect(saved.every(({ relative }) => /^\.arbitra\/plans\/\d{4}-\d{2}-\d{2}-12345678(-2)?$/u.test(relative))).toBe(true);
    expect(saved.map(({ savedAt }) => savedAt)).toEqual(saved.map(({ savedAt }) => savedAt).sort().reverse());
    expect(await savedPlans({ overview: async () => ({ repository: null }) } as unknown as Orchestrator, "run-12345678-abcd")).toEqual({ saved: [] });
  } finally { await rm(repository, { recursive: true, force: true }); }
});

// A project where some of what a prompt names is there, some at other lines, and some never was.
const ROLLBACK = ["export function createTransaction(obs) {", "  const steps = [];", "  return {", "    async request(type, data) { steps.push({ type, data }); return obs.call(type, data); },",
  "    async rollback() { for (const step of steps.reverse()) await obs.call('Undo' + step.type); return []; },", "  };", "}", "",
  "export async function configure(obs, writeEncoderSettings, settings) {", "  const written = await writeEncoderSettings({ settings });", "  const applied = written?.applied === true;", "  return { applied };", "}", ""].join("\n");
const SERVER = ["app.post('/api/encoder-settings', (req, res) => res.json({ ok: true }));", "socket.on('obs-encoder-settings', (data, callback) => callback({ ok: true }));", ""].join("\n");
async function premiseProject() {
  const repository = await mkdtemp(join(tmpdir(), "arbitra-plan-premises-"));
  await mkdir(join(repository, "src"));
  await writeFile(join(repository, "src", "rollback.js"), ROLLBACK);
  await writeFile(join(repository, "server.js"), SERVER);
  const rollback = { ...task("TASK-1", "balanced"), scope: { likelyFiles: ["src/rollback.js"] }, readFirst: ["src/rollback.js", "test/rollback.test.js"],
    context: [
      "Lines 10-11 of src/rollback.js: `const written = await writeEncoderSettings({ settings }); const applied = written?.applied === true;`",
      "`createTransaction` keeps its steps in order, and `undoAll()` replays them.",
      "The restore endpoint gives back the previous file.",
      "POST /api/encoder-settings writes the file, and the `obs-encoder-settings` event asks the host first.",
      "Quoted: `await transaction.restore(previous);`",
      "src/legacy/rollback.js holds the old rollback."],
    implementationGuidance: ["Add registerUndo(label, fn) to the transaction.", "Call registerUndo once writeEncoderSettings succeeds."] };
  const content = {
    "plan-ir": { title: "Rollback", tasks: [rollback], unresolvedQuestions: [] },
    "canonical-issues": { issues: [{ candidateId: "C-1", severity: "medium", disposition: "accepted", claim: { title: "The encoder file is not rolled back", description: "configure() writes the file before later steps can fail." } }] },
  };
  const orchestrator = { overview: async () => ({ repository, workflowId: "audit-balanced" }), repositoryMatches: async () => true, modules: async () => [],
    artifacts: async () => Object.keys(content).map((kind) => ({ kind, artifactId: kind })), artifact: async (_runId: string, id: keyof typeof content) => ({ content: JSON.stringify(content[id]) }) } as unknown as Orchestrator;
  return { repository, orchestrator };
}

it("marks in each prompt what it names that the code lacks, counts it in the README, and makes checking it the first step", async () => {
  // Observed live (nextra, October 24, 2026): a task rested on a restore endpoint that did not exist, and quoted code was
  // stale in most prompts once earlier tasks had landed; the plan critic caught none of it.
  const { repository, orchestrator } = await premiseProject();
  try {
    const { directory, files, premises } = await exportPlan(orchestrator, "run-12345678-abcd");
    const folder = basename(directory);
    expect(files).toEqual(expect.arrayContaining([expect.stringMatching(/check-premises\.mjs$/u), expect.stringMatching(/premises\.json$/u)]));
    // The counts the README states come back with the save, and with the saved folder after a reload, for the run page.
    const named = Number(/When the plan was saved, \d+ of the (\d+) things the prompts name were found/u.exec(await readFile(join(directory, "README.md"), "utf8"))?.[1]);
    expect(premises).toEqual({ named, notFound: 4, prompts: 1 });
    expect((await savedPlans(orchestrator, "run-12345678-abcd")).saved.map((saved) => saved.premises)).toEqual([{ named, notFound: 4, prompts: 1 }]);
    // A folder saved before the premise check has no counts, and says so rather than reading as nothing missing.
    await mkdir(join(repository, ".arbitra", "plans", "2026-10-20-12345678"));
    expect((await savedPlans(orchestrator, "run-12345678-abcd")).saved.find(({ relative }) => relative.endsWith("2026-10-20-12345678"))?.premises).toBeNull();
    const prompt = await readFile(join(directory, "prompts", "2-balanced-model", "01-TASK-1.md"), "utf8");
    const notFound = /<not_found>\n([\s\S]*?)\n<\/not_found>/u.exec(prompt)?.[1] ?? "";
    expect(notFound).toContain("arbitra could not find these in the project's code when it saved this plan");
    expect(notFound).toContain("- route \"restore endpoint\": no HTTP route or socket event in the code has that name");
    expect(notFound).toContain("- name `undoAll`: not in the code");
    expect(notFound).toContain("- quote `await transaction.restore(previous);`: not in the code");
    expect(notFound).toContain("- file `src/legacy/rollback.js`: no such file");
    // What is there is not marked, nor what the steps add, nor a file the task creates (it is under <new_files>).
    expect(notFound).not.toMatch(/writeEncoderSettings|createTransaction|encoder-settings|registerUndo|rollback\.test\.js/u);
    expect(notFound.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(4);
    expect(prompt).toContain(`<steps>\n1. Before anything else, run \`node .arbitra/plans/${folder}/check-premises.mjs TASK-1\` from the repository root.`);
    expect(prompt).toContain("2. Add registerUndo(label, fn) to the transaction.\n3. Call registerUndo once writeEncoderSettings succeeds.\n</steps>");
    const readme = await readFile(join(directory, "README.md"), "utf8");
    expect(readme).toContain("1. `TASK-1` Fix TASK-1 · 2-balanced-model · 4 not found\n");
    expect(readme).toMatch(/## Premise check\n\nEach prompt's first step runs `node \.arbitra\/plans\/[^/]+\/check-premises\.mjs <task id>`/u);
    expect(readme).toMatch(/When the plan was saved, \d+ of the \d+ things the prompts name were found in the code\. 4 were not, in 1 prompt: each is marked in its prompt under `<not_found>`/u);
    expect(await readFile(join(directory, "AGENTS.md"), "utf8")).toContain(`Before you start it, run \`node .arbitra/plans/${folder}/check-premises.mjs <task id>\``);
    // The data the script needs: each premise as named, and where it was when the plan was saved.
    const data = JSON.parse(await readFile(join(directory, "premises.json"), "utf8")) as { folder: string; prompts: Record<string, { file: string; premises: unknown[] }> };
    expect(data.folder).toBe(folder);
    expect(data.prompts["TASK-1"]?.file).toBe("prompts/2-balanced-model/01-TASK-1.md");
    expect(data.prompts["TASK-1"]?.premises).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "quote", flagged: false, saved: expect.objectContaining({ place: { path: "src/rollback.js", start: 10, end: 11 } }) }),
      expect.objectContaining({ kind: "symbol", text: "createTransaction", saved: expect.objectContaining({ place: { path: "src/rollback.js", start: 1, end: 1 } }) }),
      expect.objectContaining({ kind: "route", text: "POST /api/encoder-settings", flagged: false }),
      expect.objectContaining({ kind: "event", text: "obs-encoder-settings", saved: expect.objectContaining({ place: { path: "server.js", start: 2, end: 2 } }) }),
      expect.objectContaining({ kind: "symbol", text: "registerUndo", creates: true, flagged: false })]));
  } finally { await rm(repository, { recursive: true, force: true }); }
});

it("ships a script that re-checks a prompt's premises against the working tree and prints what moved, what is gone and what was never found", async () => {
  const { repository, orchestrator } = await premiseProject();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, windowsHide: true, stdio: "ignore" });
  try {
    git("init", "-q");
    const { directory } = await exportPlan(orchestrator, "run-12345678-abcd");
    const script = join(directory, "check-premises.mjs");
    const run = (cwd: string, ...args: string[]) => {
      const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", windowsHide: true });
      return { status: result.status, out: result.stdout };
    };
    // As saved: nothing moved; what was never found is listed, and the exit status says so.
    const saved = run(repository, "TASK-1");
    expect(saved.status).toBe(1);
    expect(saved.out).toContain("Premise check for TASK-1 (prompts/2-balanced-model/01-TASK-1.md)");
    expect(saved.out).not.toContain("Moved since");
    expect(saved.out).toContain("Never found, not when the plan was saved and not now (4):\n  name `undoAll`: not in the code\n  route \"restore endpoint\": no HTTP route or socket event in the code has that name\n");
    // An earlier task moves the quoted code down three lines, drops the socket event and adds the missing name.
    await writeFile(join(repository, "src", "rollback.js"), `// one\n// two\n// three\n${ROLLBACK}export function undoAll() {}\n`);
    await writeFile(join(repository, "server.js"), `${SERVER.split("\n")[0] ?? ""}\n`);
    const later = run(join(repository, "src"), "task-1");
    expect(later.status).toBe(1);
    expect(later.out).toContain("Moved since the plan was saved (4): the same code, now at these lines.");
    expect(later.out).toContain("  quote `const written = await writeEncoderSettings({ settings }); const applied = written?.appl...`: now src/rollback.js:13-14 (was src/rollback.js:10-11)");
    expect(later.out).toContain("  name `createTransaction`: now src/rollback.js:4 (was src/rollback.js:1)");
    expect(later.out).toContain("Gone since the plan was saved (1): changed or removed, by an earlier task or another change.\n  event `obs-encoder-settings`: was server.js:2; no string in the code has this name");
    expect(later.out).toContain("In the code now, not when the plan was saved (1): an earlier task or this one added it.\n  name `undoAll`: src/rollback.js:17");
    expect(later.out).toContain("Never found, not when the plan was saved and not now (3):");
    // Machine-readable, and every prompt at once.
    const json = JSON.parse(run(repository, "TASK-1", "--json").out) as { prompts: { comparisons: unknown[] }[] };
    expect(json.prompts[0]?.comparisons).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "symbol", text: "createTransaction", change: "moved", now: { path: "src/rollback.js", start: 4, end: 4 } })]));
    expect(run(repository, "--all").out).toContain("TASK-1: 4 moved, 1 gone, 3 never found, 1 new,");
    expect(run(repository, "TASK-9")).toEqual({ status: 2, out: "check-premises: this plan has no prompt called TASK-9. Use a task id such as TASK-1.\n" });
    // A large plan's premises run past the 1 MB a code file may have and still be read (nextra's 125 prompts took 456 KB).
    const data = JSON.parse(await readFile(join(directory, "premises.json"), "utf8")) as { prompts: Record<string, unknown> };
    await writeFile(join(directory, "premises.json"), JSON.stringify({ ...data, prompts: { ...data.prompts, "TASK-2": { file: "prompts/x.md", hints: [], premises: Array.from({ length: 6_000 }, (_, index) => ({ kind: "symbol", text: `name${index}`.padEnd(200, "x"), role: "premise", saved: { status: "missing", place: null }, flagged: true })) } } }));
    expect(run(repository, "TASK-1").out).toContain("Premise check for TASK-1");
  } finally { await rm(repository, { recursive: true, force: true }); }
});

it("ships a script that checks results.json against the plan as saved and the ticks in PROGRESS.md", async () => {
  // Observed live (a messaging app's plan of 227 tasks, November 2026): every task was ticked, but 122 of 257 task
  // entries had no result and 116 proofs only pointed to commit messages; nothing checked the file.
  const { repository, orchestrator } = await premiseProject();
  try {
    const { directory } = await exportPlan(orchestrator, "run-12345678-abcd");
    const run = (...args: string[]) => {
      const result = spawnSync(process.execPath, [join(directory, "check-results.mjs"), ...args], { cwd: repository, encoding: "utf8", windowsHide: true });
      return { status: result.status, out: result.stdout };
    };
    // As saved: nothing recorded and nothing ticked, so nothing to correct yet.
    expect(run()).toEqual({ status: 0, out: expect.stringContaining("1 issue entry checked, 0 with a result, and no defect found while fixing: nothing to correct.") });
    // The task is ticked with its result left empty.
    const progress = join(directory, "PROGRESS.md");
    await writeFile(progress, (await readFile(progress, "utf8")).replace("- [ ] 01 `TASK-1`", "- [x] 01 `TASK-1`"));
    const ticked = run("--task", "TASK-1");
    expect(ticked.status).toBe(1);
    expect(ticked.out).toContain("issues[0] C-1 (TASK-1):\n  error: TASK-1 is ticked in PROGRESS.md, but C-1 has no result: record it, or untick TASK-1 if it is not done.");
    // Recorded with a pointer for a proof, then with the failing output.
    const results = join(directory, "results.json");
    const saved = JSON.parse(await readFile(results, "utf8")) as { issues: Record<string, unknown>[] };
    const record = async (entry: Record<string, unknown>) => writeFile(results, JSON.stringify({ ...saved, issues: [{ ...saved.issues[0], ...entry }] }, null, 2));
    await record({ result: "fixed", failedBefore: true, test: "test/rollback.test.js", proof: "The failing-test evidence is in each commit message", checkedEndToEnd: false });
    expect(run("--task", "TASK-1").out).toContain("error: proof only points elsewhere");
    await record({ result: "fixed", failedBefore: true, test: "test/rollback.test.js", proof: "expected the encoder file to be restored, received the new settings", checkedEndToEnd: false });
    expect(run("--task", "TASK-1").status).toBe(0);
    expect(run().status).toBe(0);
    expect(run("--task", "TASK-9")).toEqual({ status: 2, out: "check-results: this plan has no task called TASK-9. Use a task id such as TASK-1, or an unsure report's issue id.\n" });
  } finally { await rm(repository, { recursive: true, force: true }); }
});

it("masks a credential an executor's results quote before the run page reads them", async () => {
  const repository = await mkdtemp(join(tmpdir(), "arbitra-plan-results-"));
  try {
    const folder = join(repository, ".arbitra", "plans", "2026-10-25-12345678");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "results.json"), JSON.stringify({ issues: [{ issue: "C-1", result: "fixed", failedBefore: true, proof: "the log printed sk-abcdefghijklmnopqrstuv as it failed" }],
      foundWhileFixing: [{ title: "Token in a URL", where: "src/a.ts?token=sk-abcdefghijklmnopqrstuv", failedBefore: false }] }));
    const record = await planResultRecord(repository, "run-12345678-abcd");
    expect(record?.issues[0]?.proof).toContain("[REDACTED:");
    expect(JSON.stringify(record)).not.toContain("sk-abcdefghijklmnop");
  } finally { await rm(repository, { recursive: true, force: true }); }
});
