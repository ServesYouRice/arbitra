// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/app/App.js";
import { formatTime } from "../../src/app/format.js";
import { stubBrowser, stubControlPlane, visit } from "../support.js";
import { artifactRoutes, finishedProgress, MODEL_CONFIGURATION, modelOverview, resource } from "./fixtures.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); visit(""); });

function eventStream(): { readonly emit: (event: unknown) => void } {
  const sources: { onmessage: ((message: { data: string }) => void) | null }[] = [];
  class Source { onmessage: ((message: { data: string }) => void) | null = null; onerror: unknown = null; constructor(readonly url: string) { sources.push(this); } addEventListener(): void {} close(): void {} }
  vi.stubGlobal("EventSource", Source);
  return { emit: (event) => { act(() => { sources.at(-1)?.onmessage?.({ data: JSON.stringify(event) }); }); } };
}

/** Opus through an API key with Claude Code as its fallback and a $150 cap, beside GPT through Codex. */
const CONFIGURATION = {
  ...MODEL_CONFIGURATION,
  models: { ...MODEL_CONFIGURATION["models"] as object,
    "auditor-a": { provider: "anthropic", modelId: "claude-opus-5-5", family: "anthropic", transport: "anthropic-messages", capabilityTier: "frontier", independenceGroup: "anthropic" },
    "fallback-auditor-a": { provider: "anthropic", modelId: "claude-opus-5-5", family: "anthropic", transport: "claude-code-cli", capabilityTier: "frontier", independenceGroup: "anthropic" } },
  workflow: { modelExecution: { ...(MODEL_CONFIGURATION["workflow"] as { modelExecution: object }).modelExecution, fallbacks: { "auditor-a": "fallback-auditor-a" }, maximumCostUsd: { "auditor-a": 150 } } },
};
const ROUTES = { schemaVersion: 1, pricesAsOf: "2026-11-11", spentUsd: { "auditor-a": 182.4 }, unpricedCalls: {}, out: {}, switches: [] };

// Observed live (memoria, November 10–11, 2026): the API credit ran out before the plan, and nothing on the run page said
// so; the switch to the subscription was made by hand.
describe("a run whose model switched route", () => {
  it("says each switch in a line, and what the API keys cost in the run's facts", async () => {
    stubBrowser(); const stream = eventStream();
    stubControlPlane({ "GET /runs/run-1": resource(), "GET /runs/run-1/overview": modelOverview({ configuration: CONFIGURATION }), "GET /runs/run-1/progress": finishedProgress(),
      ...artifactRoutes("run-1", { "model-routes": ROUTES }) });
    visit("?run=run-1");
    render(<App />);
    await waitFor(() => { expect(screen.getByText(/^\$182 · \$182 Opus 5\.5 \(auditor-a\) · priced as of 2026-11-11$/u)).toBeTruthy(); });
    stream.emit({ t: "model_route_switched", runId: "run-1", from: "auditor-a", to: "fallback-auditor-a", reason: "credit_out", spentUsd: 182.4, effort: "xhigh", at: "2026-11-11T08:14:00.000Z" });
    const switches = await screen.findByRole("list", { name: "model switches" });
    expect(within(switches).getByText(`Switched Opus 5.5 · xhigh from API key to Claude Code at ${formatTime("2026-11-11T08:14:00.000Z")}, credit out ($182 spent).`)).toBeTruthy();
  });

  it("says each optional step that did not wait for a model out of its allowance, beside the switches", async () => {
    // Observed live (November 11, 2026): one second opinion waited 3 h 04 on Codex's five-hour window.
    stubBrowser(); const stream = eventStream();
    stubControlPlane({ "GET /runs/run-1": resource(), "GET /runs/run-1/overview": modelOverview({ configuration: CONFIGURATION }), "GET /runs/run-1/progress": finishedProgress(),
      ...artifactRoutes("run-1", { "model-routes": ROUTES }) });
    visit("?run=run-1");
    render(<App />);
    await waitFor(() => { expect(screen.getByText(/^\$182 · /u)).toBeTruthy(); });
    const at = "2026-11-11T09:13:00.000Z"; const resetsAt = "2026-11-11T12:17:00.000Z";
    stream.emit({ t: "optional_step_limited", runId: "run-1", step: "secondOpinion", from: "auditor-b", to: "auditor-a", resetsAt, at });
    stream.emit({ t: "optional_step_limited", runId: "run-1", step: "critic", from: "auditor-b", to: null, resetsAt, at });
    const lines = await screen.findByRole("list", { name: "model switches" });
    const when = `at ${formatTime(at)}: usage limit reached, until ${formatTime(resetsAt)}.`;
    expect(within(lines).getByText(`The second opinion went from GPT-6.1 Sol to Opus 5.5 ${when}`)).toBeTruthy();
    expect(within(lines).getByText(`The plan review on GPT-6.1 Sol was left out ${when} The plan went on unreviewed.`)).toBeTruthy();
  });

  it("says a pause at the dollar cap as the cap, with what to do next", async () => {
    stubBrowser(); eventStream();
    const reason = "ProviderBudgetSuspendedError: MODEL_COST_CAP_REACHED:auditor-a: auditor-a has spent $150.20 of its $150.00 cap and has no fallback. The run pauses with its work kept; resume it with a higher cap, or start it again with a fallback.";
    stubControlPlane({ "GET /runs/run-1": resource({ state: "SUSPENDED_BUDGET", resumable: true }), "GET /runs/run-1/overview": modelOverview({ state: "SUSPENDED_BUDGET", reason, configuration: CONFIGURATION }),
      "GET /runs/run-1/progress": finishedProgress({ state: "SUSPENDED_BUDGET" }), ...artifactRoutes("run-1", { "model-routes": ROUTES }) });
    visit("?run=run-1");
    render(<App />);
    expect(await screen.findByText("Paused at its dollar cap")).toBeTruthy();
    expect(screen.getByText("auditor-a reached its dollar cap: $150.20 of $150.00, with no fallback to go on with.")).toBeTruthy();
    expect(screen.getByText(/^Resume the run with a higher cap to go on through the API, or start it again with a fallback\./u)).toBeTruthy();
  });
});
