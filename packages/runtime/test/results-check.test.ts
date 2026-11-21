import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resultsKit, resultsScript, type ResultsPlan } from "../src/results-check.js";

const kit = resultsKit();
/** A plan of two tasks and one unsure check: TASK-001 fixes C-1 and C-2, TASK-002 fixes C-3, check 01 is C-9. */
const PLAN: ResultsPlan = { run: "run-12345678-abcd", tasks: ["TASK-001", "TASK-002", "check 01"],
  entries: [{ issue: "C-1", task: "TASK-001" }, { issue: "C-2", task: "TASK-001" }, { issue: "C-3", task: "TASK-002" }, { issue: "C-9", task: "check 01" }] };
const empty = (issue: string, task: string) => ({ issue, title: `Title of ${issue}`, severity: "high", task, result: null, failedBefore: null, test: null, proof: null, checkedEndToEnd: null });
const fixed = (issue: string, task: string) => ({ ...empty(issue, task), result: "fixed", failedBefore: true, test: "test/auth.test.ts > refuses an expired token", proof: "expected 401, received 200", checkedEndToEnd: false });
/** The file as the export saved it, with these entries filled in. */
const file = (filled: Readonly<Record<string, object>> = {}, foundWhileFixing: readonly unknown[] = []) => ({ run: PLAN.run, instructions: "Fill in an entry as you finish its task.",
  issues: PLAN.entries.map(({ issue, task }) => ({ ...empty(issue, task), ...filled[issue] })), foundWhileFixing });
const progress = (ticked: readonly string[] = []) => ["# Progress", "", "Tick a task when it is done and verified.", "",
  `- [${ticked.includes("TASK-001") ? "x" : " "}] 01 \`TASK-001\` Refuse expired tokens`, "  - left open: the refresh path", `- [${ticked.includes("TASK-002") ? "x" : " "}] 02 \`TASK-002\` Bound the retries`, "",
  "## Unsure, after the tasks (optional)", "", `- [${ticked.includes("check 01") ? "X" : " "}] check 01 \`C-9\` Tokens may leak in logs`, ""].join("\n");
const errors = (checked: { readonly findings: readonly { readonly level: string; readonly entry: string; readonly message: string }[] }) => checked.findings.filter(({ level }) => level === "error").map(({ entry, message }) => `${entry}: ${message}`);
const warnings = (checked: { readonly findings: readonly { readonly level: string; readonly entry: string; readonly message: string }[] }) => checked.findings.filter(({ level }) => level === "warning").map(({ entry, message }) => `${entry}: ${message}`);

describe("an entry's own rules", () => {
  it("passes a complete record of each result, and an entry not filled in yet", () => {
    const filled = file({ "C-1": fixed("C-1", "TASK-001"), "C-2": { result: "no_change_needed", failedBefore: false, proof: "The caller checks the expiry first (src/auth.ts:40)." },
      "C-3": { result: "blocked", proof: "The retry policy needs the person's answer to Q-2." } },
    [{ title: "The port search runs past 65535", severity: "low", where: "src/ports.ts findPort", result: "fixed", failedBefore: true, test: "test/ports.test.ts", proof: "RangeError: port 65536 is out of range" }]);
    const checked = kit.check(filled, progress(["TASK-001", "TASK-002"]), PLAN, null);
    expect(checked.findings).toEqual([]);
    expect(checked).toMatchObject({ issues: 4, withResult: 3, found: 1 });
  });

  it("reports a field of the wrong type, and a result arbitra does not know", () => {
    // Observed live (a messaging app's plan, November 2026): one failedBefore held a sentence, and nothing said so.
    const found = kit.entryFindings({ ...fixed("C-1", "TASK-001"), failedBefore: "The test failed with 401 before the fix", checkedEndToEnd: 1, test: ["a.test.ts"], result: "done" }, "issues", 0).map(({ message }) => message);
    expect(found).toEqual(["test is a list, not text.", "failedBefore is \"The test failed with 401 before the fix\", not true or false (write it without quotes; a sentence belongs in proof).",
      "checkedEndToEnd is 1, not true or false.", "result is \"done\", not one of fixed, not_reproducible, no_change_needed, blocked."]);
    expect(kit.entryFindings("C-1 fixed", "issues", 4)).toEqual([{ level: "error", entry: "issues[4]", message: expect.stringMatching(/^is "C-1 fixed", not an entry: each is an object with issue, title, severity, task, result,/u) }]);
    expect(kit.entryFindings({ ...empty("", "TASK-001") }, "issues", 0).map(({ message }) => message)).toEqual(["issue is empty: keep the issue id the plan saved."]);
  });

  it("asks a recorded result for what it needs: failedBefore, the test that failed, a proof, and for a fix whether it was checked end to end", () => {
    const messages = (entry: object) => kit.entryFindings({ ...empty("C-1", "TASK-001"), ...entry }, "issues", 0).map(({ message }) => message);
    // Observed live (the same plan): failedBefore was true for only 36 of 135 fixed.
    expect(messages({ result: "fixed", test: "test/a.test.ts", proof: "expected 1, got 2", checkedEndToEnd: true }))
      .toEqual(["failedBefore is empty: true if a test failed on the unchanged code for this issue's reason, false if none could be made to fail."]);
    expect(messages({ result: "fixed", failedBefore: true, proof: "expected 1, got 2", checkedEndToEnd: true })).toEqual(["failedBefore is true, but test is empty: name the test's file and the test."]);
    expect(messages({ result: "fixed", failedBefore: true, test: "test/a.test.ts", proof: "expected 1, got 2" }))
      .toEqual(["checkedEndToEnd is empty: true if a browser or integration test or a run of the app also checked the fix, false if only unit tests did."]);
    expect(messages({ result: "no_change_needed", failedBefore: false, proof: "  " })).toEqual(["proof is empty: say why the claim does not hold, citing the lines or the output that decide it."]);
    expect(messages({ result: "not_reproducible", failedBefore: false })).toEqual(["proof is empty: say what you ran to reproduce it and what that showed."]);
    // A blocked issue may have no test either way, but says what blocked it.
    expect(messages({ result: "blocked" })).toEqual(["proof is empty: say what blocked it."]);
    expect(messages({ result: "blocked", proof: "Needs the database the tests cannot start." })).toEqual([]);
  });

  it("flags a proof that only points elsewhere, and keeps one that holds the failing output or the test's name", () => {
    // Observed live (the same plan): 116 proofs said only this.
    const proof = (text: string, test: string | null = "test/auth.test.ts > refuses an expired token") => kit.entryFindings({ ...fixed("C-1", "TASK-001"), test, proof: text, failedBefore: test !== null }, "issues", 0).map(({ message }) => message);
    expect(proof("The failing-test evidence is in each commit message")).toEqual([
      "proof only points elsewhere (\"The failing-test evidence is in each commit message\"): put the failing output in it, or the test's name and what it showed; results.json is read without the commits."]);
    expect(proof("See commit 3f2a1b9.")).toHaveLength(1);
    expect(proof("3f2a1b9")).toHaveLength(1);
    expect(proof("Fixed in the PR #42, see the diff", null)).toHaveLength(1);
    // The failing output, or the test's name, makes it a proof, whatever else it points to.
    expect(proof("Before commit 3f2a1b9 the test printed: expected 401, received 200")).toEqual([]);
    expect(proof("AssertionError in commit 3f2a1b9's parent")).toEqual([]);
    expect(proof("refuses an expired token failed before the fix; the output is in the commit message")).toEqual([]);
    expect(proof("auth.test.ts failed before; see commit 3f2a1b9")).toEqual([]);
    // A proof that points nowhere is no pointer, however short.
    expect(proof("No test can start two browsers here; checked by hand in two windows.", null)).toEqual([]);
  });

  it("holds a defect found while fixing to the same rules, with a title, a severity and where it is", () => {
    const messages = (entry: unknown) => kit.entryFindings(entry, "foundWhileFixing", 2).map(({ message }) => message);
    expect(messages({ title: "Untested", failedBefore: true })).toEqual(["severity is empty: one of informational, low, medium, high, critical.", "where is empty: name the file and the symbol.",
      "result is empty: one of fixed, not_reproducible, no_change_needed, blocked.", "failedBefore is true, but test is empty: name the test's file and the test.",
      "proof is empty: give the failing output, or why no test could show the defect."]);
    expect(messages({ title: "", severity: "severe", where: "src/a.ts", result: "fixed", failedBefore: false, proof: "No test can reach the timer." }))
      .toEqual(["title is empty: say in a line what the defect is.", "severity is \"severe\": one of informational, low, medium, high, critical."]);
    expect(messages(7)).toEqual([expect.stringMatching(/^is 7, not an entry: each is an object with title, severity, where, result,/u)]);
    expect(kit.label("foundWhileFixing", 2, { title: "The port search runs past 65535" })).toBe("foundWhileFixing[2] \"The port search runs past 65535\"");
  });

  it("warns of a field nothing reads, without failing the check", () => {
    const found = kit.entryFindings({ ...fixed("C-1", "TASK-001"), failed_before: true }, "issues", 0);
    expect(found).toEqual([{ level: "warning", entry: "issues[0] C-1 (TASK-001)", message: expect.stringMatching(/^failed_before is not a field of results\.json, so nothing reads it; the fields are issue, title,/u) }]);
  });
});

describe("the file against the plan and PROGRESS.md", () => {
  it("is an error for a ticked task whose issues have no result, and a warning for a result whose task is not ticked", () => {
    // Observed live (the same plan): every task was ticked, but 122 of 257 task entries had no result.
    const checked = kit.check(file({ "C-3": fixed("C-3", "TASK-002") }), progress(["TASK-001", "check 01"]), PLAN, null);
    expect(errors(checked)).toEqual(["issues[0] C-1 (TASK-001): TASK-001 is ticked in PROGRESS.md, but C-1 has no result: record it, or untick TASK-001 if it is not done.",
      "issues[1] C-2 (TASK-001): TASK-001 is ticked in PROGRESS.md, but C-2 has no result: record it, or untick TASK-001 if it is not done.",
      "issues[3] C-9 (check 01): check 01 is ticked in PROGRESS.md, but C-9 has no result: record it, or untick check 01 if it is not done."]);
    expect(warnings(checked)).toEqual(["issues[2] C-3 (TASK-002): C-3 has a result, but TASK-002 is not ticked in PROGRESS.md: tick it once it is verified."]);
    // Without PROGRESS.md the ticks cannot be checked, and it says so.
    expect(warnings(kit.check(file(), null, PLAN, null))).toEqual(["PROGRESS.md: is missing beside results.json, so the ticks were not checked."]);
    expect(kit.progressItems(progress(["TASK-002"]))).toEqual([{ task: "TASK-001", issue: null, ticked: false }, { task: "TASK-002", issue: null, ticked: true }, { task: "check 01", issue: "C-9", ticked: false }]);
  });

  it("holds the file to the plan as saved: one entry per issue, none for another issue, and each under its own task", () => {
    const saved = file();
    const issues = [{ ...saved.issues[0], task: "TASK-002" }, saved.issues[1], saved.issues[1], { ...empty("C-77", "TASK-002") }, saved.issues[3]];
    expect(errors(kit.check({ ...saved, issues }, progress(["TASK-002"]), PLAN, null))).toEqual([
      "issues[0] C-1 (TASK-002): task is \"TASK-002\", but the plan gives C-1 to TASK-001: keep the task as saved.",
      "issues[2] C-2 (TASK-001): repeats C-2, which issues[1] records too: keep one entry per issue.",
      "issues[3] C-77 (TASK-002): C-77 is not an issue of this plan: a defect no issue names goes under foundWhileFixing.",
      "issues[3] C-77 (TASK-002): TASK-002 is ticked in PROGRESS.md, but C-77 has no result: record it, or untick TASK-002 if it is not done.",
      "results.json: has no entry for C-3 (TASK-002): restore it as the plan saved it, with its result, as TASK-002 is ticked in PROGRESS.md."]);
    expect(errors(kit.check({ issues: "none" }, null, PLAN, null))).toEqual(["results.json: has no issues list: it is an object with run, instructions, issues and foundWhileFixing, as the plan saved it."]);
    expect(errors(kit.check({ ...saved, foundWhileFixing: {} }, null, PLAN, null))).toEqual(["results.json: foundWhileFixing is an object, not a list: [] or a list of entries."]);
  });

  it("checks one task's entries with --task, each of which then needs a result, and every defect found while fixing", () => {
    const filled = file({ "C-1": fixed("C-1", "TASK-001") }, [{ title: "A leak", severity: "low", where: "src/a.ts", result: "fixed", failedBefore: false }]);
    const one = kit.check(filled, progress(), PLAN, "TASK-001");
    expect(errors(one)).toEqual(["issues[1] C-2 (TASK-001): C-2 has no result: record it before you move on from TASK-001.",
      "foundWhileFixing[0] \"A leak\": proof is empty: give the failing output, or why no test could show the defect."]);
    expect(one).toMatchObject({ issues: 2, withResult: 1, found: 1 });
    // Another task's empty entries are not this task's errors.
    expect(errors(kit.check(file({ "C-3": fixed("C-3", "TASK-002") }), progress(["TASK-002"]), PLAN, "TASK-002"))).toEqual([]);
    // A task, a check or an unsure report's issue, however it is written.
    expect(["TASK-001", "task-1", "1", "Task-0001"].map((id) => kit.taskFor(id, PLAN))).toEqual(["TASK-001", "TASK-001", "TASK-001", "TASK-001"]);
    expect(["check 01", "check-1", "CHECK 1", "C-9", "c-9"].map((id) => kit.taskFor(id, PLAN))).toEqual(["check 01", "check 01", "check 01", "check 01", "check 01"]);
    expect(kit.taskFor("TASK-009", PLAN)).toBeNull();
  });
});

describe("the script's entry point", () => {
  const run = (argv: readonly string[], results: string | null, progressText: string | null = progress()) => {
    const lines: string[] = [];
    const status = kit.main(argv, { plan: PLAN, readResults: () => results, readProgress: () => progressText, print: (line) => lines.push(line) });
    return { status, out: lines.join("\n") };
  };

  it("prints each entry's findings under it and a summary, and exits 1 on an error, 0 on warnings alone", () => {
    const failing = run([], JSON.stringify(file({ "C-1": { ...fixed("C-1", "TASK-001"), proof: "The failing-test evidence is in each commit message" } })), progress(["TASK-001"]));
    expect(failing.status).toBe(1);
    expect(failing.out).toContain("Results check of results.json, against PROGRESS.md and the plan as saved.\n\nissues[0] C-1 (TASK-001):\n  error: proof only points elsewhere");
    expect(failing.out).toContain("issues[1] C-2 (TASK-001):\n  error: TASK-001 is ticked in PROGRESS.md, but C-2 has no result");
    expect(failing.out).toContain("4 issue entries checked, 1 with a result, and no defect found while fixing: 2 errors in 2 entries.\nCorrect each error, then run this again.");
    const warned = run(["--task", "TASK-002"], JSON.stringify(file({ "C-3": fixed("C-3", "TASK-002") })));
    expect(warned).toEqual({ status: 0, out: expect.stringContaining("1 issue entry checked, 1 with a result, and no defect found while fixing: nothing to correct, 1 warning.") });
    expect(run(["--task=check-1"], JSON.stringify(file({ "C-9": { result: "no_change_needed", failedBefore: false, proof: "The logger strips the header (src/log.ts:12)." } })), progress(["check 01"])))
      .toEqual({ status: 0, out: expect.stringContaining("Results check of results.json for check 01,") });
  });

  it("reads a file with a byte-order mark, and says what is wrong with one it cannot read", () => {
    expect(run([], `\uFEFF${JSON.stringify(file())}`).status).toBe(0);
    expect(run([], "{ \"issues\": [")).toEqual({ status: 1, out: expect.stringMatching(/^check-results: results\.json is not valid JSON \(.+\)\. Correct it, then run this again\.$/u) });
    expect(run([], null)).toEqual({ status: 1, out: expect.stringContaining("check-results: results.json is missing beside this script.") });
  });

  it("refuses a task the plan does not have, and arguments it does not take", () => {
    expect(run(["--task", "TASK-9"], JSON.stringify(file()))).toEqual({ status: 2, out: "check-results: this plan has no task called TASK-9. Use a task id such as TASK-001, or an unsure report's issue id." });
    expect(run(["--task"], JSON.stringify(file())).status).toBe(2);
    expect(run(["--json"], JSON.stringify(file())).status).toBe(2);
    expect(run(["TASK-001", "TASK-002"], JSON.stringify(file())).status).toBe(2);
    // A bare id works as --task does.
    expect(run(["2"], JSON.stringify(file({ "C-3": fixed("C-3", "TASK-002") })), progress(["TASK-002"])).status).toBe(0);
  });
});

describe("the shipped script", () => {
  it("has no imports but Node's own", () => {
    const script = resultsScript(PLAN);
    expect(script.split("\n").filter((line) => line.startsWith("import ")).every((line) => /from "node:[a-z_]+";$/u.test(line))).toBe(true);
    expect(script).toContain("const kit = (function resultsKit()");
    expect(script).toContain(`const plan = ${JSON.stringify(PLAN)};`);
  });

  it("runs on its own beside results.json and PROGRESS.md, from any folder", async () => {
    const folder = await mkdtemp(join(tmpdir(), "arbitra-results-check-"));
    try {
      await writeFile(join(folder, "check-results.mjs"), resultsScript(PLAN));
      await writeFile(join(folder, "results.json"), JSON.stringify(file({ "C-1": { ...fixed("C-1", "TASK-001"), failedBefore: "yes" } }), null, 2));
      await writeFile(join(folder, "PROGRESS.md"), progress(["TASK-001"]));
      const node = (...args: string[]) => { const result = spawnSync(process.execPath, [join(folder, "check-results.mjs"), ...args], { cwd: tmpdir(), encoding: "utf8", windowsHide: true }); return { status: result.status, out: result.stdout }; };
      const one = node("--task", "TASK-001");
      expect(one.status).toBe(1);
      expect(one.out).toContain("issues[0] C-1 (TASK-001):\n  error: failedBefore is \"yes\", not true or false");
      expect(one.out).toContain("issues[1] C-2 (TASK-001):\n  error: TASK-001 is ticked in PROGRESS.md, but C-2 has no result");
      await writeFile(join(folder, "results.json"), JSON.stringify(file({ "C-1": fixed("C-1", "TASK-001"), "C-2": fixed("C-2", "TASK-001") })));
      expect(node("--task", "task-1")).toEqual({ status: 0, out: expect.stringContaining("2 issue entries checked, 2 with a result, and no defect found while fixing: nothing to correct.") });
      expect(node("--task", "TASK-9").status).toBe(2);
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
});
