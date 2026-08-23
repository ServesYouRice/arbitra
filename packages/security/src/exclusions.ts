const MANDATORY_ROOTS = new Set(["implementation", ".runs"]);
const DEFAULT_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "build",
  "vendor",
  ".cache",
  "coverage",
]);

export interface ExclusionPolicy {
  readonly patterns: readonly string[];
}

export function createExclusionPolicy(ignoreFile = ""): ExclusionPolicy {
  const patterns = ignoreFile
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  return Object.freeze({ patterns: Object.freeze(patterns) });
}

export function isExcluded(path: string, policy: ExclusionPolicy = createExclusionPolicy()): boolean {
  const normalized = normalizeRepositoryPath(path);
  if (normalized === null) return true;
  const segments = normalized.split("/");
  const first = segments[0];
  if (first !== undefined && MANDATORY_ROOTS.has(first)) return true;
  if (segments.some((segment) => DEFAULT_SEGMENTS.has(segment))) return true;

  let excluded = false;
  for (const rawPattern of policy.patterns) {
    const negated = rawPattern.startsWith("!");
    const pattern = negated ? rawPattern.slice(1) : rawPattern;
    if (pattern.length > 0 && matchesIgnorePattern(normalized, pattern)) excluded = !negated;
  }
  return excluded;
}

function normalizeRepositoryPath(path: string): string | null {
  if (path.includes("\0") || /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith("/")) return null;
  const parts: string[] = [];
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}

function matchesIgnorePattern(path: string, rawPattern: string): boolean {
  const directoryPattern = rawPattern.endsWith("/");
  const rooted = rawPattern.startsWith("/");
  const normalized = rawPattern.replace(/^\//u, "").replace(/\/$/u, "");
  if (normalized.length === 0) return false;
  let regexBody = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*" && normalized[index + 1] === "*") {
      regexBody += ".*";
      index += 1;
    } else if (character === "*") {
      regexBody += "[^/]*";
    } else if (character === "?") {
      regexBody += "[^/]";
    } else if (character !== undefined) {
      regexBody += character.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
    }
  }
  const prefix = rooted || normalized.includes("/") ? "^" : "(?:^|/)";
  const suffix = directoryPattern ? "(?:/|$)" : "$";
  return new RegExp(`${prefix}${regexBody}${suffix}`, "u").test(path);
}
