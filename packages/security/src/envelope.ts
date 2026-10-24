export interface EnvelopeIssueLocation {
  readonly path?: string;
  readonly moduleId?: string;
}

export interface EnvelopeIssue {
  readonly id: string;
  readonly accepted: boolean;
  readonly locations: readonly EnvelopeIssueLocation[];
}

export interface EnvelopeModule {
  readonly id: string;
  readonly files: readonly string[];
}

export interface Envelope {
  readonly paths: readonly string[];
  /** The folders holding `paths` (`.` for the repository root); a new file may be added in any but the root. */
  readonly directories: readonly string[];
  readonly sourceIssueIds: readonly string[];
  readonly sourceModuleIds: readonly string[];
}

export interface ScopeOptions {
  /** Whether a path exists in the repository; without it, no new file is granted beside the envelope's files. */
  readonly exists?: (path: string) => boolean;
}

export interface ProposedScope {
  readonly writeScope: readonly string[];
  readonly filesNotToTouch?: readonly string[];
  readonly readFirst?: readonly string[];
}

export interface EffectiveScope {
  readonly granted: readonly string[];
  readonly displayedOnly: readonly string[];
  readonly readFirst: readonly string[];
}

/** Derives authority only from accepted issue locations and the trusted module partition. */
export function deriveEnvelope(
  issues: readonly EnvelopeIssue[],
  modules: readonly EnvelopeModule[],
): Envelope {
  const accepted = issues.filter((issue) => issue.accepted);
  const directPaths = new Set<string>();
  const moduleIds = new Set<string>();

  for (const issue of accepted) {
    for (const location of issue.locations) {
      const path = location.path === undefined ? null : safePath(location.path);
      if (path !== null) directPaths.add(path);
      if (location.moduleId !== undefined) moduleIds.add(location.moduleId);
    }
  }

  for (const module of modules) {
    if (module.files.some((file) => directPaths.has(safePath(file) ?? ""))) moduleIds.add(module.id);
  }

  const paths = new Set(directPaths);
  for (const module of modules) {
    if (!moduleIds.has(module.id)) continue;
    for (const file of module.files) {
      const path = safePath(file);
      if (path !== null) paths.add(path);
    }
  }

  return Object.freeze({
    paths: Object.freeze([...paths].sort()),
    directories: Object.freeze(unique([...paths].map(directoryOf))),
    sourceIssueIds: Object.freeze(accepted.map(({ id }) => id).sort()),
    sourceModuleIds: Object.freeze([...moduleIds].sort()),
  });
}

/**
 * Planner output may request less authority, but can never create more authority. Beyond the envelope's files, two
 * kinds of file are granted by rule, never by the plan's say: a test file anywhere, and a new file directly in a folder
 * of the envelope other than the repository root, where tools look for their configuration. Neither may sit in a
 * folder or have a name that starts with a dot. Observed on rokbot's plan (October 25, 2026): its API tests reach the
 * code through the app, so no import ties them to the module they test, and 41 of 84 tasks named such a test outside
 * their modules; proving each defect with a test is the plan's first step.
 */
export function intersectScope(
  proposed: ProposedScope | readonly string[],
  envelope: Envelope,
  options: ScopeOptions = {},
): EffectiveScope {
  const normalized: ProposedScope = Array.isArray(proposed)
    ? { writeScope: proposed, filesNotToTouch: [], readFirst: [] }
    : proposed as ProposedScope;
  const excluded = normalized.filesNotToTouch ?? [];
  const available = envelope.paths.filter((path) => !excluded.some((pattern) => matches(pattern, path)));
  const ruled = normalized.writeScope.flatMap((pattern) => {
    const path = safePath(pattern);
    return path === null || available.includes(path) || excluded.some((exclusion) => matches(exclusion, path)) || !grantedByRule(path, envelope, options) ? [] : [{ pattern, path }];
  });
  const write = unique([...expand(normalized.writeScope, available), ...ruled.map(({ path }) => path)]);
  const reads = expand(normalized.readFirst ?? [], available);
  const displayedOnly = unique([
    ...unmatched(normalized.writeScope, available).filter((pattern) => !ruled.some((entry) => entry.pattern === pattern)),
    ...unmatched(normalized.readFirst ?? [], available),
  ]);
  return Object.freeze({
    granted: Object.freeze(write),
    displayedOnly: Object.freeze(displayedOnly),
    readFirst: Object.freeze(reads),
  });
}

/** A test by its name; a setup file such as `conftest.py` or `test/setup.ts` is not one. */
export function isTestFile(path: string): boolean {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$|^test_[^/]+\.py$|_test\.(?:py|go|rb)$|_spec\.rb$/u.test(path.slice(path.lastIndexOf("/") + 1));
}

function grantedByRule(path: string, envelope: Envelope, { exists }: ScopeOptions): boolean {
  if (!/^[^\s*?[\]]+$/u.test(path) || path.split("/").some((part) => part.startsWith("."))) return false;
  if (isTestFile(path)) return true;
  const directory = directoryOf(path);
  return exists !== undefined && !exists(path) && directory !== "." && envelope.directories.includes(directory);
}

function directoryOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "." : path.slice(0, slash);
}

function expand(patterns: readonly string[], available: readonly string[]): string[] {
  return unique(patterns.flatMap((pattern) => available.filter((path) => matches(pattern, path))));
}

function unmatched(patterns: readonly string[], available: readonly string[]): string[] {
  return patterns.filter((pattern) => !available.some((path) => matches(pattern, path)));
}

function matches(pattern: string, path: string): boolean {
  const normalized = safePath(pattern);
  if (normalized === null) return false;
  if (normalized.endsWith("/**")) {
    const prefix = normalized.slice(0, -3).replace(/\/$/u, "");
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  if (normalized.endsWith("/")) return path.startsWith(normalized);
  return normalized === path;
}

function safePath(value: string): string | null {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/{2,}/gu, "/");
  if (normalized.length === 0 || normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized)) return null;
  if (normalized.split("/").some((part) => part === ".." || part === "." || part.length === 0)) return null;
  return normalized;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
