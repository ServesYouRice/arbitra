import { describe, expect, it } from "vitest";
import { isRunEvent } from "../../src/runner/events.js";

describe("run events", () => {
  it("records a sleep of the computer during a run, with its two times", () => {
    // Observed live (October 26, 2026, macOS): nothing in a run's record said the Mac had slept.
    expect(isRunEvent({ t: "host_suspended", runId: "run-1", from: "2026-10-26T10:37:05.000Z", to: "2026-10-26T11:52:10.000Z", at: "2026-10-26T11:52:10.000Z" })).toBe(true);
    expect(isRunEvent({ t: "host_suspended", runId: "run-1", from: "2026-10-26T10:37:05.000Z" })).toBe(false);
    expect(isRunEvent({ t: "host_suspended", runId: "run-1", from: "yesterday", to: "2026-10-26T11:52:10.000Z" })).toBe(false);
    expect(isRunEvent({ t: "host_slept", runId: "run-1", from: "2026-10-26T10:37:05.000Z", to: "2026-10-26T11:52:10.000Z" })).toBe(false);
  });
});
