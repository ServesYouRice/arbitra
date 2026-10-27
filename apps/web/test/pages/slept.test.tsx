// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/app/App.js";
import { formatTime } from "../../src/app/format.js";
import { failureWords, sleptSpans, sleptWords } from "../../src/app/words.js";
import { ThisComputer } from "../../src/pages/new-run/ThisComputer.js";
import { stubBrowser, stubControlPlane, visit } from "../support.js";
import { artifactRoutes, finishedProgress, overview, resource } from "./fixtures.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); visit(""); });

/** The run's event stream, which the test feeds. */
function eventStream(): { readonly emit: (event: unknown) => void } {
  const sources: { onmessage: ((message: { data: string }) => void) | null }[] = [];
  class Source { onmessage: ((message: { data: string }) => void) | null = null; onerror: unknown = null; constructor(readonly url: string) { sources.push(this); } addEventListener(): void {} close(): void {} }
  vi.stubGlobal("EventSource", Source);
  return { emit: (event) => { act(() => { sources.at(-1)?.onmessage?.({ data: JSON.stringify(event) }); }); } };
}

// Observed live (October 26, 2026, macOS, pmset): a run failed in the Mac's dark wakes as "Provider openai failed after
// 3 attempts (TIMEOUT …)", nothing in the run said the Mac had slept, and finding it took `pmset -g log`.
const REASON = "HostSuspendedError: The computer slept from 2026-10-26T15:26:02.000Z to 2026-10-26T18:55:06.000Z while a call to openai was in flight, and the call could not finish across it (TIMEOUT: Provider stage timed out after 900000ms; stream: no event in the 15.0 min it ran). The sleep stopped it, not openai: keep the computer awake while the run works, then resume it; completed artifacts are preserved.";

describe("a run the computer slept through", () => {
  it("names the sleep, not the provider, in a failed run's words and next step, and says when the computer slept", async () => {
    stubBrowser(); const stream = eventStream();
    stubControlPlane({ "GET /runs/run-1": resource({ state: "FAILED", resumable: true }), "GET /runs/run-1/overview": overview({ state: "FAILED", reason: REASON, gate: null }),
      "GET /runs/run-1/progress": finishedProgress({ state: "FAILED" }), ...artifactRoutes("run-1", {}) });
    visit("?run=run-1");
    render(<App />);
    const failed = await screen.findByRole("region", { name: "The run failed" });
    expect(within(failed).getByText(`The computer slept from ${formatTime("2026-10-26T15:26:02.000Z")} to ${formatTime("2026-10-26T18:55:06.000Z")} while the run's model calls were in flight, and they could not finish across it.`)).toBeTruthy();
    expect(within(failed).getByText(/^Keep the computer awake while the run works \(on a Mac, with its lid open\), then resume the run/u)).toBeTruthy();
    expect(within(failed).queryByText(/Provider openai failed/u)).toBeNull();
    // Two suspends a dark wake apart are one sleep.
    stream.emit({ t: "host_suspended", runId: "run-1", from: "2026-10-26T15:26:02.000Z", to: "2026-10-26T15:41:10.000Z" });
    stream.emit({ t: "host_suspended", runId: "run-1", from: "2026-10-26T15:41:40.000Z", to: "2026-10-26T18:55:06.000Z" });
    await waitFor(() => { expect(screen.getByText(`The computer slept from ${formatTime("2026-10-26T15:26:02.000Z")} to ${formatTime("2026-10-26T18:55:06.000Z")}; calls in flight were sent again.`)).toBeTruthy(); });
  });

  it("reads the sleeps from the run's events as the run report does", () => {
    expect(sleptSpans([{ t: "node_completed" }, { t: "host_suspended", from: "2026-10-26T13:00:00.000Z", to: "2026-10-26T13:30:00.000Z" },
      { t: "host_suspended", from: "2026-10-26T10:37:05.000Z", to: "2026-10-26T10:52:10.000Z" }, { t: "host_suspended", from: "2026-10-26T10:52:50.000Z", to: "2026-10-26T11:56:00.000Z" }]))
      .toEqual([{ from: "2026-10-26T10:37:05.000Z", to: "2026-10-26T11:56:00.000Z" }, { from: "2026-10-26T13:00:00.000Z", to: "2026-10-26T13:30:00.000Z" }]);
    expect(sleptWords([])).toBeNull();
    expect(failureWords(REASON)).toMatchObject({ resumable: true });
    // A timeout the runtime found no sleep across is still a timeout.
    expect(failureWords("ProviderInvocationFailure: Provider openai failed after 3 attempts (TIMEOUT: Provider stage timed out after 900000ms)").what).toBe("A model call kept running past its time limit.");
  });

  it("says on This computer whether a run keeps it awake, and why not", () => {
    const environment = (keepAwake: unknown) => ({ build: "test", clis: [], apiKeys: {}, keepAwake } as never);
    render(<ThisComputer environment={environment({ state: "ready", tool: "caffeinate -i", detail: "kept awake while a run works (caffeinate -i); a Mac still sleeps when its lid is closed" })} failure={null} transports={new Set()} keyVariables={[]} subscription />);
    const row = screen.getByRole("rowheader", { name: "Sleep" }).closest("tr") as HTMLElement;
    expect(within(row).getByText("kept awake while a run works (caffeinate -i); a Mac still sleeps when its lid is closed").getAttribute("data-state")).toBe("verified");
    cleanup();
    render(<ThisComputer environment={environment({ state: "unavailable", tool: null, detail: "systemd-inhibit was not found, so arbitra cannot keep this computer from sleeping during a run; keep it awake yourself while a run works" })} failure={null} transports={new Set()} keyVariables={[]} subscription />);
    expect(screen.getByText(/^systemd-inhibit was not found/u).getAttribute("data-state")).toBe("degraded");
    cleanup();
    render(<ThisComputer environment={environment(null)} failure={null} transports={new Set()} keyVariables={[]} subscription />);
    expect(screen.queryByRole("rowheader", { name: "Sleep" })).toBeNull();
  });
});
