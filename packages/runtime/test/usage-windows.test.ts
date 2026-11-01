import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLAUDE_NOT_READ, parseCodexRateLimits, readCodexUsage, readUsageWindows } from "../src/usage-windows.js";

/** Codex's answer as it was read on November 1, 2026 (a Plus plan, five-hour window 81% used). */
const ANSWER = JSON.stringify({ id: 2, result: { ordinaryUsageAllowed: true, rateLimits: { limitId: "codex", primary: { usedPercent: 81, windowDurationMins: 300, resetsAt: 1793554365 },
  secondary: { usedPercent: 29, windowDurationMins: 10080, resetsAt: 1794123083 }, credits: { hasCredits: false, unlimited: false, balance: "0" }, planType: "plus", rateLimitReachedType: null } } });

describe("Codex's usage windows, as its app server answers", () => {
  it("reads the five-hour window and the week with their reset times, and the plan Codex names", () => {
    expect(parseCodexRateLimits(ANSWER)).toEqual({ state: "read", plan: "plus",
      fiveHour: { usedPercent: 81, resetsAt: "2026-11-01T17:32:45.000Z" }, week: { usedPercent: 29, resetsAt: "2026-11-08T07:31:23.000Z" } });
  });

  it("names a window by its length, so a plan with only a week is not shown as a five-hour window", () => {
    const weekOnly = JSON.stringify({ id: 2, result: { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1794123083 }, secondary: null } } });
    expect(parseCodexRateLimits(weekOnly)).toEqual({ state: "read", plan: null, fiveHour: null, week: { usedPercent: 12, resetsAt: "2026-11-08T07:31:23.000Z" } });
    // An answer that gives no lengths is taken in order, as the first Codex versions gave it.
    const unnamed = JSON.stringify({ id: 2, result: { rateLimits: { primary: { usedPercent: 5 }, secondary: { usedPercent: 6 } } } });
    expect(parseCodexRateLimits(unnamed)).toEqual({ state: "read", plan: null, fiveHour: { usedPercent: 5, resetsAt: null }, week: { usedPercent: 6, resetsAt: null } });
  });

  it("reads nothing from an error, an answer without windows or a line that is not JSON", () => {
    for (const line of ['{"id":2,"error":{"code":-32601,"message":"method not found"}}', '{"id":2,"result":{}}', '{"id":2,"result":{"rateLimits":{"primary":{"usedPercent":"a lot"}}}}', "codex: unknown command", ""]) expect(parseCodexRateLimits(line)).toBeNull();
  });
});

let folder: string | null = null;
afterEach(async () => { if (folder !== null) await rm(folder, { recursive: true, force: true, maxRetries: 3 }); folder = null; });

/** A stand-in `codex` (a script the host's Node runs) that behaves as `behaviour` says; its process ID is written beside it. */
async function codex(behaviour: "answers" | "too_old" | "silent"): Promise<{ readonly lookup: (name: string) => string | undefined; readonly pidFile: string }> {
  folder = await mkdtemp(join(tmpdir(), "arbitra-usage-"));
  const script = join(folder, "codex.js");
  const pidFile = join(folder, "pid");
  const source = [
    `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    behaviour === "too_old" ? `console.error("error: unrecognized subcommand 'app-server'"); process.exit(2);` : "",
    `let buffer = ""; const newline = String.fromCharCode(10);`,
    `process.stdin.on("data", (chunk) => { buffer += chunk; let at; while ((at = buffer.indexOf(newline)) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (${behaviour === "answers"} && JSON.parse(line).id === 2) process.stdout.write(${JSON.stringify(ANSWER)} + newline); } });`,
    // Like the real server, it quits at the end of its input, which is why the input stays open until it answers.
    `process.stdin.on("end", () => process.exit(0)); setTimeout(() => {}, 60000);`,
  ].join("\n");
  await writeFile(script, source, "utf8");
  return { lookup: (name) => name === "ARBITRA_CODEX_EXECUTABLE" ? script : process.env[name], pidFile };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("reading Codex without a model call", () => {
  it("asks the app server and reads its answer before the server is gone, then ends it", { timeout: 30_000 }, async () => {
    const { lookup, pidFile } = await codex("answers");
    const started = Date.now();
    const reading = await readCodexUsage({ lookup });
    expect(reading).toMatchObject({ state: "read", plan: "plus", fiveHour: { usedPercent: 81 }, week: { usedPercent: 29 } });
    expect(Date.now() - started).toBeLessThan(9_000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(alive(Number(await readFile(pidFile, "utf8")))).toBe(false);
  });

  it("says not read for a Codex that is absent or too old, and gives up on one that never answers, ending its process", { timeout: 30_000 }, async () => {
    expect(await readCodexUsage({ lookup: (name) => name === "ARBITRA_CODEX_EXECUTABLE" ? join(tmpdir(), "no-such-codex.js") : process.env[name] })).toEqual({ state: "not_read", reason: "Codex is not installed" });
    const old = await codex("too_old");
    expect(await readCodexUsage({ lookup: old.lookup })).toEqual({ state: "not_read", reason: "Codex did not give its usage windows" });
    const silent = await codex("silent");
    const started = Date.now();
    expect(await readCodexUsage({ lookup: silent.lookup, timeoutMs: 1_000 })).toEqual({ state: "not_read", reason: "Codex did not give its usage windows" });
    expect(Date.now() - started).toBeLessThan(8_000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(alive(Number(await readFile(silent.pidFile, "utf8")))).toBe(false);
  });

  it("does not read Claude Code's windows: they appear only in a model call", async () => {
    const { lookup } = await codex("answers");
    expect(await readUsageWindows({ lookup })).toMatchObject({ claude: CLAUDE_NOT_READ, codex: { state: "read" } });
  });
});
