/**
 * The results check of a saved plan. The executing agent records each issue's result in `results.json`, and arbitra
 * reads it back to count the defects a failing test proved. Observed live (a messaging app's plan of 227 tasks, carried
 * out October 31 to November 11, 2026): every task in PROGRESS.md was ticked, but 122 of 257 task entries and 40 of 42
 * unsure-report entries had no result, 116 proofs said only "The failing-test evidence is in each commit message",
 * failedBefore was true for 36 of 135 fixed, one failedBefore held a sentence, and only one defect found while fixing
 * was recorded. Nothing checked the file, so it could not serve the measurements it exists for.
 *
 * Its rules live in `resultsKit`, one function that refers to nothing outside itself. arbitra's reader
 * (`plan-results.ts`) applies its entry rules when it reads the file back, and the export writes its source into the
 * plan folder as `check-results.mjs` (`resultsScript`), so the agent's check and arbitra's reading agree. Keep it
 * self-contained: no imports and no module-level names inside it, only the types below, which compile away.
 */

/** The list of results.json an entry is in. */
export type ResultsList = "issues" | "foundWhileFixing";
/** One thing wrong with results.json: an error makes the script exit 1, a warning does not. */
export interface ResultsFinding {
  readonly level: "error" | "warning";
  /** The entry, as `issues[3] C-12 (TASK-012)` or `foundWhileFixing[0] "its title"`, or the file it is about. */
  readonly entry: string;
  readonly message: string;
}
/** The plan as the export saved it, written into the script: its tasks and checks, and the task each issue's entry is for. */
export interface ResultsPlan {
  readonly run: string;
  /** Task ids and unsure checks (`check 01`), in the order of work. */
  readonly tasks: readonly string[];
  readonly entries: readonly { readonly issue: string; readonly task: string }[];
}
/** A line of PROGRESS.md: a task (`TASK-012`) or an unsure check (`check 01`, with its issue), and whether it is ticked. */
export interface ProgressItem { readonly task: string; readonly issue: string | null; readonly ticked: boolean }
/** What a check of the whole file, or of one task's entries, found. */
export interface ResultsCheck {
  readonly findings: readonly ResultsFinding[];
  /** The issue entries checked, and how many of them have a result. */
  readonly issues: number; readonly withResult: number;
  /** The defects found while fixing; every check reads them all. */
  readonly found: number;
}
export interface ResultsEnvironment {
  readonly plan: ResultsPlan;
  /** results.json and PROGRESS.md beside the script; null when missing. */
  readonly readResults: () => string | null;
  readonly readProgress: () => string | null;
  readonly print: (line: string) => void;
}

export function resultsKit() {
  const RESULTS = ["fixed", "not_reproducible", "no_change_needed", "blocked"] as const;
  const SEVERITIES = ["informational", "low", "medium", "high", "critical"] as const;
  const FIELDS: Readonly<Record<ResultsList, readonly string[]>> = {
    issues: ["issue", "title", "severity", "task", "result", "failedBefore", "test", "proof", "checkedEndToEnd"],
    foundWhileFixing: ["title", "severity", "where", "result", "failedBefore", "test", "proof", "checkedEndToEnd"],
  };
  const TEXT = ["issue", "title", "severity", "task", "where", "test", "proof"];
  const FLAGS = ["failedBefore", "checkedEndToEnd"];
  // What a proof asks for, by result.
  const PROOF: Readonly<Record<string, string>> = {
    not_reproducible: "say what you ran to reproduce it and what that showed",
    no_change_needed: "say why the claim does not hold, citing the lines or the output that decide it",
    blocked: "say what blocked it",
  };
  const proofFor = (result: unknown): string => (typeof result === "string" ? PROOF[result] : undefined) ?? "give the failing output, or why no test could show the defect";
  // A proof that sends the reader to a commit, a log or a pull request, or is only a commit's hash. The file is read
  // without them: the measured plan's 116 such proofs said only "The failing-test evidence is in each commit message".
  const POINTER = /\b(?:commits?(?:\s+messages?)?|git\s+(?:log|show)|pull\s+requests?|PR\s*#\d+|changelog|the\s+diff|see\s+(?:above|below|the\s+(?:log|logs|output|report|diff|history)))\b|^\s*[0-9a-f]{7,40}\s*\.?\s*$/iu;
  // What failing output reads like: a runner's words, an error's name, or a value against the one expected.
  const OUTPUT_WORDS = /\b(?:expected|received|assert(?:ion)?\w*|threw|thrown|got|actual|returned|printed|timed\s+out|not\s+ok|panicked|traceback|exit(?:ed)?\s+(?:code|status|with)|status\s+\d{3}|\d+\s+(?:failed|failing|passed|passing))\b/iu;
  const OUTPUT_MARKS = /\b[A-Z]\w*(?:Error|Exception)\b|\bError:|\bFAIL\b|\bERR!|[\u2717\u00d7\u2715]/u;

  // Plain ASCII apart from the agent's own text: the script prints to any console.
  const clip = (text: string, size = 60): string => { const one = text.replace(/\s+/gu, " ").trim(); return one.length <= size ? one : `${one.slice(0, size - 3)}...`; };
  const shown = (value: unknown): string => typeof value === "string" ? JSON.stringify(clip(value)) : value === null ? "null" : Array.isArray(value) ? "a list" : typeof value === "object" ? "an object" : String(value);
  const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;
  const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);
  const blank = (value: unknown): boolean => value === undefined || value === null || (typeof value === "string" && value.trim() === "");

  /** The file's text as JSON, a byte-order mark allowed (PowerShell writes one); the parser's message when it is not JSON. */
  function parse(text: string): { readonly value: unknown } | { readonly error: string } {
    try { return { value: JSON.parse(text.replace(/^\uFEFF/u, "")) as unknown }; } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  }

  /** An entry as messages name it: its place in the list, then its issue and task, or its title. */
  function label(list: ResultsList, index: number, entry: unknown): string {
    const record = isRecord(entry) ? entry : {};
    const text = (key: string): string | null => { const value = record[key]; return typeof value === "string" && value.trim() !== "" ? clip(value, 50) : null; };
    if (list === "issues") { const issue = text("issue"); const task = text("task"); return `issues[${index}]${issue === null ? "" : ` ${issue}`}${task === null ? "" : ` (${task})`}`; }
    const title = text("title");
    return `foundWhileFixing[${index}]${title === null ? "" : ` "${title}"`}`;
  }

  /** The names a proof can give its test by: the whole of `test`, each part of it, and each part's file name. */
  function testNames(test: string): string[] {
    const parts = test.split(/\s*(?:\u203a|>|::|#|\s-\s|:\s)\s*/u).map((part) => part.trim().replace(/^['"`]+|['"`]+$/gu, ""));
    return [test.trim(), ...parts, ...parts.map((part) => part.slice(Math.max(part.lastIndexOf("/"), part.lastIndexOf("\\")) + 1))].filter((name) => name.length >= 4);
  }
  /** A proof that only points elsewhere: to a commit or a log, with neither the failing output nor the test's name. */
  function pointsElsewhere(proof: string, test: unknown): boolean {
    if (!POINTER.test(proof) || OUTPUT_WORDS.test(proof) || OUTPUT_MARKS.test(proof)) return false;
    const lower = proof.toLowerCase();
    return !(typeof test === "string" && testNames(test).some((name) => lower.includes(name.toLowerCase())));
  }

  /**
   * What is wrong with one entry by itself: a field of the wrong type, a result arbitra does not know, what a recorded
   * result needs (failedBefore, the test when one failed, a proof, and for a fix whether it was checked end to end), and
   * a proof that only points elsewhere. A defect found while fixing is a recorded result, so it needs all of it.
   */
  function entryFindings(entry: unknown, list: ResultsList, index: number): ResultsFinding[] {
    const at = label(list, index, entry);
    const found: ResultsFinding[] = [];
    const error = (message: string): void => { found.push({ level: "error", entry: at, message }); };
    if (!isRecord(entry)) { error(`is ${shown(entry)}, not an entry: each is an object with ${FIELDS[list].join(", ")}.`); return found; }
    const value = (key: string): unknown => entry[key];
    // A field of the wrong type is an error whether or not a result is set: arbitra reads it as not recorded.
    for (const key of TEXT) if (!blank(value(key)) && typeof value(key) !== "string") error(`${key} is ${shown(value(key))}, not text.`);
    for (const key of FLAGS) {
      if (!blank(value(key)) && typeof value(key) !== "boolean") error(`${key} is ${shown(value(key))}, not true or false${typeof value(key) === "string" ? " (write it without quotes; a sentence belongs in proof)" : ""}.`);
    }
    const result = value("result");
    if (!blank(result) && !(RESULTS as readonly unknown[]).includes(result)) error(`result is ${shown(result)}, not one of ${RESULTS.join(", ")}.`);
    for (const key of Object.keys(entry)) {
      if (!FIELDS[list].includes(key)) found.push({ level: "warning", entry: at, message: `${key} is not a field of results.json, so nothing reads it; the fields are ${FIELDS[list].join(", ")}.` });
    }
    const reason = list === "issues" ? "this issue's" : "this defect's";
    if (list === "issues" && blank(value("issue"))) error("issue is empty: keep the issue id the plan saved.");
    if (list === "foundWhileFixing") {
      if (blank(value("title"))) error("title is empty: say in a line what the defect is.");
      if (typeof value("severity") === "string" ? !(SEVERITIES as readonly unknown[]).includes(value("severity")) : blank(value("severity"))) {
        error(`severity is ${blank(value("severity")) ? "empty" : shown(value("severity"))}: one of ${SEVERITIES.join(", ")}.`);
      }
      if (blank(value("where"))) error("where is empty: name the file and the symbol.");
      if (blank(result)) error(`result is empty: one of ${RESULTS.join(", ")}.`);
    } else if (blank(result)) return found;
    // What a recorded result needs.
    if (result !== "blocked" && blank(value("failedBefore"))) error(`failedBefore is empty: true if a test failed on the unchanged code for ${reason} reason, false if none could be made to fail.`);
    if (value("failedBefore") === true && blank(value("test"))) error("failedBefore is true, but test is empty: name the test's file and the test.");
    const proof = value("proof");
    if (blank(proof)) error(`proof is empty: ${proofFor(result)}.`);
    else if (typeof proof === "string" && pointsElsewhere(proof, value("test"))) {
      error(`proof only points elsewhere (${shown(proof)}): put the failing output in it, or the test's name and what it showed; results.json is read without the commits.`);
    }
    if (list === "issues" && result === "fixed" && blank(value("checkedEndToEnd"))) error("checkedEndToEnd is empty: true if a browser or integration test or a run of the app also checked the fix, false if only unit tests did.");
    return found;
  }

  const ITEM = /^\s*[-*+]\s+\[([ xX])\]\s+(?:check\s+(\d+)|\d+)\s+`([^`]+)`/u;
  /** The tasks and checks of PROGRESS.md as the export wrote them, ticked or not; notes under them are not items. */
  function progressItems(text: string): ProgressItem[] {
    return text.split(/\r?\n/u).flatMap((line): ProgressItem[] => {
      const match = ITEM.exec(line);
      if (match?.[3] === undefined) return [];
      const ticked = match[1] !== " ";
      return [match[2] === undefined ? { task: match[3], issue: null, ticked } : { task: `check ${match[2]}`, issue: match[3], ticked }];
    });
  }

  /** The plan's own name for a task or check: `12`, `task-12` and `TASK-012` name TASK-012, `check 1` names check 01, and an unsure report's issue id its check. */
  function taskFor(id: string, plan: ResultsPlan): string | null {
    const wanted = id.trim().replace(/\s+/gu, " ").toUpperCase();
    const number = /^(?:TASK-?)?0*(\d+)$/u.exec(wanted)?.[1];
    const check = /^CHECK[ -]?0*(\d+)$/u.exec(wanted)?.[1];
    return plan.tasks.find((task) => task.toUpperCase() === wanted)
      ?? (number === undefined ? undefined : plan.tasks.find((task) => new RegExp(`^TASK-0*${number}$`, "u").test(task.toUpperCase())))
      ?? (check === undefined ? undefined : plan.tasks.find((task) => new RegExp(`^CHECK 0*${check}$`, "u").test(task.toUpperCase())))
      ?? plan.entries.find((entry) => entry.issue.toUpperCase() === wanted)?.task ?? null;
  }

  /**
   * The file against the plan and PROGRESS.md: each entry's own rules, an entry for each issue the plan saved and none
   * for another, a result for each issue of a ticked task (an error) and a tick for each task with a result (a
   * warning). `only` limits it to one task's entries, each of which then needs a result; the defects found while fixing
   * are always checked, as they name no task.
   */
  function check(parsed: unknown, progress: string | null, plan: ResultsPlan, only: string | null): ResultsCheck {
    const findings: ResultsFinding[] = [];
    const add = (level: "error" | "warning", entry: string, message: string): void => { findings.push({ level, entry, message }); };
    if (!isRecord(parsed) || !Array.isArray(parsed["issues"])) {
      add("error", "results.json", "has no issues list: it is an object with run, instructions, issues and foundWhileFixing, as the plan saved it.");
      return { findings, issues: 0, withResult: 0, found: 0 };
    }
    const issues = parsed["issues"] as readonly unknown[];
    const listed = parsed["foundWhileFixing"];
    if (listed !== undefined && !Array.isArray(listed)) add("error", "results.json", `foundWhileFixing is ${shown(listed)}, not a list: [] or a list of entries.`);
    const items = progress === null ? null : progressItems(progress);
    const ticked = new Set((items ?? []).filter((item) => item.ticked).map((item) => taskFor(item.task, plan) ?? item.task));
    const planned = new Map(plan.entries.map(({ issue, task }) => [issue, task]));
    const seen = new Map<string, number>();
    let count = 0;
    let withResult = 0;
    issues.forEach((entry, index) => {
      const record = isRecord(entry) ? entry : null;
      const named = record?.["issue"];
      const issue = typeof named === "string" && named.trim() !== "" ? named : null;
      const given = record?.["task"];
      const own = typeof given === "string" ? given : null;
      const task = (issue === null ? undefined : planned.get(issue)) ?? own;
      if (only !== null && task !== only) return;
      count += 1;
      const recorded = record !== null && !blank(record["result"]);
      if (recorded) withResult += 1;
      findings.push(...entryFindings(entry, "issues", index));
      if (issue === null) return;
      const at = label("issues", index, entry);
      const earlier = seen.get(issue);
      if (earlier === undefined) seen.set(issue, index); else add("error", at, `repeats ${issue}, which issues[${earlier}] records too: keep one entry per issue.`);
      const saved = planned.get(issue);
      if (saved === undefined) add("error", at, `${issue} is not an issue of this plan: a defect no issue names goes under foundWhileFixing.`);
      else if (own !== null && own !== saved) add("error", at, `task is ${shown(own)}, but the plan gives ${issue} to ${saved}: keep the task as saved.`);
      if (task === null) return;
      if (!recorded && ticked.has(task)) add("error", at, `${task} is ticked in PROGRESS.md, but ${issue} has no result: record it, or untick ${task} if it is not done.`);
      else if (!recorded && only !== null) add("error", at, `${issue} has no result: record it before you move on from ${task}.`);
      else if (recorded && items !== null && !ticked.has(task)) add("warning", at, `${issue} has a result, but ${task} is not ticked in PROGRESS.md: tick it once it is verified.`);
    });
    // An entry the plan saved that the file has lost.
    for (const { issue, task } of plan.entries) {
      if ((only === null || task === only) && !seen.has(issue)) add("error", "results.json", `has no entry for ${issue} (${task}): restore it as the plan saved it${ticked.has(task) ? `, with its result, as ${task} is ticked in PROGRESS.md` : ""}.`);
    }
    const found = Array.isArray(listed) ? listed as readonly unknown[] : [];
    found.forEach((entry, index) => { findings.push(...entryFindings(entry, "foundWhileFixing", index)); });
    if (items === null) add("warning", "PROGRESS.md", "is missing beside results.json, so the ticks were not checked.");
    return { findings, issues: count, withResult, found: found.length };
  }

  /** The check as the script prints it: each entry's findings under it, then a summary. */
  function report(checked: ResultsCheck, only: string | null): string[] {
    const lines = [`Results check of results.json${only === null ? "" : ` for ${only}`}, against PROGRESS.md and the plan as saved.`, ""];
    const byEntry = new Map<string, ResultsFinding[]>();
    for (const finding of checked.findings) byEntry.set(finding.entry, [...byEntry.get(finding.entry) ?? [], finding]);
    for (const [entry, findings] of byEntry) lines.push(`${entry}:`, ...findings.map(({ level, message }) => `  ${level}: ${message}`));
    if (byEntry.size > 0) lines.push("");
    const errors = checked.findings.filter(({ level }) => level === "error");
    const warnings = checked.findings.length - errors.length;
    const flawed = new Set(errors.map(({ entry }) => entry)).size;
    if (only !== null && checked.issues === 0) lines.push(`${only} has no entry of its own: an issue it shares with an earlier task is recorded under that task.`);
    lines.push(`${plural(checked.issues, "issue entry", "issue entries")} checked, ${checked.withResult} with a result, and ${checked.found === 0 ? "no defect" : plural(checked.found, "defect")} found while fixing: ${
      errors.length === 0 ? "nothing to correct" : `${plural(errors.length, "error")} in ${plural(flawed, "entry", "entries")}`}${warnings === 0 ? "" : `, ${plural(warnings, "warning")}`}.`);
    if (errors.length > 0) lines.push("Correct each error, then run this again. arbitra reads a field of the wrong type as not recorded, and a proof only for what it says.");
    return lines;
  }

  /** The shipped script's entry point: `node check-results.mjs [--task TASK-012]`. */
  function main(argv: readonly string[], { plan, readResults, readProgress, print }: ResultsEnvironment): number {
    const usage = "Usage: node check-results.mjs [--task <task id such as TASK-012, or an unsure report's issue id>]; without --task it checks the whole file.";
    const flag = argv.findIndex((argument) => argument === "--task" || argument.startsWith("--task="));
    const given = flag < 0 ? null : argv[flag]?.startsWith("--task=") === true ? argv[flag]?.slice("--task=".length) ?? "" : argv[flag + 1] ?? "";
    const loose = argv.filter((argument, index) => index !== flag && !(index === flag + 1 && argv[flag] === "--task"));
    if (loose.some((argument) => argument.startsWith("-")) || loose.length > (flag < 0 ? 1 : 0) || given === "" || given?.startsWith("-") === true) { print(usage); return 2; }
    const named = given ?? loose[0] ?? null;
    const only = named === null ? null : taskFor(named, plan);
    if (named !== null && only === null) { print(`check-results: this plan has no task called ${named}. Use a task id such as ${plan.tasks[0] ?? "TASK-001"}, or an unsure report's issue id.`); return 2; }
    const text = readResults();
    if (text === null) { print("check-results: results.json is missing beside this script. Restore it as the plan saved it: arbitra reads each issue's result from it."); return 1; }
    const parsed = parse(text);
    if ("error" in parsed) { print(`check-results: results.json is not valid JSON (${parsed.error}). Correct it, then run this again.`); return 1; }
    const checked = check(parsed.value, readProgress(), plan, only);
    for (const line of report(checked, only)) print(line);
    return checked.findings.some(({ level }) => level === "error") ? 1 : 0;
  }

  return { results: RESULTS, severities: SEVERITIES, parse, label, entryFindings, progressItems, taskFor, check, report, main };
}

export type ResultsKit = ReturnType<typeof resultsKit>;

/**
 * The script shipped in each plan folder: the kit's own source, the plan as saved, and its entry point, plain Node with
 * no dependencies. It reads results.json and PROGRESS.md beside it.
 */
export function resultsScript(plan: ResultsPlan): string {
  return ["#!/usr/bin/env node",
    "// Written by arbitra with this plan. It checks results.json beside it: each entry's fields and types, a result for",
    "// each issue of a task ticked in PROGRESS.md, and a proof that holds the failing output or the test's name rather",
    "// than pointing to a commit. Plain Node 22 or later, no dependencies.",
    "//   node .arbitra/plans/<this folder>/check-results.mjs --task TASK-012   one task's entries, when it is done",
    "//   node .arbitra/plans/<this folder>/check-results.mjs                   the whole file",
    "// Exit status: 0 when nothing needs correcting (warnings may remain), 1 when something does, 2 on a usage error.",
    "import { readFileSync } from \"node:fs\";",
    "import { dirname, join } from \"node:path\";",
    "import { fileURLToPath } from \"node:url\";",
    "",
    `const kit = (${resultsKit.toString()})();`,
    "",
    "// The plan as arbitra saved it: its tasks and checks, and the task each issue's entry belongs to.",
    `const plan = ${JSON.stringify(plan)};`,
    "const here = dirname(fileURLToPath(import.meta.url));",
    "const read = (name) => { try { return readFileSync(join(here, name), \"utf8\"); } catch { return null; } };",
    "process.exitCode = kit.main(process.argv.slice(2), { plan, readResults: () => read(\"results.json\"), readProgress: () => read(\"PROGRESS.md\"), print: (line) => process.stdout.write(`${line}\\n`) });",
    ""].join("\n");
}
