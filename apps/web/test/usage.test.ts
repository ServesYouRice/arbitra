import { describe, expect, it } from "vitest";
import { usage, usageWords } from "../src/pages/new-run/usage.js";

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
