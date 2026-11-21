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

  it("records an optional step that went to another model, or on without one, when its model's allowance was out", () => {
    // Observed live (a real-project audit, November 11, 2026): one second opinion waited 3 h 04 on Codex's window.
    const limited = { t: "optional_step_limited", runId: "run-1", step: "secondOpinion", from: "auditor-b", to: "auditor-c", resetsAt: "2026-11-11T12:17:00.000Z", at: "2026-11-11T09:22:32.000Z" };
    expect(isRunEvent(limited)).toBe(true);
    expect(isRunEvent({ ...limited, to: null, resetsAt: undefined })).toBe(true);
    expect(isRunEvent({ ...limited, step: "finder", to: null })).toBe(true);
    expect(isRunEvent({ ...limited, step: "planner" })).toBe(false);
    expect(isRunEvent({ ...limited, from: "" })).toBe(false);
    expect(isRunEvent({ ...limited, to: "" })).toBe(false);
    expect(isRunEvent({ ...limited, resetsAt: "soon" })).toBe(false);
  });

  it("records a profile's calls waiting in place for its usage limit to reset, and how their wait ended", () => {
    // Observed live (a real-project audit, November 21, 2026): Sol sat idle two hours on a limit that reset in seven minutes.
    const waiting = { t: "model_waiting", runId: "run-1", profile: "auditor-b", resetsAt: "2026-11-21T11:27:00.000Z", until: "2026-11-21T11:28:00.000Z", detail: "CLI_USAGE_LIMIT_REACHED", at: "2026-11-21T11:20:00.000Z" };
    expect(isRunEvent(waiting)).toBe(true);
    expect(isRunEvent({ ...waiting, detail: undefined })).toBe(true);
    expect(isRunEvent({ ...waiting, profile: "" })).toBe(false);
    expect(isRunEvent({ ...waiting, until: undefined })).toBe(false);
    expect(isRunEvent({ ...waiting, resetsAt: "soon" })).toBe(false);
    expect(isRunEvent({ ...waiting, detail: 7 })).toBe(false);
    const ended = { t: "model_wait_ended", runId: "run-1", profile: "auditor-b", outcome: "went_on", at: "2026-11-21T11:28:00.000Z" };
    for (const outcome of ["went_on", "cancelled", "left_out"]) expect(isRunEvent({ ...ended, outcome })).toBe(true);
    expect(isRunEvent({ ...ended, outcome: "gave_up" })).toBe(false);
    expect(isRunEvent({ ...ended, profile: undefined })).toBe(false);
  });
});
