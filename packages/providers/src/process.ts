import { spawn, spawnSync } from "node:child_process";

/**
 * Bounded native-process execution with process-tree termination. On POSIX the native
 * process leads its own process group, and every exit path (normal, timeout,
 * cancellation, protocol violation) kills the whole group, so tool subprocesses the
 * harness started cannot outlive it. The host shell is never used.
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
  /** Every process in the native process group is gone. */
  readonly treeTerminated: boolean;
}
export interface NativeProcessPort { run(request: NativeProcessRequest): Promise<NativeProcessResult> }

const MAXIMUM_STDERR_BYTES = 64 * 1024;
/** How long the pipes may stay open after the leader exits on Windows before its descendants are ended. */
const WINDOWS_EXIT_GRACE_MS = 2_000;

export function runNativeProcess(request: NativeProcessRequest): Promise<NativeProcessResult> {
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || !Number.isSafeInteger(request.maximumOutputBytes) || request.maximumOutputBytes < 1) throw new Error("INVALID_NATIVE_PROCESS_BOUND");
  if (request.signal.aborted) return Promise.resolve({ pid: null, exitCode: null, exitSignal: null, stopped: "cancelled", violation: null, stdout: "", stderr: "", treeTerminated: true });
  return new Promise((resolveResult) => {
    const posix = process.platform !== "win32";
    const child = spawn(request.executable, [...request.arguments], { cwd: request.cwd, env: { ...request.environment }, shell: false, windowsHide: true, detached: posix, stdio: ["pipe", "pipe", "pipe"] });
    const pid = child.pid ?? null;
    let stopped: NativeProcessStop | null = null; let violation: unknown = null;
    let stdoutBytes = 0; let pending = Buffer.alloc(0); const collected: Buffer[] = [];
    let stderr = Buffer.alloc(0);
    const terminate = () => { if (pid !== null) killTree(pid); else child.kill("SIGKILL"); };
    const stop = (reason: NativeProcessStop) => { if (stopped === null) stopped = reason; terminate(); };
    if (pid !== null) request.onSpawn?.(pid);
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
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < MAXIMUM_STDERR_BYTES) stderr = Buffer.concat([stderr, chunk.subarray(0, MAXIMUM_STDERR_BYTES - stderr.length)]); });
    const cancelled = () => stop("cancelled");
    request.signal.addEventListener("abort", cancelled, { once: true });
    const timer = setTimeout(() => stop("timeout"), request.timeoutMs);
    child.on("error", () => { if (stopped === null) stopped = "spawn_error"; });
    // The leader exiting does not end its group: descendants holding stdout would keep
    // the pipes open. Kill the remaining group so `close` is reached. Windows has no group, and
    // taskkill /T needs a living root, so a descendant still holding the pipes after a short grace
    // is found in the process table by its parent and ended; without this a call stayed open until
    // its timeout (30 minutes for a CLI call).
    let grace: NodeJS.Timeout | undefined;
    child.on("exit", () => {
      if (pid === null) return;
      if (posix) { killTree(pid); return; }
      grace = setTimeout(() => { for (const descendant of windowsDescendants(pid)) killTree(descendant); child.stdout.destroy(); child.stderr.destroy(); }, WINDOWS_EXIT_GRACE_MS);
    });
    child.on("close", (exitCode, exitSignal) => {
      clearTimeout(timer); clearTimeout(grace); request.signal.removeEventListener("abort", cancelled);
      if (pending.length > 0) { deliver(pending); pending = Buffer.alloc(0); }
      if (pid !== null) killTree(pid);
      void waitForTree(pid).then((treeTerminated) => resolveResult({ pid, exitCode, exitSignal, stopped, violation,
        stdout: Buffer.concat(collected).toString("utf8"), stderr: stderr.toString("utf8"), treeTerminated }));
    });
    if (request.signal.aborted) cancelled();
  });
}

/**
 * Every process descended from `root` by parent ID, read from the process table. Windows keeps a process's parent ID
 * after the parent exits, so the descendants of a leader that has exited are still found. Bounded like taskkill.
 */
function windowsDescendants(root: number): number[] {
  const listed = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"],
    { windowsHide: true, encoding: "utf8", timeout: 10_000 });
  if (listed.status !== 0 || typeof listed.stdout !== "string") return [];
  const children = new Map<number, number[]>();
  for (const line of listed.stdout.split(/\r?\n/u)) {
    const [child, parent] = line.trim().split(/\s+/u).map(Number);
    if (child !== undefined && parent !== undefined && Number.isSafeInteger(child) && Number.isSafeInteger(parent) && child !== parent) children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const found: number[] = [];
  for (const queue = [root], seen = new Set(queue); queue.length > 0;) {
    for (const child of children.get(queue.pop() ?? root) ?? []) if (!seen.has(child)) { seen.add(child); found.push(child); queue.push(child); }
  }
  return found;
}

function killTree(pid: number): void {
  // Bounded: this blocks the event loop, and a taskkill that hangs would otherwise stop every timer, cancellation and run in the process.
  if (process.platform === "win32") { spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 10_000 }); return; }
  // macOS reports EPERM for a group whose remaining members are zombies awaiting
  // reaping. This runs from process event handlers, so it must not throw; whether
  // the tree is really gone is established separately by `waitForTree`.
  try { process.kill(-pid, "SIGKILL"); } catch (error) { const code = (error as NodeJS.ErrnoException).code; if (code !== "ESRCH" && code !== "EPERM") throw error; }
}

async function waitForTree(pid: number | null): Promise<boolean> {
  if (pid === null || process.platform === "win32") return true;
  // Time-bounded rather than attempt-bounded: on a loaded host (CI running every suite
  // in parallel) group members can take well over a second to be reaped. EPERM is not
  // treated as gone, because a live setuid descendant also reports it.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { process.kill(-pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; }
    killTree(pid);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  return false;
}
