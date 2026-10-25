import { describe, expect, it } from "vitest";
import { usage, usageWords } from "../src/pages/new-run/usage.js";

describe("what a run will use, from measured runs", () => {
  it("estimates a deep audit at the measured 600 to 700 tokens a line, split by vendor as the runs split", () => {
    const rokbot = usage({ depth: "deep", finders: 2, reviewRound: false, critic: false, lines: 26_100 });
    expect(rokbot.tokens).toEqual({ low: 15_660_000, high: 18_270_000 });
    expect(rokbot.vendors.map(({ name, low, high }) => [name, low, high])).toEqual([["Claude Code", 13_624_200, 15_894_900], ["Codex", 2_035_800, 2_375_100]]);
    // Inside the sizes measured, a time range from the slowest and the fastest minute per line.
    expect(rokbot.minutes).toEqual({ low: 70, high: 90 });
    expect(usageWords(rokbot)).toEqual({ tokens: "≈ 15.7M–18.3M tokens", vendors: "Claude Code ≈ 13.6M–15.9M · Codex ≈ 2M–2.4M", time: "1 h 10 – 1 h 30, not counting a pause for a usage limit",
      basis: "basis: 3 runs at deep on October 23 and 24, 11,719 to 38,967 lines: 605 to 688 tokens a line, 40 min to 1 h 45. They reviewed the plan, which took 9 to 17% of their tokens; it is off here." });
    const three = usage({ depth: "deep", finders: 3, reviewRound: false, critic: true, lines: 38_967 });
    expect(three.vendors.map(({ name }) => name)).toEqual(["Claude Code", "Codex", "Antigravity"]);
    expect(usageWords(three).basis).toBe("basis: 3 runs at deep on October 23 and 24, 11,719 to 38,967 lines: 605 to 688 tokens a line, 40 min to 1 h 45. They reviewed the plan too.");
  });

  it("gives a time for a project within a tenth of the sizes measured, and none for one larger or smaller", () => {
    // nextra's checkout today reads 39,040 lines, 73 more than the run that measured it.
    expect(usage({ depth: "deep", finders: 3, reviewRound: false, critic: false, lines: 39_040 }).minutes).toEqual({ low: 105, high: 135 });
    expect(usage({ depth: "deep", finders: 2, reviewRound: false, critic: false, lines: 43_000 }).minutes).toBeNull();
    expect(usage({ depth: "deep", finders: 2, reviewRound: false, critic: false, lines: 10_600 }).minutes).toEqual({ low: 25, high: 40 });
  });

  it("gives no time for a project far larger or smaller than any measured, and the rate before the project is read", () => {
    const veritra = usage({ depth: "deep", finders: 2, reviewRound: false, critic: false, lines: 103_159 });
    expect([veritra.tokens, veritra.minutes]).toEqual([{ low: 61_895_400, high: 72_211_300 }, null]);
    expect(usageWords(veritra).time).toBe("time not measured at this size: the largest measured, nextra, 38,967 lines, took 1 h 45");
    expect(usageWords(usage({ depth: "deep", finders: 2, reviewRound: false, critic: false, lines: 4_000 })).time).toBe("time not measured at this size: the smallest measured, commentanywhere, 11,719 lines, took 40 min");
    const unread = usageWords(usage({ depth: "deep", finders: 2, reviewRound: false, critic: false, lines: null }));
    expect([unread.tokens, unread.vendors, unread.time]).toEqual(["≈ 600 to 700 tokens a line of the project", null, "about 2.7 to 3.4 minutes per 1,000 lines"]);
  });

  it("says a depth or a review round no run has measured is not measured, and does not guess", () => {
    for (const depth of ["balanced", "cheap"]) {
      const words = usageWords(usage({ depth, finders: 2, reviewRound: false, critic: false, lines: 26_100 }));
      expect(words).toEqual({ tokens: "not measured yet", vendors: null, time: "the first run of it measures it", basis: null });
    }
    // One review round was measured on three earlier runs, with Gemini as the third finder and no split by vendor.
    const reviewed = usage({ depth: "deep", finders: 3, reviewRound: true, critic: false, lines: 12_000 });
    expect([reviewed.tokens, reviewed.vendors, reviewed.minutes]).toEqual([{ low: 10_800_000, high: 19_200_000 }, [], { low: 50, high: 125 }]);
  });
});
