import { describe, expect, it } from "vitest";
import { runNativeProcess } from "../src/process.js";

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
});
