import type { ReadFile } from "../../api/runs.js";

/**
 * What a run reads, counted from the check's list of every file the scope reads before its leave-outs
 * (`estimate.read`), so a folder, the tests or a generated file can be left out or read again without reading the
 * project again. A leave-out is a path in `scope.exclude`; it covers the path itself and everything below it, as the
 * snapshot reads it (`packages/runtime/src/repository.ts`).
 */
export function leaveOutPath(entry: string): string { return entry.trim().replaceAll("\\", "/").replace(/^(?:\.\/)+/u, "").replace(/\/+$/u, ""); }
export function covers(entry: string, path: string): boolean { const prefix = leaveOutPath(entry); return prefix !== "" && (path === prefix || path.startsWith(`${prefix}/`)); }
export function leftOut(exclude: readonly string[], path: string): boolean { return exclude.some((entry) => covers(entry, path)); }

export interface Reading { readonly files: number; readonly lines: number; readonly testFiles: number; readonly testLines: number }
export function reading(files: readonly ReadFile[], exclude: readonly string[]): Reading {
  const read = files.filter(({ path }) => !leftOut(exclude, path));
  const tests = read.filter(({ test }) => test);
  return { files: read.length, lines: sum(read), testFiles: tests.length, testLines: sum(tests) };
}

/** A row of the folder table: a folder, or the files directly in one, and what leaving it out adds to the leave-outs. */
export interface FolderGroup { readonly id: string; readonly label: string; readonly leaveOut: readonly string[]; readonly files: readonly ReadFile[] }

/** A folder holding more than this share of the lines is shown as its own folders, so the table says where they are. */
const OPEN_SHARE = 0.75;
const OPEN_DEPTH = 3;

/** The project's folders at the top, a folder that holds most of the lines opened into its own, largest first. */
export function folderGroups(files: readonly ReadFile[]): readonly FolderGroup[] {
  const total = sum(files);
  let groups = childrenOf("", files);
  for (let depth = 0; depth < OPEN_DEPTH; depth += 1) {
    const large = groups.find((group) => !group.id.endsWith("/") && sum(group.files) > total * OPEN_SHARE);
    const opened = large === undefined ? [] : childrenOf(large.id, large.files);
    if (large === undefined || opened.length < 2) break;
    groups = groups.flatMap((group) => group === large ? opened : [group]);
  }
  return [...groups].sort((a, b) => sum(b.files) - sum(a.files) || a.label.localeCompare(b.label));
}

function childrenOf(folder: string, files: readonly ReadFile[]): FolderGroup[] {
  const depth = folder === "" ? 0 : folder.split("/").length;
  const folders = new Map<string, ReadFile[]>();
  const own: ReadFile[] = [];
  for (const entry of files) {
    const parts = entry.path.split("/");
    if (parts.length === depth + 1) { own.push(entry); continue; }
    const child = parts.slice(0, depth + 1).join("/");
    folders.set(child, [...(folders.get(child) ?? []), entry]);
  }
  const groups: FolderGroup[] = [...folders].map(([path, inside]) => ({ id: path, label: path, leaveOut: [path], files: inside }));
  if (own.length > 0) groups.push({ id: `${folder}/`, label: folder === "" ? "files at the top" : `${folder} · files in it`, leaveOut: own.map(({ path }) => path), files: own });
  return groups;
}

/** Whether a row is read: some of what it leaves out is not left out already. */
export function groupRead(group: FolderGroup, exclude: readonly string[]): boolean { return group.leaveOut.some((entry) => !leftOut(exclude, entry)); }

/**
 * The leave-outs with a row read or left out. Reading a row takes away what covers it; a path above it (typed by
 * hand) also covered the rows beside it, which stay left out under their own entries.
 */
export function withGroup(exclude: readonly string[], groups: readonly FolderGroup[], group: FolderGroup, read: boolean): readonly string[] {
  if (!read) return unique([...exclude, ...group.leaveOut]);
  const removed = exclude.filter((entry) => group.leaveOut.some((path) => covers(entry, path)));
  const kept = exclude.filter((entry) => !removed.includes(entry));
  const beside = groups.filter((other) => other !== group).flatMap(({ leaveOut }) => leaveOut.filter((path) => removed.some((entry) => covers(entry, path)) && !leftOut(kept, path)));
  return unique([...kept, ...beside]);
}

/** The fewest leave-outs that cover exactly the tests: a folder that holds only tests, else the test file itself. */
export function testCover(files: readonly ReadFile[]): readonly string[] {
  const onlyTests = (folder: string): boolean => files.every(({ path, test }) => test || !path.startsWith(`${folder}/`));
  return unique(files.filter(({ test }) => test).map(({ path }) => {
    const parts = path.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) { const folder = parts.slice(0, depth).join("/"); if (onlyTests(folder)) return folder; }
    return path;
  })).sort();
}

export function testsRead(files: readonly ReadFile[], exclude: readonly string[]): boolean { return files.some(({ path, test }) => test && !leftOut(exclude, path)); }

/** The leave-outs with the tests left out, or read again: an entry that covers tests and nothing else goes. */
export function withTests(exclude: readonly string[], files: readonly ReadFile[], read: boolean): readonly string[] {
  if (!read) return unique([...exclude, ...testCover(files)]);
  return exclude.filter((entry) => { const covered = files.filter(({ path }) => covers(entry, path)); return covered.length === 0 || covered.some(({ test }) => !test); });
}

/** The leave-outs with one path left out, or that exact entry taken away. */
export function withPath(exclude: readonly string[], path: string, leave: boolean): readonly string[] {
  return leave ? unique([...exclude, path]) : exclude.filter((entry) => leaveOutPath(entry) !== path);
}

export function sum(files: readonly { readonly lines: number }[]): number { return files.reduce((total, { lines }) => total + lines, 0); }
function unique(values: readonly string[]): string[] { return [...new Set(values)]; }
