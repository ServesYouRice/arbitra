import { approximateModules } from "@arbitra/core/preflight/modules.js";

type Source = Readonly<Record<string, unknown>> & { readonly content: string };
export interface ModelContextCoverage { readonly fullPaths: readonly string[]; readonly excerptPaths: readonly string[]; readonly omittedPaths: readonly string[] }

export function withinStringBudget(value: unknown, maximumBytes: number): boolean {
  let bytes = 0;
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (typeof entry === "string") bytes += Buffer.byteLength(entry);
    else if (Array.isArray(entry)) pending.push(...entry);
    else if (typeof entry === "object" && entry !== null) pending.push(...Object.values(entry));
    if (bytes > maximumBytes) return false;
  }
  return true;
}

/** Lets an allocation add up what each source costs instead of measuring the whole input once per source.
 * `measure` sizes an input, `maximum` is the size that fits, and `of` is what one source adds to it. Observed
 * live (P20 pilot): one measurement compiles the prompt, about 4 ms, and a run made tens of thousands of them. */
export interface SourceSizing { readonly measure: (input: unknown) => number; readonly maximum: number; readonly of: (source: unknown) => number }

/** Which optional source a stage reads: every file as far as it fits (the default), or only the files its input
 * cites and the files of their modules. A stage with one narrow question reads the second. */
export type SourceScope = "all" | "cited_and_related";
export interface SourceOptions { readonly sizing?: SourceSizing; readonly scope?: SourceScope }

export interface StageContext { readonly input: unknown; readonly coverage: ModelContextCoverage; readonly reduced: boolean; readonly admittedAsRequired: boolean;
  /** Files the input cites that it carries neither whole nor as an excerpt. */
  readonly citedPathsLeftOut: readonly string[] }

/** Allocates a stage input that has to be sent. Each step is tried only when the one before cannot carry what the
 * stage must read: the input as given; its smaller form, when there is one; then the smallest form with no optional
 * source at all, checked by `admits` (the rate for required input) in place of `fits`. */
export function allocateStageContext(value: unknown, options: { readonly smaller?: unknown; readonly fits: (input: unknown) => boolean; readonly admits?: (input: unknown) => boolean; readonly preferredPaths?: readonly string[] } & SourceOptions): StageContext {
  const source: SourceOptions = { ...(options.sizing === undefined ? {} : { sizing: options.sizing }), ...(options.scope === undefined ? {} : { scope: options.scope }) };
  const steps: (() => StageContext)[] = [() => ({ ...allocateModelContext(value, options.fits, options.preferredPaths, options.fits, source), reduced: false, admittedAsRequired: false })];
  if (options.smaller !== undefined) steps.push(() => ({ ...allocateModelContext(options.smaller, options.fits, options.preferredPaths, options.fits, source), reduced: true, admittedAsRequired: false }));
  const admits = options.admits;
  if (admits !== undefined) steps.push(() => ({ ...allocateModelContext(options.smaller ?? value, () => false, options.preferredPaths, admits, options.scope === undefined ? {} : { scope: options.scope }), reduced: options.smaller !== undefined, admittedAsRequired: true }));
  for (const [index, step] of steps.entries()) {
    try { return step(); }
    catch (error) { if (index === steps.length - 1 || !(error instanceof Error) || error.message !== "MODEL_REQUIRED_CONTEXT_LIMIT_EXCEEDED") throw error; }
  }
  throw new Error("MODEL_REQUIRED_CONTEXT_LIMIT_EXCEEDED");
}

/** Bound optional source material while preserving the entire decision/evidence input. `required` judges the
 * part that cannot be left out, and is `fits` unless a caller admits that part by another measure. */
export function allocateModelContext(value: unknown, fits: (input: unknown) => boolean, preferredPaths: readonly string[] = [], required: (input: unknown) => boolean = fits, options: SourceOptions = {}): { input: unknown; coverage: ModelContextCoverage; citedPathsLeftOut: readonly string[] } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    if (!required(value)) throw new Error("MODEL_REQUIRED_CONTEXT_LIMIT_EXCEEDED");
    return { input: value, coverage: { fullPaths: [], excerptPaths: [], omittedPaths: [] }, citedPathsLeftOut: [] };
  }
  const record = value as Record<string, unknown>;
  const key = ["repository", "repositoryContext", "necessaryContext"].find((name) => Array.isArray(record[name]));
  if (key === undefined) {
    if (!required(value)) throw new Error("MODEL_REQUIRED_CONTEXT_LIMIT_EXCEEDED");
    return { input: value, coverage: { fullPaths: [], excerptPaths: [], omittedPaths: [] }, citedPathsLeftOut: [] };
  }
  const sources = (record[key] as unknown[]).map((entry): Source => {
    if (typeof entry !== "object" || entry === null || !("content" in entry) || typeof entry.content !== "string") throw new Error("INVALID_MODEL_SOURCE_CONTEXT");
    return entry as Source;
  });
  const pathOf = (entry: Source): string => {
    const path = entry["path"] ?? entry["ref"];
    if (typeof path !== "string") throw new Error("MODEL_SOURCE_PATH_REQUIRED");
    return path;
  };
  const allPaths = sources.map(pathOf);
  if (new Set(allPaths).size !== allPaths.length) throw new Error("DUPLICATE_MODEL_CONTEXT_PATH");
  // Say so when nothing is left out: models told that context "may be excerpted" otherwise
  // assume it was (observed live: a planner raised a blocking question about callers outside
  // a snapshot that held the whole repository).
  const complete = { ...record, contextCoverage: { complete: true, note: "Every file in the run's repository scope is included in full.", fullPaths: allPaths, excerptPaths: [], omittedPaths: [] } };
  const scoped = options.scope === "cited_and_related";
  if (!scoped && fits(complete)) return { input: complete, coverage: { fullPaths: allPaths, excerptPaths: [], omittedPaths: [] }, citedPathsLeftOut: [] };
  const mandatory = { ...record, [key]: [] };
  const known = new Set(allPaths); const cited = new Set(preferredPaths.filter((path) => known.has(path)));
  const ranges = new Map<string, { start: number; end: number }[]>();
  const collect = (entry: unknown): void => {
    if (typeof entry === "string" && known.has(entry)) cited.add(entry);
    else if (Array.isArray(entry)) entry.forEach(collect);
    else if (typeof entry === "object" && entry !== null) {
      const object = entry as Record<string, unknown>; const path = object["path"];
      if (typeof path === "string" && known.has(path) && Number.isSafeInteger(object["startLine"]) && Number.isSafeInteger(object["endLine"])) {
        const start = object["startLine"] as number; const end = object["endLine"] as number;
        if (start > 0 && end >= start) ranges.set(path, [...(ranges.get(path) ?? []), { start, end }]);
      }
      Object.values(object).forEach(collect);
    }
  };
  collect(mandatory);
  const related = new Set(approximateModules(sources.map((entry) => ({ path: pathOf(entry), content: entry.content }))).filter(({ files }) => files.some((path) => cited.has(path))).flatMap(({ files }) => files));
  const priority = (path: string) => cited.has(path) ? 0 : related.has(path) ? 1 : 2;
  const selected: Source[] = [];
  const coverage = (): ModelContextCoverage => ({ fullPaths: selected.filter((entry) => entry["excerpted"] !== true).map(pathOf), excerptPaths: selected.filter((entry) => entry["excerpted"] === true).map(pathOf), omittedPaths: allPaths.filter((path) => !selected.some((entry) => pathOf(entry) === path)) });
  const assembled = () => ({ ...mandatory, [key]: [...selected], contextCoverage: { complete: false, ...coverage() } });
  const sizing = options.sizing;
  // With sizing, the input without source is measured once and each source is added by what it costs.
  let used = sizing?.measure(assembled());
  if ((sizing === undefined || used === undefined || used > sizing.maximum) && !required(assembled())) throw new Error("MODEL_REQUIRED_CONTEXT_LIMIT_EXCEEDED");
  const take = (entry: Source): boolean => {
    if (sizing === undefined || used === undefined) { selected.push(entry); if (fits(assembled())) return true; selected.pop(); return false; }
    const cost = sizing.of(entry);
    if (used + cost > sizing.maximum) return false;
    selected.push(entry); used += cost; return true;
  };
  const excerpt = (source: Source, citedRanges: readonly { start: number; end: number }[], margin: number): Source => {
    const lines = source.content.split("\n");
    const included = new Set<number>();
    for (const range of citedRanges) for (let line = Math.max(1, range.start - margin); line <= Math.min(lines.length, range.end + margin); line += 1) included.add(line);
    return { ...source, content: [...included].sort((a, b) => a - b).map((line) => `${line}: ${lines[line - 1] ?? ""}`).join("\n"), excerpted: true, lineNumbers: "original_source" };
  };
  for (const source of [...sources].sort((a, b) => priority(pathOf(a)) - priority(pathOf(b)) || pathOf(a).localeCompare(pathOf(b)))) {
    if (scoped && priority(pathOf(source)) === 2) continue;
    if (take(source)) continue;
    const citedRanges = ranges.get(pathOf(source));
    if (citedRanges === undefined) continue;
    for (const margin of [20, 5, 0]) if (take(excerpt(source, citedRanges, margin))) break;
  }
  // A sum is an estimate of the whole: the whole is measured once, and the last sources go if the sum was short.
  if (sizing !== undefined) while (selected.length > 0 && !fits(assembled())) selected.pop();
  const carried = new Set(selected.map(pathOf));
  return { input: assembled(), coverage: coverage(), citedPathsLeftOut: [...cited].filter((path) => !carried.has(path)).sort() };
}
