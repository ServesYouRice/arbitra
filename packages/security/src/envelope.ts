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
  readonly sourceIssueIds: readonly string[];
  readonly sourceModuleIds: readonly string[];
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
    sourceIssueIds: Object.freeze(accepted.map(({ id }) => id).sort()),
    sourceModuleIds: Object.freeze([...moduleIds].sort()),
  });
}

/** Planner output may request less authority, but can never create more authority. */
export function intersectScope(
  proposed: ProposedScope | readonly string[],
  envelope: Envelope,
): EffectiveScope {
  const normalized: ProposedScope = Array.isArray(proposed)
    ? { writeScope: proposed, filesNotToTouch: [], readFirst: [] }
    : proposed as ProposedScope;
  const excluded = normalized.filesNotToTouch ?? [];
  const available = envelope.paths.filter((path) => !excluded.some((pattern) => matches(pattern, path)));
  const write = expand(normalized.writeScope, available);
  const reads = expand(normalized.readFirst ?? [], available);
  const displayedOnly = unique([
    ...unmatched(normalized.writeScope, available),
    ...unmatched(normalized.readFirst ?? [], available),
  ]);
  return Object.freeze({
    granted: Object.freeze(write),
    displayedOnly: Object.freeze(displayedOnly),
    readFirst: Object.freeze(reads),
  });
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
