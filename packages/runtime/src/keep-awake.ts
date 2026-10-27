import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { Readable, Writable } from "node:stream";

/** Whether this computer is kept from sleeping, in words for "This computer" and the run report. */
export interface KeepAwakeStatus {
  /** `held`: a run is live and the computer is kept awake; `ready`: no run is live; `unavailable`: this computer has no
   * tool for it; `failed`: the tool could not start, or stopped while a run was live. */
  readonly state: "held" | "ready" | "unavailable" | "failed";
  readonly tool: string | null;
  readonly detail: string;
}

/** Keeps the computer awake while anything holds it. Counted: the first hold takes it, the last release lets it sleep. */
export interface KeepAwake {
  /** Never throws; the returned release is idempotent. */
  hold(): () => void;
  status(): KeepAwakeStatus;
}

/** What the holder needs of the process it runs in; tests give a fake, so no real holder starts. */
export interface KeepAwakeHost {
  readonly platform: NodeJS.Platform;
  readonly pid: number;
  readonly spawn: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  /** The executable's path when it is on PATH (or where the system keeps it), else null. */
  readonly find: (command: string) => string | null;
  readonly onExit: (listener: () => void) => void;
}

/** The process that holds the computer awake for as long as it lives, on this platform, or why there is none. */
export type KeepAwakeCommand = { readonly command: string; readonly args: readonly string[]; readonly tool: string; readonly stdin: boolean } | { readonly unavailable: string };

const STDERR_KEPT = 2_000;
/** ES_CONTINUOUS | ES_SYSTEM_REQUIRED: the system stays out of sleep while the calling thread lives; the display may still turn off. */
const ES_CONTINUOUS_SYSTEM_REQUIRED = 0x8000_0001;

/**
 * - darwin: `caffeinate -i -w <pid>` holds an idle-sleep assertion until arbitra exits. It does not stop the sleep of
 *   a closed lid; a suspend is then handled as an interruption (suspend.ts).
 * - linux: `systemd-inhibit --what=idle:sleep --mode=block` around a shell that waits for its stdin to close, which it
 *   does when arbitra releases it or exits; only where systemd-inhibit exists.
 * - win32: a hidden PowerShell whose thread holds `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` while it
 *   waits for arbitra's process. Tried on Windows 11 (October 27, 2026): it holds within half a second, opens no window,
 *   and ends when killed. The state belongs to the thread, so it ends with the process.
 */
export function keepAwakeCommand(platform: NodeJS.Platform, pid: number, find: (command: string) => string | null): KeepAwakeCommand {
  if (platform === "darwin") {
    const caffeinate = find("caffeinate");
    return caffeinate === null ? { unavailable: "caffeinate was not found, so arbitra cannot keep this Mac from sleeping during a run" }
      : { command: caffeinate, args: ["-i", "-w", String(pid)], tool: "caffeinate -i", stdin: false };
  }
  if (platform === "linux") {
    const inhibit = find("systemd-inhibit");
    return inhibit === null ? { unavailable: "systemd-inhibit was not found, so arbitra cannot keep this computer from sleeping during a run" }
      : { command: inhibit, args: ["--what=idle:sleep", "--who=arbitra", "--why=an arbitra run is live", "--mode=block", "sh", "-c", "read -r _ || true"], tool: "systemd-inhibit", stdin: true };
  }
  if (platform === "win32") {
    const script = ["$ErrorActionPreference = 'Stop'",
      "Add-Type -Namespace Arbitra -Name Power -MemberDefinition '[System.Runtime.InteropServices.DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint flags);'",
      `if ([Arbitra.Power]::SetThreadExecutionState([uint32]${ES_CONTINUOUS_SYSTEM_REQUIRED}) -eq 0) { exit 3 }`,
      `Wait-Process -Id ${pid}`].join("\n");
    return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], tool: "SetThreadExecutionState", stdin: false };
  }
  return { unavailable: `arbitra cannot keep a ${platform} computer from sleeping during a run` };
}

/** The real holder: one child process while any run holds it, never a failed run when it cannot start. */
export class ProcessKeepAwake implements KeepAwake {
  readonly #host: KeepAwakeHost;
  readonly #command: KeepAwakeCommand;
  #count = 0;
  #child: ChildProcess | null = null;
  #failure: string | null = null;

  constructor(host: KeepAwakeHost = systemHost()) {
    this.#host = host;
    this.#command = keepAwakeCommand(host.platform, host.pid, host.find);
    host.onExit(() => this.#stop());
  }

  hold(): () => void {
    this.#count += 1;
    if (this.#count === 1) this.#start();
    let released = false;
    return () => {
      if (released) return;
      released = true; this.#count -= 1;
      if (this.#count === 0) this.#stop();
    };
  }

  status(): KeepAwakeStatus {
    const command = this.#command;
    if ("unavailable" in command) return { state: "unavailable", tool: null, detail: `${command.unavailable}; keep it awake yourself while a run works` };
    if (this.#failure !== null) return { state: "failed", tool: command.tool, detail: `could not keep this computer awake: ${this.#failure}` };
    const lid = this.#host.platform === "darwin" ? "; a Mac still sleeps when its lid is closed" : "";
    return this.#child !== null && this.#count > 0
      ? { state: "held", tool: command.tool, detail: `kept awake while a run works (${command.tool})${lid}` }
      : { state: "ready", tool: command.tool, detail: `kept awake while a run works (${command.tool})${lid}` };
  }

  #start(): void {
    const command = this.#command;
    if ("unavailable" in command) return;
    let child: ChildProcess;
    try {
      child = this.#host.spawn(command.command, command.args, { stdio: [command.stdin ? "pipe" : "ignore", "ignore", "pipe"], windowsHide: true, detached: false });
    } catch (error) { this.#failure = `${command.tool} could not be started (${error instanceof Error ? error.message : String(error)})`; return; }
    this.#child = child; this.#failure = null;
    let stderr = "";
    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on("data", (chunk: string | Buffer) => { stderr = (stderr + String(chunk)).slice(-STDERR_KEPT); });
    child.on("error", (error) => { if (this.#child === child) { this.#child = null; this.#failure = `${command.tool} could not be started (${error.message})`; } });
    child.on("exit", (code, signal) => {
      if (this.#child !== child) return;
      this.#child = null;
      // Stopped while a run still holds it: the run goes on, and "This computer" says the computer may sleep.
      if (this.#count > 0) this.#failure = `${command.tool} stopped (${code === null ? `signal ${signal ?? "unknown"}` : `status ${code}`})${stderr.trim() === "" ? "" : `: ${stderr.trim().replace(/\s+/gu, " ").slice(0, 300)}`}`;
    });
    // The holder never keeps arbitra running; arbitra's exit ends it (caffeinate -w, Wait-Process, a closed stdin).
    child.unref();
    for (const pipe of [child.stdin, child.stderr] as (Writable | Readable | null)[]) (pipe as { unref?: () => void } | null)?.unref?.();
  }

  #stop(): void {
    const child = this.#child;
    this.#child = null;
    if (child === null) return;
    try { child.stdin?.end(); } catch { /* already closed */ }
    try { child.kill(); } catch { /* already gone */ }
  }
}

function systemHost(): KeepAwakeHost {
  return {
    platform: process.platform, pid: process.pid,
    spawn: (command, args, options) => spawn(command, [...args], options),
    find: (command) => onPath(command, process.env["PATH"] ?? "", process.platform),
    onExit: (listener) => { process.once("exit", listener); },
  };
}

/** Where `command` is on PATH, or in the system's own directories, or null. */
export function onPath(command: string, path: string, platform: NodeJS.Platform): string | null {
  if (platform === "win32") return command;
  for (const directory of [...path.split(delimiter).filter((entry) => entry !== ""), "/usr/bin", "/bin", "/usr/sbin"]) {
    const candidate = join(directory, command);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* not here */ }
  }
  return null;
}
