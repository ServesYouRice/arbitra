import { execFile, spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import type { Socket } from "node:net";

/**
 * Bounded native-process execution with process-tree termination. Every exit path (normal, timeout, cancellation,
 * protocol violation) ends the native process's tree: on POSIX the process group it leads, and on every platform each
 * descendant found in the process table, so tool subprocesses the harness started do not outlive it. The host shell is
 * never used.
 */
export interface NativeProcessRequest {
  readonly executable: string; readonly arguments: readonly string[];
  readonly cwd: string; readonly environment: Readonly<Record<string, string>>;
  readonly stdin: string;
  readonly timeoutMs: number;
  /** Total stdout bytes; exceeding it stops the process. */
  readonly maximumOutputBytes: number;
  readonly signal: AbortSignal;
  /** Called synchronously for every complete stdout line. Throwing stops the process as a violation. */
  readonly onLine?: (line: string) => void;
  /** Called with every stderr chunk as it arrives, past the head `stderr` keeps: a failed call's trace keeps how stderr ended. */
  readonly onStderr?: (chunk: string) => void;
  readonly onSpawn?: (pid: number) => void;
}
export type NativeProcessStop = "timeout" | "cancelled" | "output_limit" | "spawn_error" | "violation";
export interface NativeProcessResult {
  readonly pid: number | null;
  readonly exitCode: number | null; readonly exitSignal: string | null;
  readonly stopped: NativeProcessStop | null;
  /** The error thrown by `onLine`, when `stopped` is `violation`. */
  readonly violation: unknown;
  /** Complete stdout, only when no `onLine` consumer is given. */
  readonly stdout: string;
  readonly stderr: string;
  /**
   * No process of the native tree is known to be running: the process table could be read, every descendant found in
   * it is gone (and on POSIX the leader's process group), every kill succeeded or found its process already gone, and
   * nothing held the output pipes once those were ended. A descendant that holds no pipe is out of reach once every
   * parent between it and the leader has exited, unless it is still in the leader's process group or, on Linux, its
   * session.
   */
  readonly treeTerminated: boolean;
}
export interface NativeProcessPort { run(request: NativeProcessRequest): Promise<NativeProcessResult> }

const MAXIMUM_STDERR_BYTES = 64 * 1024;
/** How long the pipes may stay open after the leader exits before the descendants holding them are looked for. */
const EXIT_GRACE_MS = 2_000;
/** How long the pipes may then stay open, once the descendants found are ended, before a process out of reach is taken to hold them. */
const HELD_PIPE_MS = 1_000;

/** What is known of a native process's tree while it is ended. */
interface ProcessTree { readonly root: number; readonly startedAt: number; exitedAt: number | null; readonly ended: Set<number>; failed: boolean }

export function runNativeProcess(request: NativeProcessRequest): Promise<NativeProcessResult> {
  // setTimeout fires at once for a delay above 2^31-1 ms, so a longer timeout would stop every process immediately.
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 2_147_483_647 || !Number.isSafeInteger(request.maximumOutputBytes) || request.maximumOutputBytes < 1) throw new Error("INVALID_NATIVE_PROCESS_BOUND");
  if (request.signal.aborted) return Promise.resolve({ pid: null, exitCode: null, exitSignal: null, stopped: "cancelled", violation: null, stdout: "", stderr: "", treeTerminated: true });
  return new Promise((resolveResult) => {
    const posix = process.platform !== "win32";
    const startedAt = Date.now();
    // Some refusals throw at once rather than emit `error`: on Windows a `.cmd` or `.bat` without a shell is EINVAL
    // (Node's CVE-2024-27980 fix), observed live with npm's `claude.cmd` (October 25, 2026).
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(request.executable, [...request.arguments], { cwd: request.cwd, env: { ...request.environment }, shell: false, windowsHide: true, detached: posix, stdio: ["pipe", "pipe", "pipe"] }); }
    catch { resolveResult({ pid: null, exitCode: null, exitSignal: null, stopped: "spawn_error", violation: null, stdout: "", stderr: "", treeTerminated: true }); return; }
    const pid = child.pid ?? null;
    let stopped: NativeProcessStop | null = null; let violation: unknown = null;
    child.on("error", () => { if (stopped === null) stopped = "spawn_error"; });
    // Out of file descriptors (EMFILE, ENFILE), Node returns before it creates the pipes and only emits `error` on
    // the next tick, so there is nothing to read or wait for.
    if ((child.stdin as NodeJS.WritableStream | null) === null) {
      resolveResult({ pid, exitCode: null, exitSignal: null, stopped: "spawn_error", violation: null, stdout: "", stderr: "", treeTerminated: true });
      return;
    }
    let stdoutBytes = 0; let pending = Buffer.alloc(0); const collected: Buffer[] = [];
    let stderr = Buffer.alloc(0);
    const tree: ProcessTree | null = pid === null ? null : { root: pid, startedAt, exitedAt: null, ended: new Set(), failed: false };
    // One pass at a time, each against the process table as it is when the pass runs.
    let ending: Promise<void> = Promise.resolve();
    const end = () => {
      if (tree !== null) ending = ending.then(() => endTree(tree)).catch(() => { tree.failed = true; });
      return ending;
    };
    const terminate = () => { if (tree !== null) void end(); else child.kill("SIGKILL"); };
    const stop = (reason: NativeProcessStop) => { if (stopped === null) stopped = reason; terminate(); };
    if (pid !== null) try { request.onSpawn?.(pid); } catch (error) { violation = error; stop("violation"); }
    child.stdin.on("error", () => undefined);
    child.stdin.end(request.stdin);
    const deliver = (line: Buffer) => {
      if (stopped !== null || request.onLine === undefined) return;
      const text = line.toString("utf8").replace(/\r$/u, "");
      if (text.trim() === "") return;
      try { request.onLine(text); } catch (error) { violation = error; stop("violation"); }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (stopped !== null) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > request.maximumOutputBytes) { stop("output_limit"); return; }
      if (request.onLine === undefined) { collected.push(chunk); return; }
      pending = Buffer.concat([pending, chunk]);
      let index = pending.indexOf(10);
      while (index >= 0 && stopped === null) {
        deliver(pending.subarray(0, index)); pending = pending.subarray(index + 1); index = pending.indexOf(10);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAXIMUM_STDERR_BYTES) stderr = Buffer.concat([stderr, chunk.subarray(0, MAXIMUM_STDERR_BYTES - stderr.length)]);
      try { request.onStderr?.(chunk.toString("utf8")); } catch { /* a trace that fails to record never stops the call */ }
    });
    const cancelled = () => stop("cancelled");
    request.signal.addEventListener("abort", cancelled, { once: true });
    const timer = setTimeout(() => stop("timeout"), request.timeoutMs);
    // The leader exiting does not end its tree, and descendants holding stdout would keep the pipes open, so `close`
    // would not be reached: a call stayed open until its timeout (30 minutes for a CLI call), and on POSIX a descendant
    // in a session of its own kept it open past that. On POSIX the rest of the tree is ended at once. Windows has no
    // group, and taskkill /T needs a living root, so descendants still holding the pipes after a short grace are found
    // in the process table by their parent and ended. Pipes still open after that are held by a process out of reach:
    // they are closed from this side, and the tree is not reported terminated.
    let grace: NodeJS.Timeout | undefined; let held: NodeJS.Timeout | undefined;
    let closed = false; let heldOpen = false;
    child.on("exit", () => {
      if (tree === null) return;
      tree.exitedAt = Date.now();
      if (posix) void end();
      grace = setTimeout(() => {
        void end().then(() => {
          // The immediate runs after the I/O already received, such as the pipes closing as their holders died.
          if (!closed) held = setTimeout(() => setImmediate(() => { if (!closed) { heldOpen = true; child.stdout.destroy(); child.stderr.destroy(); } }), HELD_PIPE_MS);
        });
      }, EXIT_GRACE_MS);
    });
    child.on("close", (exitCode, exitSignal) => {
      closed = true;
      clearTimeout(timer); clearTimeout(grace); clearTimeout(held); request.signal.removeEventListener("abort", cancelled);
      if (pending.length > 0) { deliver(pending); pending = Buffer.alloc(0); }
      // A descendant that holds no pipe does not delay `close`, so the tree is looked for once more. `close` follows the
      // leader's exit.
      if (tree !== null) tree.exitedAt ??= Date.now();
      void end().then(async () => {
        const treeTerminated = tree === null || (!tree.failed && !heldOpen && await terminated(tree).catch(() => false));
        resolveResult({ pid, exitCode, exitSignal, stopped, violation, stdout: Buffer.concat(collected).toString("utf8"), stderr: stderr.toString("utf8"), treeTerminated });
      });
    });
    if (request.signal.aborted) cancelled();
  });
}

/**
 * Ends what can be found of the tree now. On POSIX it is frozen first, the group at once and each descendant as it is
 * found, so that none can start a process the next look would miss before it is killed.
 */
async function endTree(tree: ProcessTree): Promise<void> {
  if (process.platform === "win32") {
    if (tree.exitedAt === null) {
      // Bounded: this blocks the event loop, and a taskkill that hangs would otherwise stop every timer, cancellation and run in the process.
      const result = spawnSync("taskkill", ["/pid", String(tree.root), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 10_000 });
      // 128: a process it named was gone by then, the leader having exited since or a descendant while the tree was
      // walked (seen on Windows 11, October 2026). On any other failure the leader at least is ended.
      if (result.error !== undefined || (result.status !== 0 && result.status !== 128)) { tree.failed = true; signal(tree.root, "SIGKILL"); }
      return;
    }
    const descendants = await windowsDescendants(tree.root, tree.startedAt, tree.exitedAt);
    if (descendants === null) { tree.failed = true; return; }
    for (const descendant of descendants) { tree.ended.add(descendant); signal(descendant, "SIGKILL"); }
    return;
  }
  signal(-tree.root, "SIGSTOP");
  const found = new Set<number>();
  try {
    for (let look = 0; look < 4; look += 1) {
      const table = await posixProcesses();
      if (table === null) { tree.failed = true; break; }
      const fresh = posixDescendants(table, tree.root, tree.exitedAt === null).filter((descendant) => !found.has(descendant));
      if (fresh.length === 0) break;
      for (const descendant of fresh) { found.add(descendant); signal(descendant, "SIGSTOP"); }
    }
  } finally {
    signal(-tree.root, "SIGKILL");
    for (const descendant of found) { tree.ended.add(descendant); signal(descendant, "SIGKILL"); }
  }
}

interface PosixProcess { readonly pid: number; readonly ppid: number; readonly pgid: number; readonly session: number | null; readonly zombie: boolean }

/**
 * The process table, or null when it cannot be read. Linux's /proc also gives each process's session, and needs no
 * `ps`, which slim container images lack; elsewhere `ps` is read.
 */
function posixProcesses(): Promise<PosixProcess[] | null> {
  if (process.platform === "linux") {
    let names: string[];
    try { names = readdirSync("/proc"); } catch { return Promise.resolve(null); }
    return Promise.resolve(names.flatMap((name) => {
      if (!/^\d+$/u.test(name)) return [];
      let stat: string;
      try { stat = readFileSync(`/proc/${name}/stat`, "utf8"); } catch { return []; }
      // The fields after the command name, which is in parentheses and may itself hold spaces and parentheses.
      const [state, ppid, pgid, session] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return [{ pid: Number(name), ppid: Number(ppid), pgid: Number(pgid), session: Number(session), zombie: state === "Z" || state === "X" }];
    }));
  }
  return new Promise((done) => {
    execFile("ps", ["-A", "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "stat="], { encoding: "utf8", timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error !== null) { done(null); return; }
      done(stdout.split("\n").flatMap((line) => {
        const fields = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/u.exec(line);
        return fields === null ? [] : [{ pid: Number(fields[1]), ppid: Number(fields[2]), pgid: Number(fields[3]), session: null, zombie: fields[4]?.startsWith("Z") === true }];
      }));
    });
  });
}

/**
 * The living processes of `root`'s tree other than the leader: its process group and session, which outlive it and
 * whose ID is not reused while a member lives; its children while it runs (after it exits, its PID can name another
 * process); and every descendant of those through its parent, which reaches one in a group or session of its own.
 */
function posixDescendants(table: readonly PosixProcess[], root: number, rootRunning: boolean): number[] {
  const children = new Map<number, PosixProcess[]>();
  for (const entry of table) { const siblings = children.get(entry.ppid); if (siblings === undefined) children.set(entry.ppid, [entry]); else siblings.push(entry); }
  const queue = table.filter((entry) => entry.pgid === root || entry.session === root || (rootRunning && entry.ppid === root));
  const found: number[] = [];
  for (const seen = new Set<number>(); queue.length > 0;) {
    const next = queue.pop();
    if (next === undefined || seen.has(next.pid) || (next.pid === root && !rootRunning) || next.pid === process.pid) continue;
    seen.add(next.pid);
    if (next.pid !== root && !next.zombie) found.push(next.pid);
    queue.push(...(children.get(next.pid) ?? []));
  }
  return found;
}

/**
 * Every process descended from the exited leader `root`, read from the process table without blocking the event
 * loop, or null when it cannot be read. Windows keeps a process's parent ID after the parent exits, and reuses process
 * IDs, so a parent ID alone can name an unrelated process: a child of the leader must have been created while the
 * leader ran, and each deeper descendant after its own parent (arbitra's audit of itself, October 19, 2026). A second
 * of slack covers the clock. A descendant whose parent has exited cannot be reached through it.
 */
async function windowsDescendants(root: number, startedAt: number, exitedAt: number): Promise<number[] | null> {
  const table = await windowsProcessTable();
  if (table === null) return null;
  const children = new Map<number, { readonly pid: number; readonly created: number }[]>();
  for (const line of table) {
    const [child, parent, created] = line.trim().split(/\s+/u);
    const pidOf = Number(child); const parentOf = Number(parent); const at = Date.parse(created ?? "");
    if (!Number.isSafeInteger(pidOf) || !Number.isSafeInteger(parentOf) || pidOf === parentOf || Number.isNaN(at)) continue;
    children.set(parentOf, [...(children.get(parentOf) ?? []), { pid: pidOf, created: at }]);
  }
  const found: number[] = [];
  const queue = (children.get(root) ?? []).filter(({ created }) => created >= startedAt - 1_000 && created <= exitedAt + 1_000);
  for (const seen = new Set<number>(); queue.length > 0;) {
    const next = queue.pop();
    if (next === undefined || seen.has(next.pid)) continue;
    seen.add(next.pid); found.push(next.pid);
    queue.push(...(children.get(next.pid) ?? []).filter(({ created }) => created >= next.created - 1_000));
  }
  return found;
}

interface WindowsTableReader { readonly child: ChildProcess; readonly waiting: ((table: string[] | null) => void)[]; readonly lines: string[]; partial: string; idle?: NodeJS.Timeout; readonly close: () => void }
let windowsTableReader: WindowsTableReader | null = null;

/**
 * Lines of `pid parentPid created` for every process, or null when the table cannot be read. Every native call ends
 * with a look, and starting PowerShell took about a second on Windows 11 (October 2026) where a look in a running one
 * took a tenth of that, so one PowerShell, reading a command per line on stdin, serves every look and ends after a
 * minute without one. It does not keep the host running.
 */
function windowsProcessTable(): Promise<string[] | null> {
  const look = "try { Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '-' })\" } } catch { '!' }; '.'";
  let reader = windowsTableReader;
  if (reader === null) {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "-"], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    const started: WindowsTableReader = { child, waiting: [], lines: [], partial: "", close: () => {
      if (windowsTableReader === started) windowsTableReader = null;
      clearTimeout(started.idle); child.kill();
      for (const waiter of started.waiting.splice(0)) waiter(null);
    } };
    child.on("error", started.close); child.on("exit", started.close); child.stdin.on("error", started.close);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const lines = (started.partial + chunk).split("\n"); started.partial = lines.pop() ?? "";
      for (const line of lines.map((text) => text.replace(/\r$/u, ""))) {
        if (line !== ".") { started.lines.push(line); continue; }
        const table = started.lines.splice(0);
        started.waiting.shift()?.(table.includes("!") ? null : table);
      }
    });
    child.unref(); for (const pipe of [child.stdin, child.stdout]) (pipe as Socket).unref();
    windowsTableReader = reader = started;
  }
  const current = reader;
  clearTimeout(current.idle);
  return new Promise((done) => {
    const bound = setTimeout(current.close, 10_000);
    current.waiting.push((table) => {
      clearTimeout(bound);
      if (current.waiting.length === 0 && windowsTableReader === current) current.idle = setTimeout(current.close, 60_000).unref();
      done(table);
    });
    current.child.stdin?.write(`${look}\n`);
  });
}

function signal(target: number, name: NodeJS.Signals): void {
  // macOS reports EPERM for a group whose remaining members are zombies awaiting
  // reaping. This runs from process event handlers, so it must not throw; whether
  // the tree is really gone is established separately by `terminated`.
  try { process.kill(target, name); } catch (error) { const code = (error as NodeJS.ErrnoException).code; if (code !== "ESRCH" && code !== "EPERM") throw error; }
}

/** Whether the tree is gone: on POSIX the leader's process group, and every descendant that was ended. */
async function terminated(tree: ProcessTree): Promise<boolean> {
  // Time-bounded rather than attempt-bounded: on a loaded host (CI running every suite
  // in parallel) group members can take well over a second to be reaped. EPERM is not
  // treated as gone, because a live setuid descendant also reports it.
  const running = (target: number) => { try { process.kill(target, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } };
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const group = process.platform !== "win32" && running(-tree.root);
    if (!group && ![...tree.ended].some(running)) return true;
    if (group) signal(-tree.root, "SIGKILL");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  return false;
}
