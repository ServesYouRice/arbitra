import { afterEach, describe, expect, it } from "vitest";
import { runNativeProcess } from "../src/process.js";

const LONG_LIVED = "setTimeout(() => {}, 60000)";
/** Source that starts `source` as a node process with `options`, and prints its PID on the inherited stdout. */
const start = (source: string, options: string) => `const child = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(source)}], ${options}); process.stdout.write(String(child.pid) + "\\n");`;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const leftovers: number[] = [];
afterEach(() => { for (const pid of leftovers.splice(0)) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } });

async function call(leader: string, timeoutMs: number) {
  const lines: string[] = [];
  const started = Date.now();
  const result = await runNativeProcess({ executable: process.execPath, arguments: ["-e", leader], cwd: process.cwd(), environment: { ...process.env } as Record<string, string>,
    stdin: "", timeoutMs, maximumOutputBytes: 10_000, signal: new AbortController().signal, onLine: (line) => { lines.push(line); } });
  const pids = lines.map(Number);
  leftovers.push(...pids.filter((pid) => Number.isSafeInteger(pid)));
  // Let the system reap what was killed.
  await new Promise((resolve) => setTimeout(resolve, 500));
  return { result, pids, elapsed: Date.now() - started };
}

describe("native process trees", () => {
  it("ends a descendant that keeps the pipes open after its leader exits", { timeout: 30_000 }, async () => {
    // The leader starts a grandchild that inherits stdout and outlives it, then exits at once. On Windows the grandchild
    // is detached, which takes it out of the job object Node puts its children in, as the children of a native CLI are;
    // on POSIX it stays in the leader's process group. Before this was handled on Windows, `close` waited for the
    // grandchild, which is to say for the call's timeout.
    const grandchild = "setTimeout(() => {}, 60000)";
    const leader = `const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: ["ignore", "inherit", "inherit"], detached: process.platform === "win32" }); process.stdout.write(String(child.pid) + "\\n"); process.exit(0);`;
    const lines: string[] = [];
    const started = Date.now();
    const result = await runNativeProcess({ executable: process.execPath, arguments: ["-e", leader], cwd: process.cwd(), environment: { ...process.env } as Record<string, string>,
      stdin: "", timeoutMs: 25_000, maximumOutputBytes: 10_000, signal: new AbortController().signal, onLine: (line) => { lines.push(line); } });
    expect(result).toMatchObject({ exitCode: 0, stopped: null, treeTerminated: true });
    expect(Date.now() - started).toBeLessThan(20_000);
    const descendant = Number(lines[0]);
    expect(Number.isSafeInteger(descendant)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(() => process.kill(descendant, 0)).toThrow();
  });

  // A detached child leads its own session and process group on POSIX, out of reach of a kill sent to the leader's
  // group: holding the pipes, it kept the call from ever returning; holding none, it outlived a tree reported
  // terminated. On Windows it leaves the job object Node puts its children in.
  it("ends a descendant in its own session that holds the pipes when the call times out", { timeout: 30_000 }, async () => {
    const { result, pids, elapsed } = await call(`${start(LONG_LIVED, `{ stdio: ["ignore", "inherit", "inherit"], detached: true }`)} ${LONG_LIVED};`, 1_500);
    expect(result).toMatchObject({ stopped: "timeout", treeTerminated: true });
    expect(elapsed).toBeLessThan(15_000);
    expect(pids.map(alive)).toEqual([false]);
  });

  it("ends a descendant in its own session that holds no pipe when the call times out", { timeout: 30_000 }, async () => {
    const { result, pids } = await call(`${start(LONG_LIVED, `{ stdio: "ignore", detached: true }`)} ${LONG_LIVED};`, 1_500);
    expect(result).toMatchObject({ stopped: "timeout", treeTerminated: true });
    expect(pids.map(alive)).toEqual([false]);
  });

  it("ends a descendant that holds no pipe after its leader exits", { timeout: 30_000 }, async () => {
    // Nothing keeps `close` from following the leader's exit at once, so the descendants are looked for after it: on
    // Windows such a descendant outlived a tree reported terminated.
    const { result, pids } = await call(`${start(LONG_LIVED, `{ stdio: "ignore", detached: process.platform === "win32" }`)} process.exit(0);`, 25_000);
    expect(result).toMatchObject({ exitCode: 0, stopped: null, treeTerminated: true });
    expect(pids.map(alive)).toEqual([false]);
  });

  it("says whether a descendant that holds the pipes after its parents exited is gone, without waiting for the timeout", { timeout: 60_000 }, async () => {
    // The leader's child starts the holder and exits before the leader does, so no living parent leads to the holder:
    // on POSIX it is an orphan in its own session, on Windows its parent ID names a process that is gone. It kept a
    // POSIX call open for good, and on Windows outlived a tree reported terminated.
    const middle = `${start(LONG_LIVED, `{ stdio: ["ignore", "inherit", "inherit"], detached: true }`)} process.exit(0);`;
    const leader = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(middle)}], { stdio: ["ignore", "inherit", "inherit"], detached: true }).on("exit", () => process.exit(0));`;
    const { result, pids, elapsed } = await call(leader, 40_000);
    expect(result).toMatchObject({ exitCode: 0, stopped: null });
    expect(elapsed).toBeLessThan(20_000);
    expect(pids).toHaveLength(1);
    expect(result.treeTerminated).toBe(!pids.some(alive));
  });
});

describe("native process start", () => {
  it("reports a spawn that Node refuses at once as a spawn error, not a rejection", async () => {
    // Windows refuses a `.cmd` without a shell by throwing (EINVAL); a NUL byte in the path is refused the same way everywhere.
    await expect(runNativeProcess({ executable: `${process.execPath}\0`, arguments: [], cwd: process.cwd(), environment: {}, stdin: "", timeoutMs: 5_000, maximumOutputBytes: 1_000,
      signal: new AbortController().signal, onLine: () => undefined })).resolves.toMatchObject({ pid: null, stopped: "spawn_error", treeTerminated: true });
  });
});
