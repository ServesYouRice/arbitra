import { posix } from "node:path";
import { RepositoryPathGuard } from "@arbitra/security/path-guard";
import type { RepositorySnapshot } from "./repository.js";

/** What a command checks. */
export type ProjectCommandPurpose = "test" | "typecheck" | "lint" | "check" | "build";

/**
 * A command the project declares for checking a change, with the manifest it came from. It is evidence of what the
 * project runs, not permission to run it: a plan names it, and the agent carrying the plan out runs it.
 */
export interface ProjectCommand {
  readonly purpose: ProjectCommandPurpose;
  readonly command: string;
  /** Where to run it, relative to the repository root ("" for the root). */
  readonly directory: string;
  readonly sourcePath: string;
  readonly source: string;
}

export const PROJECT_COMMANDS_KIND = "repository-commands";
/** Enough for a workspace of a few dozen packages; a plan needs the root's commands and those of the packages it edits. */
const MAXIMUM_COMMANDS = 40;
const PURPOSES: readonly ProjectCommandPurpose[] = ["test", "typecheck", "lint", "check", "build"];
const SCRIPT_PURPOSES: readonly (readonly [RegExp, ProjectCommandPurpose])[] = [
  [/^test(?::[A-Za-z0-9_.-]+)*$/u, "test"],
  [/^(?:typecheck|type-check|check-types|types|tsc)$/u, "typecheck"],
  [/^lint(?::[A-Za-z0-9_.-]+)*$/u, "lint"],
  [/^check$/u, "check"],
  [/^build$/u, "build"],
];
const MAKE_TARGETS: Readonly<Record<string, ProjectCommandPurpose>> = { test: "test", check: "check", lint: "lint", typecheck: "typecheck", build: "build" };

/** The package manager a manifest's `packageManager` field names, when it is pnpm or yarn. */
export function declaredPackageManager(manifest: { readonly packageManager?: unknown } | undefined): "pnpm" | "yarn" | undefined {
  const declared = typeof manifest?.packageManager === "string" ? /^(pnpm|yarn)@/u.exec(manifest.packageManager)?.[1] : undefined;
  return declared === "pnpm" || declared === "yarn" ? declared : undefined;
}

/**
 * The package manager a workspace runs its scripts with: the root manifest's `packageManager` field, else the
 * lockfile at the root, else npm. A workspace package that names none uses this one.
 */
export function packageManagerFor(rootManifest: { readonly packageManager?: unknown } | undefined, rootHas: (name: string) => boolean): "pnpm" | "yarn" | "npm" {
  return declaredPackageManager(rootManifest) ?? (rootHas("pnpm-lock.yaml") || rootHas("pnpm-workspace.yaml") ? "pnpm" : rootHas("yarn.lock") ? "yarn" : "npm");
}

/** `<manager> run <script>`, for a package below the root with the manager's own directory flag. */
export function packageScriptCommand(manager: "pnpm" | "yarn" | "npm", directory: string, script: string): string {
  const prefix = directory === "" ? "" : ` ${manager === "pnpm" ? "--dir" : manager === "yarn" ? "--cwd" : "--prefix"} ${directory}`;
  return `${manager}${prefix} run ${script}`;
}

/**
 * Reads the manifests at the repository root and in every directory holding a snapshot file, and lists the test,
 * typecheck, lint, check and build commands they declare: package scripts, Makefile targets, and the standard
 * commands of a Cargo, Go or pytest project. A manifest that does not parse offers no commands. Plans guessed these
 * before (six runs: no plan stage read a manifest, and a pnpm workspace was told to run `npm test`).
 */
export async function projectCommands(snapshot: RepositorySnapshot): Promise<readonly ProjectCommand[]> {
  const guard = await RepositoryPathGuard.create(snapshot.root);
  const read = async (path: string): Promise<string | undefined> => {
    try { return await guard.readFile(path); } catch { return undefined; }
  };
  const directories = new Set<string>([""]);
  for (const { path } of snapshot.files) for (let directory = posix.dirname(path); directory !== "." && directory !== ""; directory = posix.dirname(directory)) directories.add(directory);
  const at = (directory: string, name: string) => directory === "" ? name : `${directory}/${name}`;
  const rootManifest = parseObject(await read("package.json"));
  const rootFiles = new Set<string>();
  for (const name of ["pnpm-lock.yaml", "pnpm-workspace.yaml", "yarn.lock"]) if (await read(name) !== undefined) rootFiles.add(name);
  const manager = packageManagerFor(rootManifest, (name) => rootFiles.has(name));
  const commands: ProjectCommand[] = [];
  for (const directory of [...directories].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))) {
    // Unusual directory names would need shell quoting a plan should not have to get right.
    if (directory !== "" && !/^[A-Za-z0-9_./-]+$/u.test(directory)) continue;
    const packagePath = at(directory, "package.json");
    const manifest = directory === "" ? rootManifest : parseObject(await read(packagePath));
    const scripts = manifest?.["scripts"];
    if (typeof scripts === "object" && scripts !== null && !Array.isArray(scripts)) {
      for (const [script, source] of Object.entries(scripts)) {
        const purpose = SCRIPT_PURPOSES.find(([pattern]) => pattern.test(script))?.[1];
        if (purpose === undefined || typeof source !== "string" || source.trim() === "") continue;
        commands.push({ purpose, command: packageScriptCommand(declaredPackageManager(manifest) ?? manager, directory, script), directory: "", sourcePath: packagePath, source });
      }
    }
    const makefile = await read(at(directory, "Makefile"));
    if (makefile !== undefined) {
      for (const [, target] of makefile.matchAll(/^([A-Za-z][\w-]*)\s*:(?!=)/gmu)) {
        const purpose = target === undefined ? undefined : MAKE_TARGETS[target];
        if (purpose !== undefined) commands.push({ purpose, command: directory === "" ? `make ${target}` : `make -C ${directory} ${target}`, directory: "", sourcePath: at(directory, "Makefile"), source: `${target}:` });
      }
    }
    if (await read(at(directory, "Cargo.toml")) !== undefined) {
      const manifestFlag = directory === "" ? "" : ` --manifest-path ${at(directory, "Cargo.toml")}`;
      for (const [purpose, command] of [["test", "cargo test"], ["lint", "cargo clippy"], ["build", "cargo build"]] as const) {
        commands.push({ purpose, command: `${command}${manifestFlag}`, directory: "", sourcePath: at(directory, "Cargo.toml"), source: "Cargo.toml" });
      }
    }
    if (await read(at(directory, "go.mod")) !== undefined) {
      for (const [purpose, command] of [["test", "go test ./..."], ["lint", "go vet ./..."], ["build", "go build ./..."]] as const) {
        commands.push({ purpose, command, directory, sourcePath: at(directory, "go.mod"), source: "go.mod" });
      }
    }
    const pyproject = await read(at(directory, "pyproject.toml"));
    const pytestConfigured = pyproject?.includes("[tool.pytest") === true || await read(at(directory, "pytest.ini")) !== undefined;
    if (pytestConfigured) commands.push({ purpose: "test", command: "python -m pytest", directory, sourcePath: pyproject?.includes("[tool.pytest") === true ? at(directory, "pyproject.toml") : at(directory, "pytest.ini"), source: "pytest configuration" });
    if (pyproject?.includes("[tool.ruff") === true) commands.push({ purpose: "lint", command: "ruff check .", directory, sourcePath: at(directory, "pyproject.toml"), source: "[tool.ruff]" });
    if (pyproject?.includes("[tool.mypy") === true) commands.push({ purpose: "typecheck", command: "mypy .", directory, sourcePath: at(directory, "pyproject.toml"), source: "[tool.mypy]" });
  }
  const unique = [...new Map(commands.map((command) => [`${command.directory}\0${command.command}`, command])).values()];
  // The root's commands first, then each package's together.
  const order = (a: ProjectCommand, b: ProjectCommand) => depth(a.sourcePath) - depth(b.sourcePath) || posix.dirname(a.sourcePath).localeCompare(posix.dirname(b.sourcePath)) || PURPOSES.indexOf(a.purpose) - PURPOSES.indexOf(b.purpose);
  return Object.freeze(unique.sort(order).slice(0, MAXIMUM_COMMANDS).map((command) => Object.freeze(command)));
}

/** How a plan stage reads the commands: what they are for, then the list. */
export function plannerCommandContext(commands: readonly ProjectCommand[]): { readonly use: string; readonly commands: readonly { readonly purpose: ProjectCommandPurpose; readonly command: string; readonly directory?: string; readonly from: string }[] } | undefined {
  if (commands.length === 0) return undefined;
  return {
    use: "The project's own commands, read from its manifests. Base each task's verification.commands on these (narrowed to the test that proves the task where the runner allows it) rather than guessing; run each from the repository root, or from directory when one is given.",
    commands: commands.map(({ purpose, command, directory, sourcePath }) => ({ purpose, command, ...(directory === "" ? {} : { directory }), from: sourcePath })),
  };
}

function parseObject(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text.replace(/^\u{FEFF}/u, ""));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function depth(path: string): number { return path === "" ? 0 : path.split("/").length; }
