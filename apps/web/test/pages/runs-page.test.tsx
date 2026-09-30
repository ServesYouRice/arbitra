// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/app/App.js";
import { address, json, stubBrowser, stubControlPlane, visit } from "../support.js";
import { artifactRoutes, listItem, overview, resource } from "./fixtures.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); visit(""); });

describe("the run list", () => {
  it("lists every run with its state in words and code, what ran it, and what it concluded", async () => {
    stubBrowser();
    stubControlPlane({
      "GET /repositories/selected": { repository: "/work/fixture" },
      "GET /runs": [
        listItem({ runId: "run-aaaaaaaa-1", state: "BLOCKED", mode: "feature", workflowId: "feature-simple", executor: "models", gate: null, pendingDecisions: 2 }),
        listItem({ runId: "run-bbbbbbbb-2", state: "FAILED", reason: "PROVIDER_TIMEOUT", gate: null }),
        listItem({ runId: "run-cccccccc-3", state: "COMPLETED", gate: { status: "passed", reasons: [] }, executor: "models", replayOf: "run-dddddddd-4" }),
        listItem({ runId: "run-eeeeeeee-5" }),
        listItem({ runId: "run-ffffffff-6", state: null, mode: null, workflowId: null, repository: null, executor: null, gate: null, problem: "RUN_CONTEXT_ABSENT:run-ffffffff-6" }),
      ],
    });
    render(<App />);
    const table = await screen.findByRole("table", { name: "runs" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell")[0]?.textContent)).toEqual(["aaaaaaaa", "bbbbbbbb", "cccccccc", "eeeeeeee", "ffffffff"]);
    expect(rows[0]?.textContent).toContain("waiting for your decision BLOCKED");
    expect(rows[0]?.textContent).toContain("needs you · 2 decisions");
    expect(rows[1]?.textContent).toContain("failed · PROVIDER_TIMEOUT");
    expect(rows[2]?.textContent).toContain("gate passed");
    expect(rows[2]?.textContent).toContain("replay of dddddddd");
    expect(rows[3]?.textContent).toContain("gate failed · some issues are still unresolved · coverage is incomplete");
    expect(rows[3]?.textContent).toContain("scripted detectors, no model calls");
    expect(rows[4]?.textContent).toContain("records unreadable · RUN_CONTEXT_ABSENT:run-ffffffff-6");
    expect(screen.getByRole("status").textContent).toBe("1 run is waiting for your decision.");
    expect(screen.getByText("/work/fixture")).toBeTruthy();
  });

  it("opens a run from its row and comes back through the main navigation", async () => {
    stubBrowser();
    stubControlPlane({ "GET /repositories/selected": { repository: "/work/fixture" }, "GET /runs": [listItem()], "GET /runs/run-1": resource(), "GET /runs/run-1/overview": overview(), ...artifactRoutes("run-1") });
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "open run run-1" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Audit run · audit-deep" })).toBeTruthy();
    expect(address().get("run")).toBe("run-1");
    fireEvent.click(screen.getByRole("link", { name: "Runs" }));
    expect(await screen.findByRole("table", { name: "runs" })).toBeTruthy();
    expect(window.location.search).toBe("");
  });

  it("marks a running run this control plane is not executing, and keeps the list when a refresh fails", async () => {
    stubBrowser();
    let fail = false;
    stubControlPlane({ "GET /repositories/selected": { repository: "/work/fixture" }, "GET /runs": () => fail ? json({ statusCode: 500, error: "REQUEST_FAILED", message: "EMFILE" }, 500) : [listItem({ state: "VERIFYING", gate: null, live: false })] });
    render(<App />);
    expect(await screen.findByText("not executed by this control plane · running elsewhere or interrupted")).toBeTruthy();
    fail = true;
    fireEvent.click(screen.getByRole("button", { name: "refresh" }));
    expect((await screen.findByRole("alert")).textContent).toContain("EMFILE");
    expect(screen.getByRole("table", { name: "runs" })).toBeTruthy();
  });

  it("explains what a run is when there are none, and how to start one", async () => {
    stubBrowser();
    stubControlPlane({ "GET /repositories/selected": { repository: "/work/fixture" }, "GET /runs": [] });
    render(<App />);
    expect(await screen.findByText("no runs yet")).toBeTruthy();
    expect(screen.getByText(/The repository itself is never modified/u)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Start a run" }).getAttribute("href")).toBe("/?page=new-run");
  });

  it("says how to start the control plane when it does not answer", async () => {
    stubBrowser();
    stubControlPlane({ "GET /runs": () => json({ statusCode: 500, error: "REQUEST_FAILED", message: "ECONNREFUSED" }, 500) });
    render(<App />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The control plane did not answer · ECONNREFUSED (RUN_API_500)");
    expect(alert.textContent).toContain("node apps/server/dist/src/serve.js");
  });

  it("keeps a running run's row current without a manual refresh", async () => {
    stubBrowser();
    let state = "DISCOVERY_RUNNING";
    stubControlPlane({ "GET /repositories/selected": { repository: "/work/fixture" }, "GET /runs": () => [listItem({ state, gate: null, live: true })] });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<App />);
      expect(await screen.findByText("running · discovery")).toBeTruthy();
      state = "COMPLETED";
      await vi.advanceTimersByTimeAsync(4_500);
      await waitFor(() => expect(screen.getByText("finished")).toBeTruthy());
    } finally { vi.useRealTimers(); }
  });
});
