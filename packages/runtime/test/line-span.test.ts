import { describe, expect, it } from "vitest";
import { lineSpan, placeSpan } from "../src/line-span.js";

describe("lines as a person reads them", () => {
  it("says line for one line and lines for a range or several", () => {
    // Observed live (November 11, 2026): a plan's note on its one instruction-shaped line said "lines 20".
    expect(lineSpan([{ startLine: 20, endLine: 20 }])).toBe("line 20");
    expect(lineSpan([{ startLine: 20, endLine: 24 }])).toBe("lines 20–24");
    expect(lineSpan([{ startLine: 3, endLine: 3 }, { startLine: 20, endLine: 24 }])).toBe("lines 3, 20–24");
    expect(lineSpan([])).toBe("");
  });

  it("writes a place with its line, or its range of lines", () => {
    expect(placeSpan("src/a.ts", { startLine: 40, endLine: 40 })).toBe("src/a.ts:40");
    expect(placeSpan("src/a.ts", { startLine: 40, endLine: 52 })).toBe("src/a.ts:40–52");
  });
});
