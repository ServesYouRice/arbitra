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

  it("records what the run helper did about a stop, and the time it waits for", () => {
    const action = { t: "helper_action", runId: "run-1", action: "wait", reason: "ProviderUsageLimitError: …", kind: "resume-now", result: "waits for the reset", until: "2026-11-11T14:02:00.000Z" };
    expect(isRunEvent(action)).toBe(true);
    expect(isRunEvent({ ...action, until: undefined })).toBe(true);
    expect(isRunEvent({ ...action, until: "soon" })).toBe(false);
    expect(isRunEvent({ ...action, action: "" })).toBe(false);
    expect(isRunEvent({ ...action, result: undefined })).toBe(false);
  });
});
