// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/app/App.js";
import { ISSUES_NEW, issueLink } from "../../src/pages/run/SendReport.js";
import { stubBrowser, stubControlPlane, visit } from "../support.js";
import { artifactRoutes, finishedProgress, metrics, overview, resource } from "./fixtures.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); visit(""); localStorage.clear(); });

const REPORT = "arbitra run report · 2026-10-25T20:49:41.064Z\nbuild 0.3.1, single-file app\nmachine win32 x64 · node v22.23.2\n\nrun run-1\n  mode audit · state COMPLETED";
const reportRoute = { "GET /diagnostics/runs/run-1": () => new Response(REPORT, { status: 200, headers: { "content-type": "text/plain" } }) };

/** The new tab a click opens: `window.open` is not in jsdom. */
function stubTabs(): { readonly open: ReturnType<typeof vi.fn>; readonly tab: { opener: unknown; location: { href: string }; close: ReturnType<typeof vi.fn> } } {
  const tab = { opener: {} as unknown, location: { href: "" }, close: vi.fn() };
  const open = vi.fn(() => tab);
  vi.stubGlobal("open", open);
  return { open, tab };
}

const issueText = (url: string): { readonly title: string | null; readonly body: string | null } => {
  const query = new URL(url).searchParams;
  return { title: query.get("title"), body: query.get("body") };
};

describe("the report to send the developer", () => {
  it("is a GitHub issue whose title names the occasion and build, cut at a line to fit a link when it is long", () => {
    const short = issueLink(REPORT, "the run failed");
    expect(short.cut).toBe(false);
    expect(short.url.startsWith(`${ISSUES_NEW}?`)).toBe(true);
    expect(issueText(short.url).title).toBe("Run report: the run failed (0.3.1, single-file app)");
    expect(issueText(short.url).body).toContain(`\`\`\`text\n${REPORT}\n\`\`\``);
    const long = `${REPORT}\n${Array.from({ length: 300 }, (_, index) => `  failed call ${index} · ProviderInvocationFailure: timed out after 900000ms`).join("\n")}`;
    const cut = issueLink(long, "the run failed");
    expect(cut.cut).toBe(true);
    expect(cut.url.length).toBeLessThanOrEqual(7_500);
    const body = issueText(cut.url).body ?? "";
    expect(body).toContain(REPORT);
    expect(body.endsWith("The whole report was copied: paste it below.")).toBe(true);
  });

  it("shows its text and where it goes the first time, then opens the filled-in issue, and at once after that", async () => {
    stubBrowser();
    const { open, tab } = stubTabs();
    stubControlPlane({ "GET /runs/run-1": resource(), "GET /runs/run-1/overview": overview(), "GET /runs/run-1/metrics": metrics(), "GET /handoff/runs/run-1": { saved: [] }, ...artifactRoutes("run-1"), ...reportRoute });
    visit("?run=run-1");
    render(<App />);
    const ran = await screen.findByRole("region", { name: "How it ran" });
    fireEvent.click(within(ran).getByRole("button", { name: "Send to the developer" }));
    const preview = await within(ran).findByRole("group", { name: "the report to send" });
    expect(within(preview).getByText(/Issues there are public/u)).toBeTruthy();
    expect((within(preview).getByRole("textbox", { name: "report text" }) as HTMLTextAreaElement).value).toBe(REPORT);
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(within(preview).getByRole("button", { name: "Open the issue on GitHub" }));
    await waitFor(() => expect(tab.location.href.startsWith(ISSUES_NEW)).toBe(true));
    expect(tab.opener).toBeNull();
    expect(issueText(tab.location.href).title).toBe("Run report: the run finished (0.3.1, single-file app)");
    expect(within(ran).queryByRole("group", { name: "the report to send" })).toBeNull();
    // Agreed once, the button opens the issue straight away.
    tab.location.href = "";
    fireEvent.click(within(ran).getByRole("button", { name: "Send to the developer" }));
    await waitFor(() => expect(tab.location.href.startsWith(ISSUES_NEW)).toBe(true));
    expect(within(ran).queryByRole("group", { name: "the report to send" })).toBeNull();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("goes with the saved plan when the person ticked the box under Save and agreed to its text", async () => {
    stubBrowser();
    const { open, tab } = stubTabs();
    const saved: { directory: string; relative: string; savedAt: string }[] = [];
    stubControlPlane({ "GET /runs/run-1": resource(), "GET /runs/run-1/overview": overview(), "GET /runs/run-1/metrics": metrics(), ...artifactRoutes("run-1"), ...reportRoute,
      "GET /handoff/runs/run-1": () => ({ saved }),
      "POST /handoff/runs/run-1": () => { saved.push({ directory: "/work/fixture/.arbitra/plans/2026-10-25-run1", relative: ".arbitra/plans/2026-10-25-run1", savedAt: "2026-10-25T09:30:00.000Z" }); return { directory: saved[0]?.directory, files: ["README.md"] }; } });
    visit("?run=run-1");
    render(<App />);
    const plan = await screen.findByRole("region", { name: "The plan is ready · 1 task for 1 issue" });
    const box = within(plan).getByRole("checkbox", { name: "Also send the run's report to the developer when I save" }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    const preview = await within(plan).findByRole("group", { name: "the report to send" });
    expect(box.checked).toBe(false);
    fireEvent.click(within(preview).getByRole("button", { name: "Send it when I save" }));
    expect(box.checked).toBe(true);
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(within(plan).getByRole("button", { name: "Save the plan into the project" }));
    // The tab opens at the click, so no pop-up blocker stops it, and gets the issue once the plan is saved.
    expect(open).toHaveBeenCalledWith("", "_blank");
    expect(await within(plan).findByText("Saved in the project")).toBeTruthy();
    await waitFor(() => expect(issueText(tab.location.href).title).toBe("Run report: the plan was saved (0.3.1, single-file app)"));
  });

  it("is offered on a failed run beside what failed", async () => {
    stubBrowser();
    stubControlPlane({ "GET /runs/run-1": resource({ state: "FAILED", resumable: true }), "GET /runs/run-1/overview": overview({ state: "FAILED", reason: "MODEL_OUTPUT_INVALID", gate: null }), "GET /runs/run-1/progress": finishedProgress({ state: "FAILED" }), ...artifactRoutes("run-1", {}) });
    visit("?run=run-1");
    render(<App />);
    const failed = await screen.findByRole("region", { name: "The run failed" });
    expect(within(failed).getByRole("button", { name: "Send to the developer" })).toBeTruthy();
    expect(within(failed).getByRole("button", { name: "Copy a report to send" })).toBeTruthy();
  });
});
