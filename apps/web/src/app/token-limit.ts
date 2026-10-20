/**
 * A run's token limit for a project of a given size. Measured once: the beachflag run (October 20, 2026; 84 files,
 * 11,291 lines, three auditors, every issue verified) used 17.6M tokens, about 1,560 a line. The limit allows 3,500 a
 * line, a little over twice that, for projects that turn up more issues per line; it scales with the number of
 * auditors, rounds up to 5M and is never under 20M. More measured runs should replace the guess in the headroom.
 */
export function recommendedTokenLimit(lines: number, auditors: number): number {
  const estimate = Math.max(0, lines) * 3_500 * Math.max(1, auditors) / 3;
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
