import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
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

/**
 * The executor's results for a run's saved plan, from the newest of its folders under `.arbitra/plans/` whose
 * `results.json` parses, or null when the plan was never saved or nothing is readable. The file is written by a
 * coding agent, so every field is checked and anything else is ignored.
 */
export async function planResults(repository: string, runId: string): Promise<PlanResults | null> {
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
    const objects = (list: unknown) => Array.isArray(list) ? list.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null) : [];
    const valid = objects(entries);
    const found = objects((parsed as { foundWhileFixing?: unknown }).foundWhileFixing).filter((entry) => typeof entry["title"] === "string" && entry["title"].trim() !== "");
    const result = (entry: Record<string, unknown>) => RESULT_VALUES.find((value) => value === entry["result"]);
    const results = Object.fromEntries(RESULT_VALUES.map((value) => [value, valid.filter((entry) => result(entry) === value).length])) as PlanResults["results"];
    return Object.freeze({ directory: candidate.directory, issues: valid.length, reported: valid.filter((entry) => result(entry) !== undefined).length, results: Object.freeze(results),
      provenByFailingTest: valid.filter((entry) => entry["failedBefore"] === true).length, notProvenByTest: valid.filter((entry) => entry["failedBefore"] === false).length,
      checkedEndToEnd: valid.filter((entry) => entry["checkedEndToEnd"] === true).length,
      foundWhileFixing: Object.freeze({ reported: found.length, provenByFailingTest: found.filter((entry) => entry["failedBefore"] === true).length }) });
  }
  return null;
}
