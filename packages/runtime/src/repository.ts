import { readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, relative, sep } from "node:path";
import { RepositoryPathGuard } from "@arbitra/security/path-guard";
import type { RunScope } from "@arbitra/schemas/config.js";

export interface SourceFile {
  readonly path: string;
  readonly lines: readonly string[];
  readonly byteLength: number;
  readonly lineStartBytes: readonly number[];
}

export interface RepositorySnapshot {
  readonly root: string;
  readonly files: readonly SourceFile[];
}

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "coverage", ".pnpm-store", ".runs", ".vite"]);
const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".kt", ".rb", ".cs", ".php", ".swift", ".scala", ".sql", ".css", ".scss", ".html", ".vue", ".svelte"]);
const MAXIMUM_FILE_BYTES = 512 * 1024;
const runGit = promisify(execFile);
export interface RepositoryGit { run(root: string, args: readonly string[]): Promise<string> }
const defaultGit: RepositoryGit = { async run(root, args) { return (await runGit("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true })).stdout; } };

/**
 * A read-only snapshot of the repository's source files.
 *
 * Audit and Feature modes are read-only (spec §2.1), so this only ever reads. Line start
 * offsets are carried because finding validation checks every cited line against them.
 */
export async function snapshotRepository(root: string, maximumFiles = 400, options: { readonly scope?: RunScope; readonly git?: RepositoryGit } = {}): Promise<RepositorySnapshot> {
  if (!Number.isSafeInteger(maximumFiles) || maximumFiles < 1) throw new RangeError("INVALID_MAXIMUM_FILES");
  const guard = await RepositoryPathGuard.create(root);
  const scope = options.scope ?? { kind: "repository" };
  if (scope.kind === "diff") return snapshotDiff(guard, scope, maximumFiles, options.git ?? defaultGit);
  const modules = scope.kind === "module" ? scope.modules : undefined;
  if (scope.kind === "module" && (modules === undefined || modules.length === 0)) throw new Error("MODULE_SCOPE_REQUIRED");
  const modulePaths = modules?.map((path) => relative(guard.root, guard.resolve(path)).split(sep).join("/").replace(/\/$/u, ""));
  const included = (path: string): boolean => modulePaths === undefined || modulePaths.some((prefix) => prefix === "" || path === prefix || path.startsWith(`${prefix}/`));
  const paths: string[] = [];
  await walk(root, root, paths, maximumFiles + 1, guard, included);
  if (paths.length > maximumFiles) throw new Error(`REPOSITORY_FILE_LIMIT_EXCEEDED:${maximumFiles}`);
  if (modulePaths !== undefined && paths.length === 0) throw new Error("MODULE_SCOPE_EMPTY");
  const files = await Promise.all(paths.sort().map(async (path): Promise<SourceFile> => sourceFile(path, await guard.readFile(path))));
  return Object.freeze({ root, files: Object.freeze(files) });
}

async function walk(root: string, directory: string, into: string[], limit: number, guard: RepositoryPathGuard, included: (path: string) => boolean): Promise<void> {
  if (into.length >= limit) return;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (into.length >= limit) return;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      await walk(root, full, into, limit, guard, included);
      continue;
    }
    // Dirent types are checked before extension and stat so file symlinks are never
    // followed into content outside the audited repository.
    if (!entry.isFile()) continue;
    const extension = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase();
    if (!SCANNED_EXTENSIONS.has(extension)) continue;
    const path = relative(root, full).split(sep).join("/");
    if (!included(path)) continue;
    const info = await guard.stat(path);
    if (info.size > MAXIMUM_FILE_BYTES) throw new Error(`REPOSITORY_FILE_TOO_LARGE:${path}`);
    into.push(path);
  }
}

function sourceFile(path: string, text: string): SourceFile {
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > MAXIMUM_FILE_BYTES) throw new Error(`REPOSITORY_FILE_TOO_LARGE:${path}`);
  const lines = text.split("\n");
  const lineStartBytes: number[] = [];
  let offset = 0;
  for (const line of lines) { lineStartBytes.push(offset); offset += Buffer.byteLength(line, "utf8") + 1; }
  return Object.freeze({ path, lines: Object.freeze(lines), byteLength, lineStartBytes: Object.freeze(lineStartBytes) });
}

async function snapshotDiff(guard: RepositoryPathGuard, scope: RunScope, maximumFiles: number, git: RepositoryGit): Promise<RepositorySnapshot> {
  const mode = scope.diffMode ?? "range";
  let target: string[];
  let revision: string | null;
  if (mode === "staged") { target = ["--cached"]; revision = ""; }
  else if (mode === "working_tree") { target = ["HEAD"]; revision = null; }
  else if (scope.revisionRange !== undefined) {
    const match = /^(.+?)(\.\.\.?)(.+)$/u.exec(scope.revisionRange);
    const base = match?.[1]; const head = match?.[3];
    if (base === undefined || head === undefined) throw new Error("INVALID_DIFF_RANGE");
    validateRevision(base); validateRevision(head);
    revision = (await git.run(guard.root, ["rev-parse", "--verify", `${head}^{commit}`])).trim();
    const resolvedBase = match?.[2] === "..." ? (await git.run(guard.root, ["merge-base", base, revision])).trim() : base;
    target = [resolvedBase, revision];
  } else {
    if (scope.base === undefined || scope.head === undefined) throw new Error("DIFF_REVISIONS_REQUIRED");
    validateRevision(scope.base); validateRevision(scope.head);
    revision = (await git.run(guard.root, ["rev-parse", "--verify", `${scope.head}^{commit}`])).trim();
    target = [scope.base, revision];
  }
  const names = await git.run(guard.root, ["diff", "--name-only", "--diff-filter=ACMR", "-z", ...target, "--"]);
  const paths = [...new Set(names.split("\0").filter((path) => path !== "" && SCANNED_EXTENSIONS.has(path.slice(path.lastIndexOf(".")).toLowerCase())))].sort();
  if (paths.length > maximumFiles) throw new Error(`REPOSITORY_FILE_LIMIT_EXCEEDED:${maximumFiles}`);
  const files = await Promise.all(paths.map(async (path) => {
    guard.resolve(path);
    const text = revision === null ? await guard.readFile(path) : await git.run(guard.root, ["show", `${revision}:${path}`]);
    return sourceFile(path, text);
  }));
  return Object.freeze({ root: guard.root, files: Object.freeze(files) });
}

function validateRevision(value: string): void {
  if (value.trim() === "" || value.startsWith("-") || /[\s\0:]/u.test(value)) throw new Error("INVALID_DIFF_REVISION");
}
