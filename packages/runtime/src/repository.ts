import { readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, relative, sep } from "node:path";
import { RepositoryPathGuard } from "@arbitra/security/path-guard";
import { maskPrivateKeyBlocks } from "@arbitra/security/redaction";
import type { RunScope } from "@arbitra/schemas/config.js";

export interface SourceFile {
  readonly path: string;
  readonly lines: readonly string[];
  readonly byteLength: number;
  readonly lineStartBytes: readonly number[];
  /** Present when every line ended in "\r\n": the "\r" is then not in `lines`, and `fileContent` restores it. */
  readonly lineEnding?: "\r\n";
}

/** The file's text as it is on disk (private key blocks masked), for hashing and writing; prompts read `lines`. */
export function fileContent(file: Pick<SourceFile, "lines" | "lineEnding">): string { return file.lines.join(file.lineEnding ?? "\n"); }

export interface RepositorySnapshot {
  readonly root: string;
  readonly files: readonly SourceFile[];
}

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "coverage", ".pnpm-store", ".runs", ".vite"]);
// Source a model can audit, not content or data: Markdown, MDX, JSON and YAML stay out. A test run on an Astro blog
// (October 22, 2026) left out all 30 of its `.astro` pages, layouts and components, so single-file components, shell
// scripts and the C family were added with the other common languages. A web app manifest is read with the page
// source: on nextra (October 23, 2026) the app's "peer-to-peer" claim was only in `public/manifest.webmanifest`.
const SCANNED_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".astro", ".html", ".css", ".scss", ".webmanifest",
  ".py", ".go", ".rs", ".java", ".kt", ".scala", ".groovy", ".rb", ".cs", ".fs", ".php", ".swift", ".dart",
  ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".m", ".mm", ".zig",
  ".ex", ".exs", ".erl", ".hs", ".ml", ".clj", ".cljs", ".jl", ".lua", ".pl", ".pm", ".r", ".sol",
  ".sh", ".bash", ".ps1", ".psm1", ".sql", ".prisma", ".graphql", ".gql", ".proto", ".tf",
]);
const MAXIMUM_FILE_BYTES = 512 * 1024;
/**
 * The most source files a snapshot reads before it refuses the scope. 400 refused veritra (October 25, 2026; 427
 * source files, about 100,000 lines once generated files are left out), a project a subscription audits in a day. At
 * about 250 lines a file, 1,000 files is about 250,000 lines, some 170M tokens at the 600 to 700 a line the real runs
 * measured: a guard against a home folder or a large monorepo, not a budget, which the run's token limit is.
 */
export const SNAPSHOT_FILE_LIMIT = 1_000;
const TEST_METADATA = new Set(["package.json", "pnpm-workspace.yaml", "pyproject.toml", "pytest.ini", "tox.ini", "setup.cfg", "Cargo.toml", "go.mod", "Makefile", "build.gradle", "pom.xml"]);
const runGit = promisify(execFile);
export interface RepositoryGit { run(root: string, args: readonly string[]): Promise<string> }
/**
 * The audited repository is untrusted, and its own Git configuration can name programs Git runs while reading it
 * (`core.fsmonitor`, a filter's driver, an external diff), so reads switch those off (arbitra's audit of itself,
 * October 19, 2026). `--no-ext-diff` and `--no-textconv` are options of diff and show, added where those run.
 */
const SAFE_GIT_READ = ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "diff.external="] as const;
export const defaultGit: RepositoryGit = { async run(root, args) {
  const [command, ...rest] = args;
  const safeArgs = command === "diff" ? ["diff", "--no-ext-diff", "--no-textconv", ...rest] : command === "show" ? ["show", "--no-textconv", ...rest] : args;
  return (await runGit("git", [...SAFE_GIT_READ, "-C", root, ...safeArgs], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true })).stdout;
} };

/**
 * A read-only snapshot of the repository's source files.
 *
 * Audit and Feature modes are read-only (spec §2.1), so this only ever reads. Line start
 * offsets are carried because finding validation checks every cited line against them.
 */
export async function snapshotRepository(root: string, maximumFiles = SNAPSHOT_FILE_LIMIT, options: { readonly scope?: RunScope; readonly git?: RepositoryGit; readonly includeTestMetadata?: boolean; readonly additionalPaths?: readonly string[] } = {}): Promise<RepositorySnapshot> {
  if (!Number.isSafeInteger(maximumFiles) || maximumFiles < 1) throw new RangeError("INVALID_MAXIMUM_FILES");
  const guard = await RepositoryPathGuard.create(root);
  const scope = options.scope ?? { kind: "repository" };
  const additional = new Set((options.additionalPaths ?? []).map((path) => relative(guard.root, guard.resolve(path)).split(sep).join("/")));
  const exclusions = (scope.exclude ?? []).map((path) => relative(guard.root, guard.resolve(path)).split(sep).join("/").replace(/\/$/u, ""));
  // An exclusion covering the whole repository would leave nothing to audit; reject it rather than guess.
  if (exclusions.some((prefix) => prefix === "")) throw new Error("SCOPE_EXCLUSION_COVERS_REPOSITORY");
  const excluded = (path: string): boolean => exclusions.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  const eligible = (path: string): boolean => !excluded(path) && (SCANNED_EXTENSIONS.has(path.slice(path.lastIndexOf(".")).toLowerCase()) || options.includeTestMetadata === true && (TEST_METADATA.has(path.split("/").at(-1) ?? "") || additional.has(path)));
  if (scope.kind === "diff") return snapshotDiff(guard, scope, maximumFiles, options.git ?? defaultGit, eligible);
  const paths = await sourcePaths(root, guard, scope, maximumFiles + 1, options.git ?? defaultGit, eligible, excluded);
  if (paths.length > maximumFiles) throw new Error(`REPOSITORY_FILE_LIMIT_EXCEEDED:${maximumFiles}`);
  if (scope.kind === "module" && paths.length === 0) throw new Error("MODULE_SCOPE_EMPTY");
  const files = await Promise.all(paths.sort().map(async (path): Promise<SourceFile> => sourceFile(path, await guard.readFile(path))));
  return Object.freeze({ root, files: Object.freeze(files) });
}

/**
 * How many source files each folder at the top of a whole-repository or folders scope holds, counted without reading
 * them and without the scope's leave-outs: what New run shows when the scope is more than a run reads, so folders can
 * be left out until it fits. Counting stops at `maximumFiles`, and `complete` says whether it did; a diff scope is not
 * counted (null).
 */
export async function sourceFolderCounts(root: string, scope: RunScope, maximumFiles = 50_000, git: RepositoryGit = defaultGit): Promise<{ readonly folders: readonly { readonly path: string; readonly files: number }[]; readonly complete: boolean } | null> {
  if (scope.kind === "diff") return null;
  const guard = await RepositoryPathGuard.create(root);
  const paths = await sourcePaths(root, guard, scope, maximumFiles + 1, git, (path) => SCANNED_EXTENSIONS.has(path.slice(path.lastIndexOf(".")).toLowerCase()), () => false);
  const counts = new Map<string, number>();
  for (const path of paths.slice(0, maximumFiles)) { const folder = path.includes("/") ? path.slice(0, path.indexOf("/")) : ""; counts.set(folder, (counts.get(folder) ?? 0) + 1); }
  return Object.freeze({ folders: Object.freeze([...counts].map(([path, files]) => Object.freeze({ path, files })).sort((a, b) => b.files - a.files || a.path.localeCompare(b.path))), complete: paths.length <= maximumFiles });
}

/** The source files a whole-repository or folders scope reads, by path, up to `limit` of them. */
async function sourcePaths(root: string, guard: RepositoryPathGuard, scope: RunScope, limit: number, git: RepositoryGit, eligible: (path: string) => boolean, excluded: (path: string) => boolean): Promise<string[]> {
  const modules = scope.kind === "module" ? scope.modules : undefined;
  if (scope.kind === "module" && (modules === undefined || modules.length === 0)) throw new Error("MODULE_SCOPE_REQUIRED");
  const modulePaths = modules?.map((path) => relative(guard.root, guard.resolve(path)).split(sep).join("/").replace(/\/$/u, ""));
  const included = (path: string): boolean => modulePaths === undefined || modulePaths.some((prefix) => prefix === "" || path === prefix || path.startsWith(`${prefix}/`));
  // In a Git work tree, files Git ignores are left out: they are generated (test reports, coverage, builds), and one
  // oversized report refused a whole project (beachflag's playwright-report/index.html, October 20, 2026).
  const listed = await gitListedFiles(guard.root, git);
  const listedDirectories = listed === null ? null : new Set([...listed].flatMap((path) => path.split("/").slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join("/"))));
  // A directory that cannot hold a file of the snapshot is not entered: an excluded, unselected or ignored tree costs
  // no traversal, and cannot fail the snapshot when it is unreadable (arbitra's audit of itself, October 19, 2026).
  const entered = (path: string): boolean => !excluded(path) && (listedDirectories === null || listedDirectories.has(path)) && (included(path) || modulePaths?.some((prefix) => prefix.startsWith(`${path}/`)) === true);
  const paths: string[] = [];
  await walk(root, root, paths, limit, guard, (path) => (listed === null || listed.has(path)) && included(path) && eligible(path), entered);
  return paths;
}

/** The files Git tracks or would track (untracked but not ignored), relative to `root`; null outside a work tree or without Git. */
async function gitListedFiles(root: string, git: RepositoryGit): Promise<ReadonlySet<string> | null> {
  try { return new Set((await git.run(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).split("\0").filter((path) => path !== "")); }
  catch { return null; }
}

async function walk(root: string, directory: string, into: string[], limit: number, guard: RepositoryPathGuard, included: (path: string) => boolean, entered: (path: string) => boolean): Promise<void> {
  if (into.length >= limit) return;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (into.length >= limit) return;
    const full = join(directory, entry.name);
    const path = relative(root, full).split(sep).join("/");
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      if (SKIPPED_DIRECTORIES.has(entry.name) || !entered(path)) continue;
      await walk(root, full, into, limit, guard, included, entered);
      continue;
    }
    // Dirent types are checked before extension and stat so file symlinks are never
    // followed into content outside the audited repository.
    if (!entry.isFile()) continue;
    if (!included(path)) continue;
    const info = await guard.stat(path);
    if (info.size > MAXIMUM_FILE_BYTES) throw new Error(`REPOSITORY_FILE_TOO_LARGE:${path}`);
    into.push(path);
  }
}

function sourceFile(path: string, text: string): SourceFile {
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > MAXIMUM_FILE_BYTES) throw new Error(`REPOSITORY_FILE_TOO_LARGE:${path}`);
  // A private key is masked line by line here, in the whole file, because later redaction sees one line or range at
  // a time and finds a key only with its BEGIN and END markers together (arbitra's audit of itself, October 19).
  return Object.freeze({ path, byteLength, ...splitSourceText(maskPrivateKeyBlocks(text)) });
}

/**
 * A file's text as lines. A line ends at "\n". In a file whose every line ends in "\r\n" (Windows line endings, which
 * Git for Windows checks files out with by default) the "\r" is not part of the line, though its byte still counts
 * toward the next line's start, and `lineEnding` keeps the file's exact text for Testing's hashes and writes. Observed
 * live (October 19, 2026): with it kept, no quotation of a CRLF file could be grounded in whole lines, and every
 * Feature and Testing run on such a checkout failed. A file with mixed endings keeps each "\r" as before.
 */
export function splitSourceText(text: string): Pick<SourceFile, "lines" | "lineStartBytes" | "lineEnding"> {
  const raw = text.split("\n");
  const crlf = raw.length > 1 && raw.slice(0, -1).every((line) => line.endsWith("\r"));
  const lines = crlf ? raw.map((line, index) => index < raw.length - 1 ? line.slice(0, -1) : line) : raw;
  const lineStartBytes: number[] = [];
  let offset = 0;
  for (const line of raw) { lineStartBytes.push(offset); offset += Buffer.byteLength(line, "utf8") + 1; }
  return { lines: Object.freeze(lines), lineStartBytes: Object.freeze(lineStartBytes), ...(crlf ? { lineEnding: "\r\n" as const } : {}) };
}

async function snapshotDiff(guard: RepositoryPathGuard, scope: RunScope, maximumFiles: number, git: RepositoryGit, eligible: (path: string) => boolean): Promise<RepositorySnapshot> {
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
  // Paths are relative to the audited directory, which can be one package of a larger work tree: `--relative` keeps
  // the diff to it and prints its paths from it, as `ls-files` does, and "./" reads a revision's path from it too.
  const names = await git.run(guard.root, ["diff", "--name-only", "--relative", "--diff-filter=ACMR", "-z", ...target, "--"]);
  // The working tree's changes include files never added, which `git diff` does not list; ignored ones stay out.
  const untracked = mode === "working_tree" ? await git.run(guard.root, ["ls-files", "--others", "--exclude-standard", "-z"]) : "";
  const paths = [...new Set(`${names}\0${untracked}`.split("\0").filter((path) => path !== "" && eligible(path)))].sort();
  if (paths.length > maximumFiles) throw new Error(`REPOSITORY_FILE_LIMIT_EXCEEDED:${maximumFiles}`);
  const files = await Promise.all(paths.map(async (path) => {
    guard.resolve(path);
    const text = revision === null ? await guard.readFile(path) : await git.run(guard.root, ["show", `${revision}:./${path}`]);
    return sourceFile(path, text);
  }));
  return Object.freeze({ root: guard.root, files: Object.freeze(files) });
}

function validateRevision(value: string): void {
  if (value.trim() === "" || value.startsWith("-") || /[\s\0:]/u.test(value)) throw new Error("INVALID_DIFF_REVISION");
}
