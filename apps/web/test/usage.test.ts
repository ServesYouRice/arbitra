import { describe, expect, it } from "vitest";
import { PLAN_WINDOWS, pauseWords, usage, usageWords, windowSources } from "../src/pages/new-run/usage.js";
import { codexWords, resetWords, type UsageWindows } from "../src/pages/new-run/windows.js";

describe("what a run will use, from measured runs", () => {
  it("estimates a deep audit at the measured 1,200 to 1,400 tokens a line, split by vendor as the runs split", () => {
    const rokbot = usage({ depth: "deep", finders: 2, reviewRound: false, critic: false, lines: 26_100 });
    expect(rokbot.tokens).toEqual({ low: 31_320_000, high: 36_540_000 });
    expect(rokbot.vendors.map(({ name, low, high }) => [name, low, high])).toEqual([["Claude Code", 27_248_400, 31_789_800], ["Codex", 4_071_600, 4_750_200]]);
    // Inside the sizes measured, a time range from the slowest and the fastest minute per line.
    expect(rokbot.minutes).toEqual({ low: 60, high: 90 });
    expect(usageWords(rokbot)).toEqual({ tokens: "≈ 31.3M–36.5M tokens", vendors: "Claude Code ≈ 27.2M–31.8M · Codex ≈ 4.1M–4.8M", time: "1 h 00 – 1 h 30, not counting a pause for a usage limit",
      basis: "basis: 2 runs at deep since finders read beyond their unit for the tokens, 4 runs for the time, 11,719 to 84,380 lines: 1,290 to 1,330 tokens a line, 40 min to 3 h 17. Reviewing the plan is off here; it took 9 to 17% of a run's tokens.",
      short: "basis: 2 measured runs, 1,290–1,330 tokens a line" });
    const three = usage({ depth: "deep", finders: 3, reviewRound: false, critic: true, lines: 38_967 });
    expect(three.vendors.map(({ name }) => name)).toEqual(["Claude Code", "Codex", "Antigravity"]);
    expect(usageWords(three).basis).toBe("basis: 2 runs at deep since finders read beyond their unit for the tokens, 4 runs for the time, 11,719 to 84,380 lines: 1,290 to 1,330 tokens a line, 40 min to 3 h 17. Reviewing the plan, on here, takes 9 to 17% of a run's tokens on top.");
  });

  it("gives a time for a project within a tenth of the sizes measured, and none for one larger or smaller", () => {
    expect(usage({ depth: "deep", finders: 2, reviewRound: false, critic: false, lines: 92_000 }).minutes).toEqual({ low: 210, high: 315 });
    expect(usage({ depth: "deep", finders: 2, reviewRound: false, critic: false, lines: 93_000 }).minutes).toBeNull();
    expect(usage({ depth: "deep", finders: 2, reviewRound: false, critic: false, lines: 10_600 }).minutes).toEqual({ low: 20, high: 40 });
  });

  it("gives no time for a project far larger or smaller than any measured, and the rate before the project is read", () => {
    const veritra = usage({ depth: "deep", finders: 2, reviewRound: false, critic: false, lines: 103_159 });
    expect([veritra.tokens, veritra.minutes]).toEqual([{ low: 123_790_800, high: 144_422_600 }, null]);
    expect(usageWords(veritra).time).toBe("time not measured at this size: the largest measured, nananananana, 84,380 lines, took 3 h 17");
    expect(usageWords(usage({ depth: "deep", finders: 2, reviewRound: false, critic: false, lines: 4_000 })).time).toBe("time not measured at this size: the smallest measured, commentanywhere, 11,719 lines, took 40 min");
    const unread = usageWords(usage({ depth: "deep", finders: 2, reviewRound: false, critic: false, lines: null }));
    expect([unread.tokens, unread.vendors, unread.time]).toEqual(["≈ 1,200 to 1,400 tokens a line of the project", null, "about 2.3 to 3.4 minutes per 1,000 lines"]);
  });

  it("says a depth or a review round no run has measured is not measured, and does not guess", () => {
    for (const depth of ["balanced", "cheap"]) {
      const words = usageWords(usage({ depth, finders: 2, reviewRound: false, critic: false, lines: 26_100 }));
      expect(words).toEqual({ tokens: "not measured yet", vendors: null, time: "the first run of it measures it", basis: null, short: null });
    }
    // One review round was measured on three earlier runs, with Gemini as the third finder and no split by vendor.
    const reviewed = usage({ depth: "deep", finders: 3, reviewRound: true, critic: false, lines: 12_000 });
    expect([reviewed.tokens, reviewed.vendors, reviewed.minutes]).toEqual([{ low: 10_800_000, high: 19_200_000 }, [], { low: 50, high: 125 }]);
  });
});

const deep = (lines: number | null, names?: readonly string[]) => usage({ depth: "deep", finders: 2, reviewRound: false, critic: false, lines, ...(names === undefined ? {} : { names }) });
const NOW = new Date("2026-11-01T12:00:00");
const CODEX_AT = (usedPercent: number): UsageWindows => ({ checkedAt: "2026-11-01T12:00:00.000Z", claude: { state: "not_read", reason: "" },
  codex: { state: "read", plan: "plus", fiveHour: { usedPercent, resetsAt: "2026-11-01T13:31:00" }, week: { usedPercent: 5, resetsAt: "2026-11-05T09:00:00" } } });

describe("what a run takes of a vendor's usage window, as measured on one plan", () => {
  it("records what each window held, with where it was measured", () => {
    expect(PLAN_WINDOWS.map(({ vendor, window, tokens, atLeast }) => [vendor, window, tokens, atLeast])).toEqual([["Codex", "five-hour", 10_600_000, false], ["Claude Code", "five-hour", 57_000_000, false], ["Claude Code", "weekly", 315_000_000, true]]);
    expect(windowSources()[0]).toBe("Codex's five-hour window, about 10.6M tokens on a ChatGPT plan: November 1, 2026, nananananana (84,380 lines, Opus and Sol at xhigh): Codex's five-hour window went from 0 to 100% for about 10.6M tokens, Sol's share of the whole run was 14.8M, and the run paused for 3 hours.");
  });

  it("says a run of the size of the one that paused is likely to pause on Codex's five-hour window, with the measured basis, and does not block", () => {
    const [codex, claude, ...rest] = pauseWords(deep(84_380));
    expect(codex).toBe("A run this size is likely to pause on Codex's five-hour window: about 120–145% of it, from 1.5–1.7% of a window per 1,000 lines on the measured runs. A window held about 10.6M tokens on a ChatGPT plan; on your plan it may hold more or less. A run that pauses carries on by itself after the reset.");
    // Claude's five-hour window held about 57M tokens on Max 20x; the week held at least 315M, so a run this size is nowhere near it.
    expect(claude).toContain("on Claude Code's five-hour window: about 150–185% of it");
    expect(rest).toEqual([]);
  });

  it("says nothing for a run that fits, one with no project read, a depth not measured, a review round, or an API route", () => {
    expect(pauseWords(deep(26_100))).toEqual([]);
    expect(pauseWords(deep(null))).toEqual([]);
    expect(pauseWords(usage({ depth: "balanced", finders: 2, reviewRound: false, critic: false, lines: 84_380 }))).toEqual([]);
    expect(pauseWords(usage({ depth: "deep", finders: 2, reviewRound: true, critic: false, lines: 84_380 }))).toEqual([]);
    expect(pauseWords(deep(84_380, ["Anthropic's API", "OpenAI's API"]))).toEqual([]);
  });

  it("says may pause where only the top of the range reaches the window, and names the weekly window of a project far larger", () => {
    expect(pauseWords(deep(65_000))[0]).toMatch(/^A run this size may pause on Codex's five-hour window: about 95–115% of it/u);
    // The week held at least 315M tokens, so a run over that is not certain to pause on it.
    const huge = pauseWords(deep(320_000));
    expect(huge.map((words) => /^A run this size (.*?) window:/u.exec(words)?.[1])).toEqual(["is likely to pause on Codex's five-hour", "is likely to pause on Claude Code's five-hour", "may pause on Claude Code's weekly"]);
    expect(huge[2]).toContain("up to 105–125% of it");
    expect(huge[2]).toContain("A window held at least 315M tokens on Claude Max 20x");
  });

  it("warns of a window already mostly used, from the meter as read now, and stays quiet when the room is enough or the meter was not read", () => {
    const small = deep(10_000);
    expect(pauseWords(small)).toEqual([]);
    expect(pauseWords(small, CODEX_AT(5), NOW)).toEqual([]);
    expect(pauseWords(small, CODEX_AT(90), NOW)).toEqual(["Codex's five-hour window is 90% used now, and a run this size takes about 10–20% of it (as measured on a ChatGPT plan), so it may pause before it ends; the window resets 13:31. A run that pauses carries on by itself after the reset."]);
    expect(pauseWords(small, { ...CODEX_AT(90), codex: { state: "not_read", reason: "Codex is not installed" } }, NOW)).toEqual([]);
  });
});

describe("a meter reading in words", () => {
  it("gives each window's use and reset, the week after a semicolon, and the plan Codex names", () => {
    expect(codexWords(CODEX_AT(31), NOW)).toBe("5-hour window 31% used, resets 13:31; week 5%, resets Thu 09:00 · plus plan");
  });

  it("gives nothing for a meter that was not read, and no reset for one that gave none", () => {
    expect(codexWords({ ...CODEX_AT(31), codex: { state: "not_read", reason: "Codex is not installed" } }, NOW)).toBeNull();
    expect(codexWords({ ...CODEX_AT(31), codex: { state: "read", plan: null, fiveHour: { usedPercent: 31.4, resetsAt: null }, week: null } }, NOW)).toBe("5-hour window 31% used");
    expect(resetWords("not a time", NOW)).toBeNull();
  });
});
