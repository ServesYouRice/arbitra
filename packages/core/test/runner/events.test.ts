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

  it("records a profile's switch to its fallback, or a pause with none, with why and the dollars it had spent", () => {
    const switched = { t: "model_route_switched", runId: "run-1", from: "opus-api", to: "opus-cc", reason: "credit_out", spentUsd: 182.4, effort: "xhigh", at: "2026-11-11T08:14:00.000Z" };
    expect(isRunEvent(switched)).toBe(true);
    expect(isRunEvent({ ...switched, to: null, reason: "cost_cap" })).toBe(true);
    expect(isRunEvent({ ...switched, from: "opus-cc", to: "opus-api", reason: "usage_limit", spentUsd: null, resetsAt: "2026-11-14T09:00:00.000Z" })).toBe(true);
    expect(isRunEvent({ ...switched, reason: "bored" })).toBe(false);
    expect(isRunEvent({ ...switched, spentUsd: -1 })).toBe(false);
    expect(isRunEvent({ ...switched, to: "" })).toBe(false);
    expect(isRunEvent({ ...switched, resetsAt: "soon" })).toBe(false);
  });
});
