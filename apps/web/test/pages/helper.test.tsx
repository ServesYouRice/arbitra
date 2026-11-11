// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/app/App.js";
import { formatTime } from "../../src/app/format.js";
import { helperWaiting, helperWords } from "../../src/app/words.js";
import { stubBrowser, stubControlPlane, visit } from "../support.js";
import { artifactRoutes, overview, resource } from "./fixtures.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); visit(""); });

/** The run's event stream, which the test feeds. */
function eventStream(): { readonly emit: (event: unknown) => void } {
  const sources: { onmessage: ((message: { data: string }) => void) | null }[] = [];
  class Source { onmessage: ((message: { data: string }) => void) | null = null; onerror: unknown = null; constructor(readonly url: string) { sources.push(this); } addEventListener(): void {} close(): void {} }
  vi.stubGlobal("EventSource", Source);
  return { emit: (event) => { act(() => { sources.at(-1)?.onmessage?.({ data: JSON.stringify(event) }); }); } };
}

const USAGE = "ProviderUsageLimitError: Provider openai reached its usage limit (QUOTA: CLI_USAGE_LIMIT_REACHED: the Codex CLI subscription's usage allowance is exhausted until 2026-11-11T14:01:00.000Z)";
const TIMEOUT = "ProviderInvocationFailure: Provider openai failed after 3 attempts (TIMEOUT: Provider stage timed out after 900000ms)";
const wait = { t: "helper_action", runId: "run-1", action: "wait", reason: USAGE, kind: "resume-now", result: "The helper resumes the run a minute after the limit resets.", until: "2026-11-11T14:02:00.000Z", at: "2026-11-11T11:00:00.000Z" };

describe("what the run helper did, on the run page", () => {
  it("says the helper waits to resume a run paused for usage, and when", async () => {
    stubBrowser(); const stream = eventStream();
    stubControlPlane({ "GET /runs/run-1": resource({ state: "SUSPENDED_RATE_LIMIT", resumable: true }), "GET /runs/run-1/overview": overview({ state: "SUSPENDED_RATE_LIMIT", reason: USAGE, gate: null }), ...artifactRoutes("run-1", {}) });
    visit("?run=run-1");
    render(<App />);
    const paused = await screen.findByRole("region", { name: "Paused for usage" });
    expect(within(paused).getByText(/; resume it from the header then\.$/u)).toBeTruthy();
    stream.emit({ t: "run_transition", runId: "run-1", state: "SUSPENDED_RATE_LIMIT", reason: USAGE });
    stream.emit(wait);
    await waitFor(() => { expect(screen.getByText(`The helper waits until ${formatTime("2026-11-11T14:02:00.000Z")}. The helper resumes the run a minute after the limit resets.`)).toBeTruthy(); });
    expect(within(screen.getByRole("region", { name: "Paused for usage" })).getByText(new RegExp(`The limit resets at ${formatTime("2026-11-11T14:01:00.000Z")}\\.$`, "u"))).toBeTruthy();
  });

  it("names each resume the helper made, with its time and the reason in the page's words", () => {
    const events = [{ t: "run_transition", state: "SUSPENDED_RATE_LIMIT" }, wait, { ...wait, action: "resume", result: "The helper resumed the run.", at: "2026-11-11T14:02:00.000Z" },
      { t: "run_transition", state: "CREATED" }, { t: "run_transition", state: "FAILED" }, { ...wait, action: "leave", reason: TIMEOUT, result: "The helper has resumed this run 2 times already, so it waits for you.", at: "2026-11-11T15:00:00.000Z" }];
    expect(helperWords(events, true)).toEqual([`Resumed by the helper at ${formatTime("2026-11-11T14:02:00.000Z")}, because a model's usage limit was reached.`,
      "The helper did not resume it: the helper has resumed this run 2 times already, so it waits for you."]);
    // While the run works, and once it has finished, only the resumes are told.
    expect(helperWords(events.slice(0, 4), false)).toHaveLength(1);
    // A stop the helper leaves because a resume cannot help says nothing more than the page's own words.
    expect(helperWords([{ ...wait, action: "leave", kind: "fix-computer" }], true)).toEqual([]);
    expect([helperWaiting([wait]), helperWaiting(events)]).toEqual([true, false]);
  });
});
