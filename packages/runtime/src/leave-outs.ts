/**
 * A scope's leave-outs (`scope.exclude`) as the snapshot applies them (`repository.ts`). New run counts what a run reads
 * from the list of every file before the leave-outs (`apps/web/src/pages/new-run/reading.ts`) with these same
 * functions, so its count is the snapshot's. This module imports nothing, so the web app bundles it as it is.
 *
 * Observed live (November 11, 2026): New run said 567 files and 88,659 lines where the run read 562 and 87,971. That
 * gap was two lineups, one saved before the tests in five more folders were left out; but the two sides read a
 * leave-out by rules of their own, and differed on one written as "src//gen", "src/./gen" or "lib/../gen", or with
 * spaces around it.
 */

/**
 * A leave-out as the repository-relative path it names, "/" between its parts: "\" reads as "/", "." and empty parts
 * are dropped and ".." takes back the part before it, as on disk. "" is the project itself. null for one that names
 * nothing inside the project: blank, absolute, or climbing out of it.
 */
export function leaveOutPath(entry: string): string | null {
  const text = entry.trim().replaceAll("\\", "/");
  if (text === "" || text.startsWith("/") || /^[A-Za-z]:/u.test(text)) return null;
  const parts: string[] = [];
  for (const part of text.split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") parts.push(part);
    else if (parts.pop() === undefined) return null;
  }
  return parts.join("/");
}

/** Whether a leave-out covers a repository-relative path: the path itself, or a folder above it. */
export function covers(entry: string, path: string): boolean {
  const prefix = leaveOutPath(entry);
  return prefix !== null && prefix !== "" && (path === prefix || path.startsWith(`${prefix}/`));
}

/** Whether any of the leave-outs covers the path. */
export function leftOut(exclude: readonly string[], path: string): boolean { return exclude.some((entry) => covers(entry, path)); }
