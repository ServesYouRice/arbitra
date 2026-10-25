import type { SpawnSyncReturns } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runNativeProcess } from "../src/process.js";

// The real taskkill runs; a test then replaces what it reports with a failure that cannot be caused on demand (access
// denied, a hang cut off by the bound).
const taskkill = vi.hoisted(() => ({ reported: null as Partial<SpawnSyncReturns<Buffer>> | null }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const spawnSync = (...input: Parameters<typeof actual.spawnSync>) => {
    const result = actual.spawnSync(...input);
    return input[0] === "taskkill" && taskkill.reported !== null ? { ...result, ...taskkill.reported } : result;
  };
  return { ...actual, spawnSync };
});
afterEach(() => { taskkill.reported = null; });

describe.skipIf(process.platform !== "win32")("native process trees on Windows", () => {
  it.each([
    ["is denied access", { status: 1 }],
    ["is cut off by its bound", { status: null, signal: "SIGTERM" as const, error: Object.assign(new Error("spawnSync taskkill ETIMEDOUT"), { code: "ETIMEDOUT" }) }],
  ])("does not report the tree terminated when taskkill %s", { timeout: 30_000 }, async (_, reported) => {
    taskkill.reported = reported;
    const result = await runNativeProcess({ executable: process.execPath, arguments: ["-e", "setTimeout(() => {}, 60000)"], cwd: process.cwd(), environment: { ...process.env } as Record<string, string>,
      stdin: "", timeoutMs: 1_000, maximumOutputBytes: 10_000, signal: new AbortController().signal });
    expect(result).toMatchObject({ stopped: "timeout", treeTerminated: false });
  });
});
