/**
 * A run's token limit for a project of a given size. A guess with headroom, to be replaced by measured numbers: the
 * beachflag run (October 20, 2026; 84 files, 11,291 lines, three auditors) was past 16M tokens by mid-verification, so
 * about 2,200 tokens a line is assumed for a whole run, doubled to 4,500 for headroom, scaled by the number of
 * auditors, rounded up to 5M, and never under 20M.
 */
export function recommendedTokenLimit(lines: number, auditors: number): number {
  const estimate = Math.max(0, lines) * 4_500 * Math.max(1, auditors) / 3;
  return Math.max(20_000_000, Math.ceil(estimate / 5_000_000) * 5_000_000);
}

/** The limit a budget-paused run resumes with: half as much again, rounded up to 5M. */
export function raisedTokenLimit(current: number): number {
  return Math.ceil(current * 1.5 / 5_000_000) * 5_000_000;
}

/** 40000000 → "40M". */
export function tokens(value: number): string {
  return value >= 1_000_000 ? `${Number((value / 1_000_000).toFixed(1))}M` : value >= 1_000 ? `${Math.round(value / 1_000)}K` : String(value);
}
