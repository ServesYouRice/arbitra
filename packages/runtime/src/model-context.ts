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

/** Bound optional source material while preserving the entire decision/evidence input. */
export function allocateModelContext(value: unknown, fits: (input: unknown) => boolean, preferredPaths: readonly string[] = []): { input: unknown; coverage: ModelContextCoverage } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    if (!fits(value)) throw new Error("MODEL_REQUIRED_CONTEXT_LIMIT_EXCEEDED");
    return { input: value, coverage: { fullPaths: [], excerptPaths: [], omittedPaths: [] } };
  }
  const record = value as Record<string, unknown>;
  const key = ["repository", "repositoryContext", "necessaryContext"].find((name) => Array.isArray(record[name]));
  if (key === undefined) {
    if (!fits(value)) throw new Error("MODEL_REQUIRED_CONTEXT_LIMIT_EXCEEDED");
    return { input: value, coverage: { fullPaths: [], excerptPaths: [], omittedPaths: [] } };
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
  if (fits(value)) return { input: value, coverage: { fullPaths: allPaths, excerptPaths: [], omittedPaths: [] } };
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
  const assembled = () => ({ ...mandatory, [key]: [...selected], contextCoverage: coverage() });
  if (!fits(assembled())) throw new Error("MODEL_REQUIRED_CONTEXT_LIMIT_EXCEEDED");
  for (const source of [...sources].sort((a, b) => priority(pathOf(a)) - priority(pathOf(b)) || pathOf(a).localeCompare(pathOf(b)))) {
    selected.push(source);
    if (fits(assembled())) continue;
    selected.pop();
    const citedRanges = ranges.get(pathOf(source));
    if (citedRanges === undefined) continue;
    const lines = source.content.split("\n");
    for (const margin of [20, 5, 0]) {
      const included = new Set<number>();
      for (const range of citedRanges) for (let line = Math.max(1, range.start - margin); line <= Math.min(lines.length, range.end + margin); line += 1) included.add(line);
      const content = [...included].sort((a, b) => a - b).map((line) => `${line}: ${lines[line - 1] ?? ""}`).join("\n");
      selected.push({ ...source, content, excerpted: true, lineNumbers: "original_source" });
      if (fits(assembled())) break;
      selected.pop();
    }
  }
  return { input: assembled(), coverage: coverage() };
}
