import { duration, tokenWords } from "../../app/words.js";

/**
 * What a run will use before it starts, from measured runs only (docs/qa/real-runs.md): tokens from the tokens a line
 * the runs used, by vendor as they split, and a time range only for a project of a size a run measured. A depth or a
 * setting no run has measured says so instead of a guess. Shares of a vendor's five-hour or weekly window are left out:
 * the app does not know the person's plan.
 */
export interface MeasuredRun { readonly project: string; readonly lines: number; readonly minutes: number; readonly tokensPerLine: number }
/** `tokensPerLine` when the rate comes from other runs than the time; else each run's own. */
interface Basis { readonly runs: readonly MeasuredRun[]; readonly what: string; readonly tokensPerLine?: readonly number[] }
const ratesOf = (basis: Basis): readonly number[] => basis.tokensPerLine ?? basis.runs.map(({ tokensPerLine }) => tokensPerLine);

/**
 * At deep, no review round. The tokens are from the runs since finders read beyond their unit: the MacBook run (three
 * finders, October 26 to 27, its time mostly asleep) and nananananana (two, November 1); the three before used half
 * as many (605 to 688). The time counts those three too, with the plan critic on.
 */
const DEEP: Basis = { what: "2 runs at deep since finders read beyond their unit for the tokens, 4 runs for the time", tokensPerLine: [1_290, 1_330], runs: [
  { project: "commentanywhere", lines: 11_719, minutes: 40, tokensPerLine: 640 },
  { project: "rokbot", lines: 26_100, minutes: 71, tokensPerLine: 605 },
  { project: "nextra", lines: 38_967, minutes: 105, tokensPerLine: 688 },
  { project: "nananananana", lines: 84_380, minutes: 197, tokensPerLine: 1_330 },
] };
/** At deep with one review round and Gemini as the third finder (October 20 to 22, 2026), on earlier builds. */
const REVIEWED: Basis = { what: "3 runs at deep with one review round on October 20 to 22", runs: [
  { project: "rokavatar", lines: 10_716, minutes: 110, tokensPerLine: 1_455 },
  { project: "beachflag", lines: 11_291, minutes: 80, tokensPerLine: 1_560 },
  { project: "blog", lines: 14_204, minutes: 63, tokensPerLine: 922 },
] };
const SIZE_MARGIN = 0.1;
/** Each vendor's share of a deep run's tokens, by finder count: rokbot ran two finders, nextra three. */
const SHARES: Readonly<Record<2 | 3, readonly (readonly [string, number])[]>> = { 2: [["Claude Code", 0.87], ["Codex", 0.13]], 3: [["Claude Code", 0.81], ["Codex", 0.12], ["Antigravity", 0.07]] };

/** `names` says what reaches each finder in this lineup ("Anthropic's API", "the third finder"); the shares are the measured ones. */
export interface UsageInput { readonly depth: string; readonly finders: 2 | 3; readonly reviewRound: boolean; readonly critic: boolean; readonly lines: number | null; readonly names?: readonly string[] }
export interface Usage {
  readonly basis: Basis | null;
  readonly perLine: { readonly low: number; readonly high: number } | null;
  readonly tokens: { readonly low: number; readonly high: number } | null;
  readonly vendors: readonly { readonly name: string; readonly low: number; readonly high: number }[];
  /** Null when no run of this kind was as small or as large as the project. */
  readonly minutes: { readonly low: number; readonly high: number } | null;
  readonly perThousandLines: { readonly low: number; readonly high: number } | null;
  readonly input: UsageInput;
}

export function usage(input: UsageInput): Usage {
  const basis = input.depth !== "deep" ? null : input.reviewRound ? REVIEWED : DEEP;
  if (basis === null) return { basis, perLine: null, tokens: null, vendors: [], minutes: null, perThousandLines: null, input };
  const rates = ratesOf(basis);
  // The measured rates, widened to the hundreds around them: an estimate with a little room, as people read one.
  const perLine = { low: Math.floor(Math.min(...rates) / 100) * 100, high: Math.ceil(Math.max(...rates) / 100) * 100 };
  const speeds = basis.runs.map(({ minutes, lines }) => minutes / lines * 1_000);
  const perThousandLines = { low: Math.min(...speeds), high: Math.max(...speeds) };
  if (input.lines === null) return { basis, perLine, tokens: null, vendors: [], minutes: null, perThousandLines, input };
  const tokens = { low: input.lines * perLine.low, high: input.lines * perLine.high };
  const vendors = input.reviewRound ? [] : SHARES[input.finders].map(([name, share], index) => ({ name: input.names?.[index] ?? name, low: Math.round(tokens.low * share), high: Math.round(tokens.high * share) }));
  // A project within a tenth of the sizes measured counts as measured: nextra's checkout reads a few lines more than
  // its run did. Further out, the time per line is not known to hold.
  const sizes = basis.runs.map(({ lines }) => lines);
  const measuredSize = input.lines >= Math.min(...sizes) * (1 - SIZE_MARGIN) && input.lines <= Math.max(...sizes) * (1 + SIZE_MARGIN);
  const minutes = measuredSize ? { low: Math.floor(input.lines / 1_000 * perThousandLines.low / 5) * 5, high: Math.ceil(input.lines / 1_000 * perThousandLines.high / 5) * 5 } : null;
  return { basis, perLine, tokens, vendors, minutes, perThousandLines, input };
}

/** What a run will use, in words; `short` is the basis in one line for a card, `basis` the whole of it. */
export interface UsageWords { readonly tokens: string; readonly vendors: string | null; readonly time: string; readonly basis: string | null; readonly short: string | null }
export function usageWords(estimate: Usage): UsageWords {
  const { basis, perLine, perThousandLines, input } = estimate;
  if (basis === null || perLine === null || perThousandLines === null) return { tokens: "not measured yet", vendors: null, time: "the first run of it measures it", basis: null, short: null };
  const range = (low: number, high: number) => `${tokenWords(low)}–${tokenWords(high)}`;
  const runs = [...basis.runs].sort((a, b) => a.lines - b.lines);
  const smallest = runs[0]; const largest = runs.at(-1);
  const time = (minutes: number) => duration(minutes * 60_000);
  const timeWords = estimate.minutes !== null ? `${time(estimate.minutes.low)} – ${time(estimate.minutes.high)}, not counting a pause for a usage limit`
    : input.lines === null ? `about ${perThousandLines.low.toFixed(1)} to ${perThousandLines.high.toFixed(1)} minutes per 1,000 lines`
    : smallest !== undefined && input.lines < smallest.lines ? `time not measured at this size: the smallest measured, ${smallest.project}, ${smallest.lines.toLocaleString("en")} lines, took ${time(smallest.minutes)}`
    : largest === undefined ? "time not measured at this size" : `time not measured at this size: the largest measured, ${largest.project}, ${largest.lines.toLocaleString("en")} lines, took ${time(largest.minutes)}`;
  const rates = ratesOf(basis);
  const minutes = basis.runs.map(({ minutes: taken }) => taken);
  const critic = input.critic ? "Reviewing the plan, on here, takes 9 to 17% of a run's tokens on top." : "Reviewing the plan is off here; it took 9 to 17% of a run's tokens.";
  return {
    tokens: estimate.tokens === null ? `≈ ${perLine.low.toLocaleString("en")} to ${perLine.high.toLocaleString("en")} tokens a line of the project` : `≈ ${range(estimate.tokens.low, estimate.tokens.high)} tokens`,
    vendors: estimate.vendors.length === 0 ? null : estimate.vendors.map(({ name, low, high }) => `${name} ≈ ${range(low, high)}`).join(" · "),
    time: timeWords,
    short: `basis: ${rates.length} measured runs, ${Math.min(...rates).toLocaleString("en")}–${Math.max(...rates).toLocaleString("en")} tokens a line`,
    basis: `basis: ${basis.what}, ${(smallest?.lines ?? 0).toLocaleString("en")} to ${(largest?.lines ?? 0).toLocaleString("en")} lines: ${Math.min(...rates).toLocaleString("en")} to ${Math.max(...rates).toLocaleString("en")} tokens a line, ${time(Math.min(...minutes))} to ${time(Math.max(...minutes))}. ${critic}`,
  };
}
