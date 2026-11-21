import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HostLookup } from "./discovery.js";

/**
 * Host-local record of the last observed subscription usage limit per CLI transport, so
 * preflight can report "usage limit reached until <reset>" without spending a model call.
 * It holds only the transport, the model for a CLI whose limits are per model, the reset time
 * and a bounded, redacted message.
 *
 * A CLI whose limits are per model (`limitsPerModel`, the Antigravity CLI) records each model's
 * limit under the model: observed live (November 21, 2026), Gemini 4 Argon met a weekly limit of
 * its own while the other Gemini models had all of theirs, and a limit kept for the whole CLI
 * would have refused a run on those too.
 */
export interface CliUsageLimit { readonly transport: string; readonly modelId?: string; readonly observedAt: number; readonly resetsAt: number | null; readonly message: string }
export interface CliLimitLedger {
  record(limit: CliUsageLimit): Promise<void>;
  /** Clears the transport's limit and, given a model, that model's own: a call that was answered shows neither is in force. */
  clear(transport: string, modelId?: string): Promise<void>;
  /** The limit still in force at `now`, the transport's or (given a model) that model's own: before its reset, or within
   * five hours when the reset is unknown. */
  current(transport: string, now: number, modelId?: string): Promise<CliUsageLimit | null>;
}

const UNKNOWN_RESET_WINDOW_MS = 5 * 60 * 60 * 1_000;
/** A model's entry sits beside its transport's: `antigravity-cli:gemini-4-argon-high`. */
const keyOf = (transport: string, modelId?: string): string => modelId === undefined ? transport : `${transport}:${modelId}`;

export function fileLimitLedger(path: string): CliLimitLedger {
  const load = async (): Promise<Record<string, CliUsageLimit>> => {
    try { const value = JSON.parse(await readFile(path, "utf8")) as unknown; return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, CliUsageLimit> : {}; }
    catch { return {}; }
  };
  const save = async (value: Record<string, CliUsageLimit>) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  };
  return {
    async record(limit) { await save({ ...await load(), [keyOf(limit.transport, limit.modelId)]: { ...limit, message: limit.message.slice(0, 400) } }); },
    async clear(transport, modelId) {
      const all = await load();
      const keys = [keyOf(transport), ...(modelId === undefined ? [] : [keyOf(transport, modelId)])].filter((key) => Object.hasOwn(all, key));
      if (keys.length === 0) return;
      for (const key of keys) delete all[key];
      await save(all);
    },
    async current(transport, now, modelId) {
      const entry = (await load())[keyOf(transport, modelId)];
      if (entry === undefined || typeof entry.observedAt !== "number") return null;
      const active = typeof entry.resetsAt === "number" ? entry.resetsAt > now : now - entry.observedAt < UNKNOWN_RESET_WINDOW_MS;
      return active ? entry : null;
    },
  };
}

/** `$XDG_CACHE_HOME/arbitra`, `~/Library/Caches/arbitra` or `%LOCALAPPDATA%\arbitra`. */
export function defaultLimitLedgerPath(lookup: HostLookup, platform: NodeJS.Platform): string | null {
  const override = lookup("ARBITRA_CLI_LIMITS_FILE");
  if (override !== undefined && override !== "") return override;
  const home = lookup(platform === "win32" ? "USERPROFILE" : "HOME");
  const base = platform === "win32" ? lookup("LOCALAPPDATA") ?? (home === undefined ? undefined : join(home, "AppData", "Local"))
    : lookup("XDG_CACHE_HOME") ?? (home === undefined ? undefined : platform === "darwin" ? join(home, "Library", "Caches") : join(home, ".cache"));
  return base === undefined ? null : join(base, "arbitra", "subscription-limits.json");
}
