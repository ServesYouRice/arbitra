/**
 * What each vendor's usage meters say now, as the server reads them (`GET /diagnostics/usage-windows`, from
 * packages/runtime/src/usage-windows.ts). A meter that was not read says so; nothing here is a guess.
 */
export interface UsageWindow { readonly usedPercent: number; readonly resetsAt: string | null }
export type VendorUsage =
  | { readonly state: "read"; readonly fiveHour: UsageWindow | null; readonly week: UsageWindow | null; readonly plan: string | null }
  | { readonly state: "not_read"; readonly reason: string };
export interface UsageWindows { readonly checkedAt: string; readonly codex: VendorUsage; readonly claude: VendorUsage }
/** The windows as the page holds them: being read in the background, not read, or read. */
export type WindowsState = "loading" | "failed" | UsageWindows;

/** A reset time as people say it: "13:31" within a day, "Sun 07:31" further out. */
export function resetWords(iso: string | null, now: Date = new Date()): string | null {
  if (iso === null) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const time = at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return at.getTime() - now.getTime() < 20 * 3_600_000 && at.getDate() === now.getDate() ? time : `${at.toLocaleDateString("en-GB", { weekday: "short" })} ${time}`;
}

/** One window in words: "5-hour window 31% used, resets 13:31". */
function windowWords(name: string, window: UsageWindow, now: Date, used: boolean): string {
  const reset = resetWords(window.resetsAt, now);
  return `${name} ${Math.round(window.usedPercent)}%${used ? " used" : ""}${reset === null ? "" : `, resets ${reset}`}`;
}

/** What Codex's meters say, in one line: "5-hour window 31% used, resets 13:31; week 5%, resets Sun 07:31". Null when they were not read. */
export function codexWords(windows: UsageWindows, now: Date = new Date()): string | null {
  const { codex } = windows;
  if (codex.state !== "read") return null;
  const parts = [codex.fiveHour === null ? null : windowWords("5-hour window", codex.fiveHour, now, true), codex.week === null ? null : windowWords("week", codex.week, now, false)].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : `${parts.join("; ")}${codex.plan === null ? "" : ` · ${codex.plan} plan`}`;
}
