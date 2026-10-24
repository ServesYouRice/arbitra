import { posix } from "node:path";
import { approximateModules, resolvedImports } from "@arbitra/core/preflight/modules.js";
import type { RepositorySnapshot, SourceFile } from "./repository.js";

export interface DiscoveryScope {
  readonly files: readonly SourceFile[];
  readonly splitModules: readonly string[];
}

/** Module-first packing. An oversized module is split into whole files and the
 * lost joint context is recorded explicitly. No file is silently truncated. */
export function allocateDiscoveryScopes(snapshot: RepositorySnapshot, fits: (files: readonly SourceFile[]) => boolean): { scopes: readonly DiscoveryScope[]; unallocatedPaths: readonly string[] } {
  const files = new Map(snapshot.files.map((file) => [file.path, file]));
  const modules = approximateModules(snapshot.files.map(({ path, lines }) => ({ path, content: lines.join("\n") })));
  const grouped = new Set(modules.flatMap(({ files }) => files));
  const groups = besideTheirSource(snapshot, [...modules.map((module) => ({ id: module.id, files: module.files.flatMap((path) => { const file = files.get(path); return file === undefined ? [] : [file]; }) })),
    ...snapshot.files.filter(({ path }) => !grouped.has(path)).map((file) => ({ id: file.path, files: [file] }))].sort((a, b) => a.id.localeCompare(b.id)));
  const scopes: DiscoveryScope[] = []; const unallocatedPaths: string[] = [];
  let pending: SourceFile[] = []; let splitModules: string[] = [];
  const flush = () => { if (pending.length > 0) scopes.push({ files: pending, splitModules: [...new Set(splitModules)] }); pending = []; splitModules = []; };
  for (const group of groups) {
    const groupFiles = group.bundles.flat();
    if (fits([...pending, ...groupFiles])) { pending.push(...groupFiles); continue; }
    flush();
    if (fits(groupFiles)) { pending = [...groupFiles]; continue; }
    // An oversized module is split between bundles where it can be, so a file and its tests stay in one unit.
    for (const bundle of group.bundles) {
      if (fits([...pending, ...bundle])) { pending.push(...bundle); splitModules.push(group.id); continue; }
      if (fits(bundle)) { flush(); pending = [...bundle]; splitModules.push(group.id); continue; }
      for (const file of bundle) {
        if (!fits([file])) { unallocatedPaths.push(file.path); continue; }
        if (!fits([...pending, file])) flush();
        pending.push(file); splitModules.push(group.id);
      }
    }
    flush();
  }
  flush();
  return { scopes, unallocatedPaths: unallocatedPaths.sort() };
}

interface Group { readonly id: string; readonly files: readonly SourceFile[] }
/** A module's files in packing order, each source file in a bundle with the tests placed beside it. */
interface BundledGroup { readonly id: string; readonly bundles: readonly (readonly SourceFile[])[] }

const TEST_PATH = /(?:^|\/)(?:test|tests|__tests__|spec)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$|_test\.(?:py|go|rb)$|_spec\.rb$/u;

/**
 * Moves each test file next to the source it tests, so a discovery unit holds both. Observed live (five real runs,
 * October 2026): files were packed in path order, so `tests/` filled units of its own, and 6 to 14 accepted issues a
 * run were claims about production code that cited only test lines. A test goes right after the file it imports
 * whose name it carries (`backup.py` for `test_backup.py`, `room.ts` for `room.test.ts`), else after the last file it
 * imports; one that imports no file of the snapshot stays where it was.
 */
function besideTheirSource(snapshot: RepositorySnapshot, groups: readonly Group[]): readonly BundledGroup[] {
  const imports = importsOf(snapshot);
  const isTest = (path: string) => TEST_PATH.test(path);
  const position = new Map(groups.flatMap((group) => group.files.map(({ path }) => path)).map((path, index) => [path, index]));
  const anchors = new Map<string, string>();
  for (const { path } of snapshot.files) {
    if (!isTest(path)) continue;
    const targets = (imports.get(path) ?? []).filter((target) => !isTest(target) && position.has(target));
    const last = [...targets].sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0)).at(-1);
    if (last === undefined) continue;
    anchors.set(path, targets.find((target) => stem(target) === testedStem(path)) ?? last);
  }
  const following = new Map<string, SourceFile[]>();
  for (const group of groups) for (const file of group.files) {
    const anchor = anchors.get(file.path);
    if (anchor !== undefined) following.set(anchor, [...(following.get(anchor) ?? []), file]);
  }
  return groups.map((group) => ({ id: group.id, bundles: group.files.filter(({ path }) => !anchors.has(path)).map((file) => [file, ...(following.get(file.path) ?? [])]) }))
    .filter(({ bundles }) => bundles.length > 0);
}

function stem(path: string): string {
  return posix.basename(path).replace(/\.[^.]+$/u, "").toLowerCase();
}

function testedStem(path: string): string {
  return posix.basename(path).replace(/\.(?:test|spec)(?=\.[^.]+$)/u, "").replace(/\.[^.]+$/u, "").replace(/^test_|_(?:test|spec)$/u, "").toLowerCase();
}

/** Repository-internal imports of each file: relative JavaScript and TypeScript imports, and Python imports. */
function importsOf(snapshot: RepositorySnapshot): ReadonlyMap<string, readonly string[]> {
  const contents = snapshot.files.map(({ path, lines }) => ({ path, content: lines.join("\n") }));
  const result = new Map(resolvedImports(contents));
  const paths = new Set(snapshot.files.map(({ path }) => path));
  for (const { path, content } of contents) {
    if (!path.endsWith(".py")) continue;
    const targets = pythonImports(path, content, paths);
    if (targets.length > 0) result.set(path, [...new Set([...(result.get(path) ?? []), ...targets])].sort());
  }
  return result;
}

/**
 * The files a Python module imports: `from a.b import c` and `import a.b` resolved against each folder above the
 * importing file (so `from rokbot.backup import x` in `backend/tests/` finds `backend/rokbot/backup.py`), and
 * relative imports against the file's own package. A name after `import` may itself be a module (`from . import db`).
 */
function pythonImports(from: string, content: string, paths: ReadonlySet<string>): readonly string[] {
  const found = new Set<string>();
  const directory = posix.dirname(from);
  const ancestors = directory === "." ? [""] : directory.split("/").map((_, index, parts) => parts.slice(0, parts.length - index).join("/")).concat("");
  const resolve = (base: readonly string[], dotted: string) => {
    const relative = dotted.split(".").filter(Boolean).join("/");
    for (const root of base) {
      const stemPath = [root, relative].filter((part) => part !== "").join("/");
      for (const candidate of [`${stemPath}.py`, `${stemPath}/__init__.py`]) if (candidate !== from && paths.has(candidate)) return candidate;
    }
    return null;
  };
  for (const match of content.matchAll(/^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+\(?([\w \t,.*]+)/gmu)) {
    const [, dots = "", module = "", names = ""] = match;
    const base = dots.length === 0 ? ancestors : [posix.normalize([directory, ...Array<string>(dots.length - 1).fill("..")].join("/")).replace(/^\.$/u, "")];
    const target = module === "" ? null : resolve(base, module);
    if (target !== null) found.add(target);
    for (const name of names.split(",").map((entry) => entry.trim().split(/\s+/u)[0] ?? "").filter((entry) => /^\w+$/u.test(entry))) {
      const submodule = resolve(base, module === "" ? name : `${module}.${name}`);
      if (submodule !== null) found.add(submodule);
    }
  }
  for (const match of content.matchAll(/^[ \t]*import[ \t]+([\w.]+(?:[ \t]+as[ \t]+\w+)?(?:[ \t]*,[ \t]*[\w.]+(?:[ \t]+as[ \t]+\w+)?)*)/gmu)) {
    for (const entry of (match[1] ?? "").split(",")) {
      const target = resolve(ancestors, entry.trim().split(/\s+/u)[0] ?? "");
      if (target !== null) found.add(target);
    }
  }
  return [...found].sort();
}
