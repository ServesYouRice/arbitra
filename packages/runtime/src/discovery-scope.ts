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
  const groups = moduleGroups(snapshot);
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

/**
 * The modules discovery packs, as paths: import-connected files, each other file alone, and each test in the module of
 * the source it tests. A saved plan's write envelope is derived from it (`packages/security/src/envelope.ts`).
 */
export function modulePartition(snapshot: RepositorySnapshot): readonly { readonly id: string; readonly files: readonly string[] }[] {
  return moduleGroups(snapshot).map(({ id, bundles }) => ({ id, files: bundles.flat().map(({ path }) => path) }));
}

function moduleGroups(snapshot: RepositorySnapshot): readonly BundledGroup[] {
  const files = new Map(snapshot.files.map((file) => [file.path, file]));
  const modules = approximateModules(snapshot.files.map(({ path, lines }) => ({ path, content: lines.join("\n") })));
  const grouped = new Set(modules.flatMap(({ files: paths }) => paths));
  return besideTheirSource(snapshot, [...modules.map((module) => ({ id: module.id, files: module.files.flatMap((path) => { const file = files.get(path); return file === undefined ? [] : [file]; }) })),
    ...snapshot.files.filter(({ path }) => !grouped.has(path)).map((file) => ({ id: file.path, files: [file] }))].sort((a, b) => a.id.localeCompare(b.id)));
}

interface Group { readonly id: string; readonly files: readonly SourceFile[] }
/** A module's files in packing order, each source file in a bundle with the tests placed beside it. */
interface BundledGroup { readonly id: string; readonly bundles: readonly (readonly SourceFile[])[] }

const TEST_PATH = /(?:^|\/)(?:test|tests|__tests__|spec)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$|_test\.(?:py|go|rb|dart)$|_spec\.rb$/u;
/** Whether a repository-relative path is a test by its name or folder: what discovery packs beside its source, and
 * what New run counts as the project's test lines. */
export function isTestPath(path: string): boolean { return TEST_PATH.test(path); }

/**
 * Moves each test file next to the source it tests, so a discovery unit holds both. Observed live (five real runs,
 * October 2026): files were packed in path order, so `tests/` filled units of its own, and 6 to 14 accepted issues a
 * run were claims about production code that cited only test lines. A test goes right after the file it imports
 * whose name it carries (`backup.py` for `test_backup.py`, `room.ts` for `room.test.ts`), else after the last file it
 * imports; one that imports no file of the snapshot stays where it was.
 */
function besideTheirSource(snapshot: RepositorySnapshot, groups: readonly Group[]): readonly BundledGroup[] {
  const imports = importsOf(snapshot);
  const isTest = isTestPath;
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

/** Repository-internal imports of each file: relative JavaScript and TypeScript imports, and Python and Dart imports. */
function importsOf(snapshot: RepositorySnapshot): ReadonlyMap<string, readonly string[]> {
  const contents = snapshot.files.map(({ path, lines }) => ({ path, content: lines.join("\n") }));
  const result = new Map(resolvedImports(contents));
  const paths = new Set(snapshot.files.map(({ path }) => path));
  const dart = dartImports(contents.filter(({ path }) => path.endsWith(".dart")), paths);
  for (const { path, content } of contents) {
    const targets = path.endsWith(".py") ? pythonImports(path, content, paths) : dart.get(path) ?? [];
    if (targets.length > 0) result.set(path, [...new Set([...(result.get(path) ?? []), ...targets])].sort());
  }
  return result;
}

/**
 * The files each Dart file imports or exports: relative URIs against its folder, and `package:<name>/<path>` against
 * the `lib/` of the nearest folder above it that has one, for the names that are that package's own. The package's
 * name is in `pubspec.yaml`, which the snapshot does not read, so a name counts as the package's own when most paths
 * its files import under it are in that `lib/`: not all, since a scope may leave out generated files the app imports,
 * and `package:flutter/services.dart` beside an app's `lib/services.dart` is not, its files import Flutter's other
 * libraries too.
 */
function dartImports(files: readonly { readonly path: string; readonly content: string }[], paths: ReadonlySet<string>): ReadonlyMap<string, readonly string[]> {
  const uris = new Map(files.map(({ path, content }) => [path, [...content.matchAll(/^[ \t]*(?:import|export)[ \t]+['"]([^'"]+)['"]/gmu)].map((match) => match[1] ?? "")]));
  const packageRoot = (path: string): string | null => {
    const parts = posix.dirname(path).split("/").filter((part) => part !== ".");
    for (let length = parts.length; length >= 0; length -= 1) {
      const root = parts.slice(0, length).join("/");
      const lib = root === "" ? "lib/" : `${root}/lib/`;
      if ([...paths].some((candidate) => candidate.startsWith(lib))) return root;
    }
    return null;
  };
  const roots = new Map([...uris.keys()].map((path) => [path, packageRoot(path)]));
  const imported = new Map<string, Map<string, Set<string>>>();
  for (const [path, list] of uris) for (const uri of list) {
    const match = /^package:(\w+)\/(.+)$/u.exec(uri);
    const root = roots.get(path);
    if (match === null || root === null || root === undefined) continue;
    const names = imported.get(root) ?? new Map<string, Set<string>>();
    names.set(match[1] ?? "", (names.get(match[1] ?? "") ?? new Set()).add(match[2] ?? ""));
    imported.set(root, names);
  }
  const inLib = (root: string, rest: string) => posix.join(root, "lib", rest);
  const own = new Map([...imported].map(([root, names]) => [root, new Set([...names].filter(([, rests]) => [...rests].filter((rest) => paths.has(inLib(root, rest))).length * 2 > rests.size).map(([name]) => name))]));
  const result = new Map<string, readonly string[]>();
  for (const [path, list] of uris) {
    const root = roots.get(path) ?? null;
    const targets = list.flatMap((uri) => {
      const match = /^package:(\w+)\/(.+)$/u.exec(uri);
      if (match !== null) return root !== null && own.get(root)?.has(match[1] ?? "") === true ? [inLib(root, match[2] ?? "")] : [];
      if (uri.includes(":")) return [];
      const target = posix.normalize(posix.join(posix.dirname(path), uri));
      return paths.has(target) && target !== path ? [target] : [];
    });
    if (targets.length > 0) result.set(path, [...new Set(targets)].sort());
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
