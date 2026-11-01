import { hostNodeExecutable } from "@arbitra/providers/transports/cli/discovery.js";
import type { NativeProcessPort } from "@arbitra/providers/process.js";
import { cliTransportSupport } from "@arbitra/providers/transports/cli/support.js";
import { runCliCommand, supportedCliExecutable, type CliCommandOptions } from "@arbitra/providers/transports/cli/transport.js";

/** One usage window of a plan as a vendor's meter shows it now: how much of it is used, and when it resets. */
export interface UsageWindow { readonly usedPercent: number; /** ISO time; null when the meter gave none. */ readonly resetsAt: string | null }
/** What one vendor's meters say, or why they were not read. Never a guess: a meter that was not read is `not_read`. */
export type VendorUsage =
  | { readonly state: "read"; readonly fiveHour: UsageWindow | null; readonly week: UsageWindow | null; /** The plan the vendor names, such as `plus`. */ readonly plan: string | null }
  | { readonly state: "not_read"; readonly reason: string };
export interface UsageWindows { readonly checkedAt: string; readonly codex: VendorUsage; readonly claude: VendorUsage }

/** How long Codex has to answer; a slower or older Codex is simply not read. */
export const CODEX_READ_TIMEOUT_MS = 10_000;
const FIVE_HOURS = 300;
const WEEK = 10_080;

const record = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

function windowOf(value: unknown): { readonly window: UsageWindow; readonly minutes: number | null } | null {
  const meter = record(value);
  const used = meter?.["usedPercent"];
  if (meter === null || typeof used !== "number" || !Number.isFinite(used) || used < 0) return null;
  const resets = meter["resetsAt"];
  const minutes = meter["windowDurationMins"];
  return { window: { usedPercent: used, resetsAt: typeof resets === "number" && Number.isFinite(resets) && resets > 0 ? new Date(resets * 1000).toISOString() : null }, minutes: typeof minutes === "number" ? minutes : null };
}

/**
 * Codex's answer to `account/rateLimits/read`: `result.rateLimits.primary` and `.secondary`, each a window with its
 * length in minutes (300 is the five-hour window, 10,080 the week). A plan with one window names it by its length, so a
 * week-only plan is not shown as a five-hour one; a window with no length is taken in order. Null when the line is not
 * an answer with usable windows.
 */
export function parseCodexRateLimits(line: string): VendorUsage | null {
  let message: Record<string, unknown> | null;
  try { message = record(JSON.parse(line)); } catch { return null; }
  const result = record(message?.["result"]);
  const limits = record(record(record(result?.["rateLimitsByLimitId"])?.["codex"]) ?? result?.["rateLimits"]);
  if (limits === null) return null;
  const windows = [windowOf(limits["primary"]), windowOf(limits["secondary"])];
  if (windows.every((window) => window === null)) return null;
  let fiveHour: UsageWindow | null = null; let week: UsageWindow | null = null;
  for (const [index, entry] of windows.entries()) {
    if (entry === null) continue;
    if (entry.minutes === FIVE_HOURS || (entry.minutes === null && index === 0)) fiveHour ??= entry.window;
    else if (entry.minutes === WEEK || (entry.minutes === null && index === 1)) week ??= entry.window;
  }
  if (fiveHour === null && week === null) return null;
  const plan = limits["planType"];
  return { state: "read", fiveHour, week, plan: typeof plan === "string" && /^[\w -]{1,30}$/u.test(plan) ? plan : null };
}

const REQUESTS = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "arbitra", version: "1.0.0" } } },
  { jsonrpc: "2.0", method: "initialized" },
  { jsonrpc: "2.0", id: 2, method: "account/rateLimits/read" },
].map((request) => JSON.stringify(request)).join("\n") + "\n";
/** Raised by the line reader to end the Codex server once its answer is in. */
class Answered extends Error {}

export interface UsageReadOptions {
  readonly lookup?: (name: string) => string | undefined;
  /** Replaces the native process runner, as the readiness probe's tests do. */
  readonly process?: NativeProcessPort;
  readonly timeoutMs?: number;
}

/**
 * Codex's meters, read through `codex app-server` (its own `account/rateLimits/read`): no model call, no tokens used.
 * The server is ended as soon as it answers, or at the timeout, and its process tree with it. A Codex that is absent,
 * too old to have the server, signed out or slow is `not_read`, never an error.
 */
export async function readCodexUsage(options: UsageReadOptions = {}): Promise<VendorUsage> {
  const lookup = options.lookup ?? ((name: string) => process.env[name]);
  const support = cliTransportSupport("codex-cli");
  if (support === undefined) return { state: "not_read", reason: "Codex is not known" };
  const command: CliCommandOptions = { lookup, ...(options.process === undefined ? {} : { process: options.process }) };
  try {
    const { resolution } = await supportedCliExecutable(support, { platform: process.platform, lookup, nodeExecutable: hostNodeExecutable() }, command);
    if (!resolution.found) return { state: "not_read", reason: "Codex is not installed" };
    let reading: VendorUsage | null = null;
    await runCliCommand(resolution.executable, ["app-server"], { ...command, session: { stdin: REQUESTS, timeoutMs: options.timeoutMs ?? CODEX_READ_TIMEOUT_MS, onLine: (line) => {
      if (!line.startsWith("{\"id\":2,")) return;
      reading = parseCodexRateLimits(line);
      throw new Answered();
    } } });
    return reading ?? { state: "not_read", reason: "Codex did not give its usage windows" };
  } catch { return { state: "not_read", reason: "Codex could not be asked" }; }
}

/**
 * Claude Code's meters appear only in a stream-json call (`rate_limit_event`), which costs a model call; arbitra makes
 * none to read them, and records only the event that says a limit was reached. So they are not read.
 */
export const CLAUDE_NOT_READ: VendorUsage = { state: "not_read", reason: "Claude Code shows its usage windows only in a model call" };

export async function readUsageWindows(options: UsageReadOptions = {}): Promise<UsageWindows> {
  return Object.freeze({ checkedAt: new Date().toISOString(), codex: await readCodexUsage(options), claude: CLAUDE_NOT_READ });
}
