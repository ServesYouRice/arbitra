import { constants } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, win32 } from "node:path";
import type { CliTransportSupport } from "./support.js";

/** Reads one host environment variable by name. Values are never logged or persisted. */
export type HostLookup = (name: string) => string | undefined;

/**
 * How a CLI is started. On Windows an npm `.cmd` shim is resolved to the Node script it
 * wraps and run with Node directly, so no command shell ever parses prompt-bearing arguments.
 */
export interface CliExecutable {
  readonly command: string;
  readonly prefixArguments: readonly string[];
  readonly path: string;
  readonly source: "override" | "path" | "well_known";
}
export type CliExecutableResolution =
  | { readonly found: true; readonly executable: CliExecutable }
  | { readonly found: false; readonly reason: "override_invalid" | "not_found"; readonly detail: string };

export interface DiscoveryHost {
  readonly platform: NodeJS.Platform;
  readonly lookup: HostLookup;
  /** The Node runtime used to run a Windows npm shim's script. */
  readonly nodeExecutable: string;
}

export async function resolveCliExecutable(support: CliTransportSupport, host: DiscoveryHost): Promise<CliExecutableResolution> {
  const override = host.lookup(support.executableEnvVar);
  if (override !== undefined && override !== "") {
    if (!absolute(override, host.platform) || !await executable(override, host.platform)) {
      return { found: false, reason: "override_invalid", detail: `${support.executableEnvVar} must be the absolute path of an existing executable file` };
    }
    return found(override, "override", host);
  }
  const names = host.platform === "win32" ? [".exe", ".cmd", ".bat", ""].map((extension) => `${support.command}${extension}`) : [support.command];
  for (const directory of (host.lookup(host.platform === "win32" ? "Path" : "PATH") ?? host.lookup("PATH") ?? "").split(host.platform === "win32" ? ";" : delimiter)) {
    if (directory === "" || !absolute(directory, host.platform)) continue;
    for (const name of names) {
      const candidate = join(directory, name);
      if (await executable(candidate, host.platform)) return found(candidate, "path", host);
    }
  }
  for (const candidate of await wellKnownLocations(support, host)) {
    if (await executable(candidate, host.platform)) return found(candidate, "well_known", host);
  }
  return { found: false, reason: "not_found", detail: `${support.command} was not found through ${support.executableEnvVar}, PATH or the documented install locations` };
}

async function found(path: string, source: CliExecutable["source"], host: DiscoveryHost): Promise<CliExecutableResolution> {
  if (host.platform === "win32" && /\.(?:cmd|bat)$/iu.test(path)) {
    const script = await npmShimScript(path);
    if (script === null) return { found: false, reason: "not_found", detail: `${path} is a command shim whose Node entry point could not be identified; set the executable override to the CLI's .exe or script` };
    return { found: true, executable: Object.freeze({ command: host.nodeExecutable, prefixArguments: Object.freeze([script]), path, source }) };
  }
  return { found: true, executable: Object.freeze({ command: path, prefixArguments: Object.freeze([]), path, source }) };
}

/** npm's generated shims invoke `"%dp0%\node_modules\<package>\<script>.js"`. */
async function npmShimScript(path: string): Promise<string | null> {
  const content = await readFile(path, "utf8").catch(() => "");
  const relative = /"%(?:~)?dp0%\\([^"%]+\.(?:c|m)?js)"/iu.exec(content)?.[1];
  if (relative === undefined) return null;
  const script = join(dirname(path), ...relative.split(/[\\/]/u));
  return await stat(script).then((value) => value.isFile(), () => false) ? script : null;
}

/**
 * Documented install locations, relative to the user's home or the platform's standard
 * application folders. Extension-bundled Claude Code binaries pick the newest version.
 */
async function wellKnownLocations(support: CliTransportSupport, host: DiscoveryHost): Promise<readonly string[]> {
  const home = host.platform === "win32" ? host.lookup("USERPROFILE") ?? host.lookup("HOME") : host.lookup("HOME");
  const exe = host.platform === "win32" ? ".exe" : "";
  const npmBins = [
    ...(host.platform === "win32" ? [host.lookup("APPDATA") === undefined ? null : join(host.lookup("APPDATA") ?? "", "npm")] : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]),
    home === undefined ? null : join(home, ".npm-global", "bin"), home === undefined ? null : join(home, ".local", "bin"),
    host.lookup("npm_config_prefix") === undefined ? null : host.platform === "win32" ? host.lookup("npm_config_prefix") ?? null : join(host.lookup("npm_config_prefix") ?? "", "bin"),
  ].filter((value): value is string => value !== null);
  const commandIn = (directories: readonly string[]) => directories.flatMap((directory) => host.platform === "win32" ? [join(directory, `${support.command}.exe`), join(directory, `${support.command}.cmd`)] : [join(directory, support.command)]);
  switch (support.vendor) {
    case "claude-code": {
      const extensionRoots = home === undefined ? [] : [".vscode", ".vscode-insiders", ".cursor", ".windsurf", ".vscode-oss"].map((editor) => join(home, editor, "extensions"));
      const bundled = (await Promise.all(extensionRoots.map((root) => newestExtensionBinary(root, "anthropic.claude-code-", join("resources", "native-binary", `claude${exe}`))))).flat();
      return [...(home === undefined ? [] : [join(home, ".claude", "local", `claude${exe}`), join(home, ".local", "bin", `claude${exe}`)]), ...commandIn(npmBins), ...bundled];
    }
    case "codex": {
      const app = host.platform === "darwin" ? ["/Applications/ChatGPT.app/Contents/Resources/codex", ...(home === undefined ? [] : [join(home, "Applications", "ChatGPT.app", "Contents", "Resources", "codex")])] : [];
      return [...commandIn(npmBins), ...app];
    }
    case "gemini": return commandIn(npmBins);
    case "antigravity": {
      const links = host.platform === "win32" && host.lookup("LOCALAPPDATA") !== undefined ? [join(host.lookup("LOCALAPPDATA") ?? "", "Microsoft", "WinGet", "Links", "agy.exe")] : [];
      return [...(home === undefined ? [] : [join(home, ".local", "bin", `agy${exe}`)]), ...links];
    }
  }
}

async function newestExtensionBinary(root: string, prefix: string, relative: string): Promise<readonly string[]> {
  const entries = await readdir(root).catch(() => [] as string[]);
  return entries.filter((name) => name.startsWith(prefix))
    .map((name) => ({ name, version: /^(\d+)\.(\d+)\.(\d+)/u.exec(name.slice(prefix.length))?.slice(1).map(Number) ?? [0, 0, 0] }))
    .sort((a, b) => [0, 1, 2].map((index) => (b.version[index] ?? 0) - (a.version[index] ?? 0)).find((difference) => difference !== 0) ?? b.name.localeCompare(a.name))
    .map(({ name }) => join(root, name, relative));
}

function absolute(path: string, platform: NodeJS.Platform): boolean { return platform === "win32" ? win32.isAbsolute(path) : isAbsolute(path); }

async function executable(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    if (platform !== "win32") await access(path, constants.X_OK);
    return true;
  } catch { return false; }
}

/** PATH for the child: the CLI's own directory (and its resolved target's) plus Node's, then the system directories. */
export function childPath(executable: CliExecutable, resolvedTarget: string | null, platform: NodeJS.Platform, nodeExecutable: string, lookup: HostLookup): string {
  const system = platform === "win32" ? [join(lookup("SystemRoot") ?? "C:\\Windows", "System32"), lookup("SystemRoot") ?? "C:\\Windows"] : ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const directories = [dirname(executable.path), ...(resolvedTarget === null ? [] : [dirname(resolvedTarget)]), dirname(nodeExecutable), ...system];
  return [...new Set(directories)].join(platform === "win32" ? ";" : ":");
}
