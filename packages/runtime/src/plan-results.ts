import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { redactSecrets } from "@arbitra/security/redaction";
import { RESULT_VALUES, RESULTS_FILE } from "./plan-export.js";

/** What the executor of a saved plan reported, read back from the plan's `results.json`. */
export interface PlanResults {
  readonly directory: string;
  readonly issues: number;
  readonly reported: number;
  readonly results: Readonly<Record<(typeof RESULT_VALUES)[number], number>>;
  /** Issues whose test failed on the unchanged code for the issue's reason: proven by execution. */
  readonly provenByFailingTest: number;
  /** Issues no test could be made to fail for. */
  readonly notProvenByTest: number;
  /** Issues whose fix was also checked by a browser or integration test or a run of the app, not only by unit tests. */
  readonly checkedEndToEnd: number;
  /** Defects no issue named that the executor found while fixing, and how many of them a failing test proved. */
  readonly foundWhileFixing: { readonly reported: number; readonly provenByFailingTest: number };
}

/** One issue's entry as the executor wrote it; a field missing or of the wrong type is null, and a result arbitra does not know is kept as written. */
export interface PlanResultEntry {
  readonly issue: string; readonly title: string | null; readonly severity: string | null; readonly task: string | null; readonly result: string | null;
  readonly failedBefore: boolean | null; readonly test: string | null; readonly proof: string | null; readonly checkedEndToEnd: boolean | null;
}
/** A defect the executor found while fixing that no issue named. */
export interface FoundWhileFixingEntry {
  readonly title: string; readonly severity: string | null; readonly where: string | null; readonly result: string | null;
  readonly failedBefore: boolean | null; readonly test: string | null; readonly proof: string | null;
}
/** The newest readable `results.json` of a run's saved plan, entry by entry, with the counts `planResults` gives. */
export interface PlanResultRecord {
  readonly directory: string;
  /** The folder as a path in the project. */
  readonly relative: string;
  /** When the executor last wrote the file. */
  readonly modifiedAt: string;
  readonly summary: PlanResults;
  readonly issues: readonly PlanResultEntry[];
  readonly foundWhileFixing: readonly FoundWhileFixingEntry[];
}

type Entry = Record<string, unknown>;
interface ReadResults { readonly directory: string; readonly modified: number; readonly entries: readonly Entry[]; readonly found: readonly Entry[] }

/**
 * The newest of a run's saved plan folders under `.arbitra/plans/` whose `results.json` parses, or null when the plan
 * was never saved or nothing is readable. The file is written by a coding agent, so only entries that are objects are
 * kept, and a defect found while fixing needs a title.
 */
async function readResults(repository: string, runId: string): Promise<ReadResults | null> {
  const plans = join(repository, ".arbitra", "plans");
  const id = runId.replace(/^run-/u, "").slice(0, 8);
  const folders = await readdir(plans).catch(() => [] as string[]);
  const candidates = await Promise.all(folders.filter((name) => new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${id}(?:-\\d+)?$`, "u").test(name)).map(async (name) => {
    const path = join(plans, name, RESULTS_FILE);
    const modified = await stat(path).then(({ mtimeMs }) => mtimeMs, () => null);
    return { directory: join(plans, name), path, modified };
  }));
  for (const candidate of candidates.filter(({ modified }) => modified !== null).sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0))) {
    const parsed = await readFile(candidate.path, "utf8").then((text) => JSON.parse(text) as unknown, () => null);
    const entries = typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { issues?: unknown }).issues) ? (parsed as { issues: unknown[] }).issues : null;
    if (entries === null) continue;
    const objects = (list: unknown) => Array.isArray(list) ? list.filter((entry): entry is Entry => typeof entry === "object" && entry !== null) : [];
    const found = objects((parsed as { foundWhileFixing?: unknown }).foundWhileFixing).filter((entry) => typeof entry["title"] === "string" && entry["title"].trim() !== "");
    return { directory: candidate.directory, modified: candidate.modified ?? 0, entries: objects(entries), found };
  }
  return null;
}

function summarise(directory: string, valid: readonly Entry[], found: readonly Entry[]): PlanResults {
  const result = (entry: Entry) => RESULT_VALUES.find((value) => value === entry["result"]);
  const results = Object.fromEntries(RESULT_VALUES.map((value) => [value, valid.filter((entry) => result(entry) === value).length])) as PlanResults["results"];
  return Object.freeze({ directory, issues: valid.length, reported: valid.filter((entry) => result(entry) !== undefined).length, results: Object.freeze(results),
    provenByFailingTest: valid.filter((entry) => entry["failedBefore"] === true).length, notProvenByTest: valid.filter((entry) => entry["failedBefore"] === false).length,
    checkedEndToEnd: valid.filter((entry) => entry["checkedEndToEnd"] === true).length,
    foundWhileFixing: Object.freeze({ reported: found.length, provenByFailingTest: found.filter((entry) => entry["failedBefore"] === true).length }) });
}

/**
 * The executor's results for a run's saved plan, counted: from the newest of its folders whose `results.json` parses,
 * or null when the plan was never saved or nothing is readable. Every field is checked and anything else is ignored.
 */
export async function planResults(repository: string, runId: string): Promise<PlanResults | null> {
  const read = await readResults(repository, runId);
  return read === null ? null : summarise(read.directory, read.entries, read.found);
}

/**
 * The same results entry by entry, for the run page to show what came of each issue. The text is the executing
 * agent's, read from the project, so each string passes the secret redactor before it leaves (a proof can quote a log
 * that printed a credential).
 */
export async function planResultRecord(repository: string, runId: string): Promise<PlanResultRecord | null> {
  const read = await readResults(repository, runId);
  if (read === null) return null;
  const text = (value: unknown): string | null => typeof value === "string" && value.trim() !== "" ? redactSecrets(value).text : null;
  const flag = (value: unknown): boolean | null => typeof value === "boolean" ? value : null;
  return Object.freeze({
    directory: read.directory, relative: relative(repository, read.directory).replaceAll("\\", "/"), modifiedAt: new Date(read.modified).toISOString(),
    summary: summarise(read.directory, read.entries, read.found),
    issues: Object.freeze(read.entries.filter((entry) => typeof entry["issue"] === "string").map((entry): PlanResultEntry => Object.freeze({
      issue: String(entry["issue"]), title: text(entry["title"]), severity: text(entry["severity"]), task: text(entry["task"]), result: text(entry["result"]),
      failedBefore: flag(entry["failedBefore"]), test: text(entry["test"]), proof: text(entry["proof"]), checkedEndToEnd: flag(entry["checkedEndToEnd"]) }))),
    foundWhileFixing: Object.freeze(read.found.map((entry): FoundWhileFixingEntry => Object.freeze({
      title: text(entry["title"]) ?? "", severity: text(entry["severity"]), where: text(entry["where"]), result: text(entry["result"]),
      failedBefore: flag(entry["failedBefore"]), test: text(entry["test"]), proof: text(entry["proof"]) }))),
  });
}
