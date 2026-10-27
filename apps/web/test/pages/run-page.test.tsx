// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HumanCheckpointResource, PlanQuestionsCheckpointResource } from "../../src/api/runs.js";
import { App } from "../../src/app/App.js";
import { ARTIFACT_CONTENT } from "../views/fixtures.js";
import { address, json, stubBrowser, stubControlPlane, visit } from "../support.js";
import { artifactRoutes, BALANCED_WORKFLOW, discoveryProgress, EMPTY_TRACES, FEATURE_WORKFLOW, finishedProgress, metrics, MODEL_CONFIGURATION, modelOverview, overview, resource } from "./fixtures.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); visit(""); });

/** The recorded fact beside a label in a list of facts. */
const fact = (region: HTMLElement, label: string): string | null | undefined => within(region).getByText(label, { selector: "dt" }).nextElementSibling?.textContent;
const main = (): HTMLElement => document.querySelector("main") as HTMLElement;

describe("the run page", () => {
  it("opens a finished audit on its Summary: the plan to save first, what needs the person, the issues by verdict, how it ran, and no recorded code", async () => {
    stubBrowser();
    stubControlPlane({ "GET /runs/run-1": resource(), "GET /runs/run-1/overview": overview(), "GET /runs/run-1/metrics": metrics(), "GET /handoff/runs/run-1": { saved: [] }, ...artifactRoutes("run-1") });
    visit("?run=run-1");
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "fixture · audit" })).toBeTruthy();
    expect(document.querySelector(".run-header .chip")?.textContent).toBe("done");
    const tabs = screen.getByRole("navigation", { name: "run views" });
    expect(within(tabs).getAllByRole("link").map((link) => link.textContent)).toEqual(["Summary", "Issues", "Plan", "Results", "How it ran"]);
    expect(within(tabs).getByRole("link", { name: "Summary" }).getAttribute("aria-current")).toBe("page");
    const plan = await screen.findByRole("region", { name: "The plan is ready · 1 task for 1 issue" });
    // The plan comes first on the page, and saving it is the page's one primary action.
    expect(main().querySelector(".summary > *")?.getAttribute("aria-labelledby")).toBe("plan-card-title");
    expect(within(plan).getByRole("button", { name: "Save the plan into the project" }).className).toContain("button--primary");
    expect(document.querySelectorAll("main .button--primary")).toHaveLength(1);
    expect(await within(plan).findByText("Not saved yet. Nothing in the project changes until you save.")).toBeTruthy();
    expect(within(plan).getByRole("link", { name: "Read it first" }).getAttribute("href")).toBe("/?run=run-1&view=plan");
    const needs = screen.getByRole("region", { name: "Needs you" });
    expect(within(needs).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["1 question only you can answer, before the tasksAnswer →", "/?run=run-1&view=plan"],
      // The saved plan checks them after its tasks (plan-export.ts): most such reports do not hold.
      ["20 issues the check could not settle: the plan checks them after its tasksSee them →", "/?run=run-1&view=issues"],
    ]);
    const issues = await screen.findByRole("region", { name: "Issues · 415 found" });
    expect([...issues.querySelectorAll(".verdict")].map((cell) => cell.textContent)).toEqual(["126confirmed · 1 critical, 21 high, 104 medium", "20unsettled · the check could not settle them",
      "46rejected · each with its reason", "223not checked · below the plan's bar, or left open"]);
    const ran = screen.getByRole("region", { name: "How it ran" });
    expect(fact(ran, "tokens")).toBe("none: scripted detectors call no model");
    expect(fact(ran, "found issues")).toBe("scripted detectors, no model calls");
    expect(within(ran).getByRole("button", { name: "Copy a report to send" })).toBeTruthy();
    expect(main().textContent).not.toMatch(/COMPLETED|unresolved_issues|degraded_coverage|canonical issue/u);
  });

  // Review the plan is a switch, off by default since October 25, 2026: a run without it showed nothing about a review.
  it("says on a finished audit's Summary that its plan was not reviewed when Review the plan was off", async () => {
    stubBrowser();
    const unreviewed = Object.fromEntries(Object.entries(ARTIFACT_CONTENT).filter(([kind]) => kind !== "critic-feedback"));
    stubControlPlane({ "GET /runs/run-1": resource(), "GET /runs/run-1/overview": modelOverview(), "GET /runs/run-1/progress": finishedProgress(), "GET /runs/run-1/metrics": metrics(),
      "GET /handoff/runs/run-1": { saved: [] }, ...artifactRoutes("run-1", unreviewed) });
    visit("?run=run-1");
    render(<App />);
    const ran = await screen.findByRole("region", { name: "How it ran" });
    expect(fact(ran, "wrote the plan")).toBe("Opus 5.5 · high");
    expect(fact(ran, "reviewed the plan")).toBe("no: Review the plan was off for this run");
  });

  it("says a review the run did not need did not happen, from the review's record, and names no reviewer", async () => {
    stubBrowser();
    const calls = stubControlPlane({ "GET /runs/run-1": resource({ workflow: BALANCED_WORKFLOW }), "GET /runs/run-1/overview": modelOverview(), "GET /runs/run-1/progress": finishedProgress(), "GET /runs/run-1/metrics": metrics(),
      "GET /handoff/runs/run-1": { saved: [] }, ...artifactRoutes("run-1", { ...ARTIFACT_CONTENT,
        "critic-result": { status: "not_required", requirement: { required: false, reasons: [] }, degradedReviewCoverage: false, criticCalls: 0, citedSourceLeftOut: [] },
        "critic-feedback": { summary: "critic not_required", items: [] } }) });
    visit("?run=run-1");
    render(<App />);
    const ran = await screen.findByRole("region", { name: "How it ran" });
    await waitFor(() => expect(fact(ran, "reviewed the plan")).toBe("no: not needed for this run"));
    expect(calls).toContain(`GET /runs/run-1/artifacts/${encodeURIComponent("artifact:critic-result")}`);
  });

  it("names the model that reviewed the plan and what it found", async () => {
    stubBrowser();
    stubControlPlane({ "GET /runs/run-1": resource({ workflow: BALANCED_WORKFLOW }), "GET /runs/run-1/overview": modelOverview(), "GET /runs/run-1/progress": finishedProgress(), "GET /runs/run-1/metrics": metrics(),
      "GET /handoff/runs/run-1": { saved: [] }, ...artifactRoutes("run-1", { ...ARTIFACT_CONTENT,
        "critic-result": { status: "completed", requirement: { required: true, reasons: ["switched_on"] }, degradedReviewCoverage: false, criticCalls: 1, citedSourceLeftOut: [] } }) });
    visit("?run=run-1");
    render(<App />);
    const ran = await screen.findByRole("region", { name: "How it ran" });
    await waitFor(() => expect(fact(ran, "reviewed the plan")).toBe("GPT-6.1 Sol · high · 1 objection"));
  });

  it("says how much of the project each finder read, so a finder that read few parts does not pass for a whole opinion", async () => {
    // Observed live (October 26, 2026, agy 1.4.7): Gemini answered 4 of the 32 parts Claude read, and the Summary named it beside the others.
    stubBrowser();
    const finished = finishedProgress();
    const [first, second] = finished.auditors;
    if (first === undefined || second === undefined) throw new Error("FIXTURE_AUDITORS_ABSENT");
    const progress = { ...finished, auditors: [{ ...first, finished: true, coverage: { units: 32, answered: 32, notExamined: {} } }, { ...second, finished: true, coverage: { units: 32, answered: 27, notExamined: { reply_rejected: 2, provider_failed: 3 } } }] };
    stubControlPlane({ "GET /runs/run-1": resource({ workflow: BALANCED_WORKFLOW }), "GET /runs/run-1/overview": modelOverview(), "GET /runs/run-1/progress": progress, "GET /runs/run-1/metrics": metrics(),
      "GET /handoff/runs/run-1": { saved: [] }, ...artifactRoutes("run-1") });
    visit("?run=run-1");
    render(<App />);
    const ran = await screen.findByRole("region", { name: "How it ran" });
    const finders = await within(ran).findByRole("list", { name: "finders" });
    expect(within(finders).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Opus 5.5 · xhigh · 32 of 32 parts read", "GPT-6.1 Sol · xhigh · 27 of 32 parts read (5 not read: 3 calls failed, 2 with no usable reply)"]);
  });

  it("says under a finished finder's stage how many of its parts it read, on a run that failed later", async () => {
    stubBrowser();
    const failed = finishedProgress({ state: "FAILED" });
    const [first, second] = failed.auditors;
    if (first === undefined || second === undefined) throw new Error("FIXTURE_AUDITORS_ABSENT");
    const progress = { ...failed, auditors: [{ ...first, finished: true, coverage: { units: 22, answered: 22, notExamined: {} } }, { ...second, finished: true, coverage: { units: 16, answered: 14, notExamined: { provider_failed: 2 } } }] };
    stubControlPlane({ "GET /runs/run-1": resource({ state: "FAILED", resumable: true, workflow: BALANCED_WORKFLOW }), "GET /runs/run-1/overview": modelOverview({ state: "FAILED", reason: "Error: boom", gate: null }), "GET /runs/run-1/progress": progress, ...artifactRoutes("run-1", {}) });
    visit("?run=run-1");
    render(<App />);
    const stages = await screen.findByRole("group", { name: "stages" });
    await waitFor(() => expect(within(stages).getAllByRole("button").map((button) => button.getAttribute("aria-label")).filter((label) => label?.startsWith("Find issues"))).toEqual([
      "Find issues · done · 0:53 · Opus 5.5 · xhigh · 22 of 22 parts read", "Find issues · done · 0:41 · GPT-6.1 Sol · xhigh · 14 of 16 parts read, 2 not read"]));
  });

  it("saves the plan into the project on request, then says where it went and what to do next", async () => {
    stubBrowser();
    const saved: { directory: string; relative: string; savedAt: string }[] = [];
    const calls = stubControlPlane({ "GET /runs/run-1": resource(), "GET /runs/run-1/overview": overview(), "GET /runs/run-1/metrics": metrics(), ...artifactRoutes("run-1"),
      "GET /handoff/runs/run-1": () => ({ saved }),
      "POST /handoff/runs/run-1": () => { saved.push({ directory: "/work/fixture/.arbitra/plans/2026-10-25-run1", relative: ".arbitra/plans/2026-10-25-run1", savedAt: "2026-10-25T09:30:00.000Z" }); return { directory: saved[0]?.directory, files: ["README.md"] }; } });
    visit("?run=run-1");
    render(<App />);
    const plan = await screen.findByRole("region", { name: "The plan is ready · 1 task for 1 issue" });
    fireEvent.click(await within(plan).findByRole("button", { name: "Save the plan into the project" }));
    expect(await within(plan).findByText("Saved in the project")).toBeTruthy();
    expect(within(plan).getByText(".arbitra/plans/2026-10-25-run1")).toBeTruthy();
    expect(within(plan).getByText(/^Next: open the project in Claude Code or Codex and ask it to work through/u).textContent).toContain(".arbitra/plans/2026-10-25-run1/README.md. Answer the 1 question it asks first");
    expect(within(plan).getByRole("button", { name: "Copy that request" })).toBeTruthy();
    // Saved, the plan is no longer the page's call to act: nothing is filled any more.
    expect(within(plan).queryByRole("button", { name: "Save the plan into the project" })).toBeNull();
    expect(calls.filter((call) => call === "POST /handoff/runs/run-1")).toHaveLength(1);
  });

  it("shows a plan saved before as saved, after a reload", async () => {
    stubBrowser();
    stubControlPlane({ "GET /runs/run-1": resource(), "GET /runs/run-1/overview": overview(), "GET /runs/run-1/metrics": metrics(), ...artifactRoutes("run-1"),
      "GET /handoff/runs/run-1": { saved: [{ directory: "/work/fixture/.arbitra/plans/2026-10-24-run1-2", relative: ".arbitra/plans/2026-10-24-run1-2", savedAt: "2026-10-24T10:00:00.000Z" }, { directory: "/work/fixture/.arbitra/plans/2026-10-24-run1", relative: ".arbitra/plans/2026-10-24-run1", savedAt: "2026-10-24T09:00:00.000Z" }] } });
    visit("?run=run-1");
    render(<App />);
    const plan = await screen.findByRole("region", { name: "The plan is ready · 1 task for 1 issue" });
    expect(await within(plan).findByText(".arbitra/plans/2026-10-24-run1-2")).toBeTruthy();
    expect(within(plan).getByText(/2 copies are in \.arbitra\/plans; this is the newest\./u)).toBeTruthy();
  });

  it("watches a running audit: the step and its time, what it has read and found, the stages with the finders side by side, and the calls started again", async () => {
    stubBrowser();
    stubControlPlane({ "GET /runs/run-1": resource({ state: "DISCOVERY_RUNNING", resumable: true, workflow: BALANCED_WORKFLOW }), "GET /runs/run-1/overview": modelOverview({ state: "DISCOVERY_RUNNING", gate: null, live: true }),
      "GET /runs/run-1/progress": discoveryProgress(), "GET /runs/run-1/traces*": EMPTY_TRACES, ...artifactRoutes("run-1", { preflight: { fileCount: 416, lineCount: 103_575 } }, { preflight: "preflight" }) });
    visit("?run=run-1");
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "veritra · audit" })).toBeTruthy();
    expect(document.querySelector(".run-header .chip")?.textContent).toBe("running");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(await screen.findByText(/416 files, 103,575 lines/u)).toBeTruthy();
    const now = await screen.findByRole("region", { name: "now" });
    expect(await within(now).findByText("Finding issues · 1 h 05 so far")).toBeTruthy();
    expect(within(now).getByText("36 parts read · 309 issues found, not checked yet · 3.4M of 65M tokens")).toBeTruthy();
    const stages = screen.getByRole("group", { name: "stages" });
    expect(within(stages).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "Read the project · done · 0:01 · 416 files",
      "Find issues · running · 1:05 · Opus 5.5 · xhigh · 22 parts read",
      "Find issues · running · 1:05 · GPT-6.1 Sol · xhigh · 14 parts read, 1 declined",
      "Merge duplicates · next", "Check each issue · waiting · Opus 5.5 · high", "Write the plan · waiting · Opus 5.5 · high", "Review the plan · waiting · GPT-6.1 Sol · high",
    ]);
    // The two finders share a column; only the line into the running column moves.
    expect(stages.querySelectorAll(".stage-graph__column")[1]?.querySelectorAll(".stage")).toHaveLength(2);
    expect([...stages.querySelectorAll(".stage-edge")].map((edge) => (edge as HTMLElement).dataset.flow)).toEqual(["live", "idle", "idle", "idle", "idle"]);
    expect(within(stages).getAllByRole("button").filter((button) => button.getAttribute("aria-current") === "step")).toHaveLength(2);
    expect(screen.getByText("7 model calls ran past 15 min and were started again. Which")).toBeTruthy();
    const found = screen.getByRole("region", { name: "Found so far · not checked yet" });
    expect(within(found).getByText("36 high · 107 medium · 158 low · 8 info")).toBeTruthy();
    expect(within(found).getAllByRole("listitem")).toHaveLength(4);
    expect((within(found).getAllByRole("listitem")[0] as HTMLElement).dataset.severity).toBe("high");
    fireEvent.click(within(found).getByRole("button", { name: "All 309, not checked yet" }));
    expect(within(found).getAllByRole("listitem")).toHaveLength(6);
    expect(screen.getByRole("link", { name: "Records" }).getAttribute("href")).toBe("/?run=run-1&view=activity");
    // A stage opens its records beside the page.
    fireEvent.click(within(stages).getByRole("button", { name: /^Find issues · running · 1:05 · Opus/u }));
    await waitFor(() => expect(address().get("item")).toBe("node:auditor-a"));
    // The stage keeps its step name and model in its records (no "Auditor A").
    expect(await screen.findByRole("complementary", { name: "details · Find issues · Opus 5.5 · xhigh" })).toBeTruthy();
  });

  it("follows the run's own events when its progress cannot be read, and says so", async () => {
    stubBrowser();
    stubControlPlane({ "GET /runs/run-1": resource({ state: "DISCOVERY_RUNNING", resumable: true, workflow: BALANCED_WORKFLOW }), "GET /runs/run-1/overview": modelOverview({ state: "DISCOVERY_RUNNING", gate: null, live: true }),
      "GET /runs/run-1/progress": () => json({ statusCode: 500, error: "REQUEST_FAILED", message: "EMFILE" }, 500), ...artifactRoutes("run-1", {}) });
    visit("?run=run-1");
    render(<App />);
    expect(await screen.findByText(/The run's progress could not be read just now/u)).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "stages" })).getAllByRole("button")).toHaveLength(7);
  });

  it("holds the tab until the header has the run's settings, so no row moves under a click", async () => {
    stubBrowser();
    let release = (): void => undefined;
    const arrived = new Promise<void>((resolve) => { release = resolve; });
    stubControlPlane({ "GET /runs/run-1": resource(), "GET /runs/run-1/overview": async () => { await arrived; return overview(); }, ...artifactRoutes("run-1") });
    visit("?run=run-1&view=issues");
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "run-1 · audit" })).toBeTruthy();
    // Observed in Firefox: the rows drew first, the header then grew by two lines, and a
    // click aimed at the first issue landed on the filters that moved into its place.
    expect(screen.getByText("loading the run")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "issues" })).toBeNull();
    release();
    expect(await screen.findByRole("region", { name: "issues" })).toBeTruthy();
    expect(screen.getByText(/scripted detectors, no model calls/u)).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "fixture · audit" })).toBeTruthy();
  });

  it("opens the tab without the run's settings when they cannot be read, and says so in words", async () => {
    stubBrowser();
    stubControlPlane({ "GET /runs/run-1": resource(), "GET /runs/run-1/overview": () => new Response("{}", { status: 503 }), ...artifactRoutes("run-1") });
    visit("?run=run-1&view=issues");
    render(<App />);
    expect(await screen.findByRole("region", { name: "issues" })).toBeTruthy();
    const problem = screen.getByText(/^The run's settings could not be read/u).closest(".problem") as HTMLElement;
    expect(problem.dataset.state).toBe("degraded");
    // The recorded code is one click down, not in the sentence.
    expect(within(problem).getByText("RUN_API_503").closest("details")).not.toBeNull();
    expect(screen.queryByText("loading")).toBeNull();
  });

  it("puts a selected issue in the address and the details panel, which Escape closes", async () => {
    stubBrowser();
    stubControlPlane({ "GET /runs/run-1": resource(), "GET /runs/run-1/overview": overview(), ...artifactRoutes("run-1") });
    visit("?run=run-1&view=issues");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Role check missing on update" }));
    await waitFor(() => expect(address().get("item")).toBe("issue:issue-1"));
    const details = await screen.findByRole("complementary", { name: "details · issue issue-1" });
    expect((await within(details).findByText("reviewer-c rejected it: the guard runs in middleware")).closest("[data-state]")?.getAttribute("data-state")).toBe("dissent");
    expect(within(details).getByText("Any authenticated user can change another user's role.").dataset.state).toBe("tainted");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("complementary", { name: /^details/u })).toBeNull());
    expect(address().get("item")).toBeNull();
    expect(address().get("view")).toBe("issues");
  });

  it("says what the Issues and Plan tabs will hold while the run is still working", async () => {
    stubBrowser();
    stubControlPlane({ "GET /runs/run-1": resource({ state: "DISCOVERY_RUNNING", resumable: true }), "GET /runs/run-1/overview": overview({ state: "DISCOVERY_RUNNING", gate: null, live: true }),
      "GET /runs/run-1/progress": discoveryProgress(), ...artifactRoutes("run-1", { preflight: { fileCount: 3 } }) });
    visit("?run=run-1&view=issues");
    render(<App />);
    const issues = await screen.findByRole("region", { name: "issues" });
    expect(within(issues).getByText(/^No issue is checked yet\. The issues appear here once the run has merged duplicates and checked each one/u)).toBeTruthy();
    expect(within(issues).getByRole("link", { name: "Summary" }).getAttribute("href")).toBe("/?run=run-1");
    fireEvent.click(within(screen.getByRole("navigation", { name: "run views" })).getByRole("link", { name: "Plan" }));
    expect(await screen.findByText(/^No plan yet\. The run writes it once every issue is checked/u)).toBeTruthy();
    expect(main().textContent).not.toMatch(/artifact absent/u);
  });

  it("says plainly that a run failed because the project is too large to read, and offers no resume that cannot help", async () => {
    stubBrowser();
    const reason = "Error: REPOSITORY_FILE_LIMIT_EXCEEDED:400";
    stubControlPlane({ "GET /runs/run-1": resource({ state: "FAILED", resumable: true }), "GET /runs/run-1/overview": overview({ state: "FAILED", reason, gate: null }), "GET /runs/run-1/progress": finishedProgress({ state: "FAILED" }), ...artifactRoutes("run-1", {}) });
    visit("?run=run-1");
    render(<App />);
    const failed = await screen.findByRole("region", { name: "The run failed" });
    expect(within(failed).getByText("The project has more than 400 source files, more than one run reads.")).toBeTruthy();
    expect(within(failed).getByText(/^Start a new audit that reads some folders of the project, or leaves some out\. Resuming this run would stop the same way\./u)).toBeTruthy();
    expect(within(failed).getByText(reason).closest("details")).not.toBeNull();
    expect(document.querySelector(".run-header .chip")?.textContent).toBe("failed");
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    // Starting again is the way on: New audit opens with this run's settings, where the folders to read are chosen.
    const again = screen.getByRole("link", { name: "New audit with these settings" });
    expect(new URL(again.getAttribute("href") ?? "", "http://arbitra.test").searchParams.get("from")).toBe("run:run-1");
  });

  // veritra (October 25, 2026): "Error: Prompt free text exceeds 1 MiB." The page said to resume, which stopped the same way
  // until a newer arbitra fixed the cause; the resume after the update went on from where the run stopped.
  it("says a failure inside arbitra needs a newer arbitra before a resume, and keeps resume for after the update", async () => {
    stubBrowser();
    const reason = "Error: Prompt free text exceeds 1 MiB.";
    stubControlPlane({ "GET /runs/run-1": resource({ state: "FAILED", resumable: true }), "GET /runs/run-1/overview": overview({ state: "FAILED", reason, gate: null }), "GET /runs/run-1/progress": finishedProgress({ state: "FAILED" }), ...artifactRoutes("run-1", {}) });
    visit("?run=run-1");
    render(<App />);
    const failed = await screen.findByRole("region", { name: "The run failed" });
    expect(within(failed).getByText("The run stopped on an error inside arbitra, not at a model.")).toBeTruthy();
    expect(within(failed).getByText(/^Resuming with this version of arbitra stops the same way\. Update arbitra, then resume: what the run finished is kept\./u)).toBeTruthy();
    expect(within(failed).getByText(reason).closest("details")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "New audit with these settings" })).toBeNull();
  });

  it("says plainly that a resume cannot reuse work an earlier version recorded, names the version the run started on, and offers no resume", async () => {
    // Observed live (veritra, October 25): after a code change, the resume failed with the bare code MODEL_ACTIVITY_INPUT_CHANGED.
    stubBrowser();
    const reason = "ModelActivityInputChangedError: MODEL_ACTIVITY_INPUT_CHANGED:critic/review/797dd4a3c05400e1756dbd7b/turn-0: the request this version of arbitra makes for critic/review/797dd4a3c05400e1756dbd7b/turn-0 differs from the one the run recorded, so the run cannot reuse that work. Resume it with the arbitra version it started on, \"45ed1d2 (2026-10-24), from a download\", or start a new run.";
    stubControlPlane({ "GET /runs/run-1": resource({ state: "FAILED", resumable: true }), "GET /runs/run-1/overview": overview({ state: "FAILED", reason, gate: null }), "GET /runs/run-1/progress": finishedProgress({ state: "FAILED" }), ...artifactRoutes("run-1", {}) });
    visit("?run=run-1");
    render(<App />);
    const failed = await screen.findByRole("region", { name: "The run failed" });
    expect(within(failed).getByText("This version of arbitra asks for the work of reviewing the plan differently from the version the run started on, so it cannot reuse what the run recorded there.")).toBeTruthy();
    expect(within(failed).getByText("It started on arbitra 45ed1d2 (2026-10-24), from a download. Resume it with that version, or start a new run. Resuming it with this version would stop the same way.")).toBeTruthy();
    expect(within(failed).getByText(reason).closest("details")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });

  it("offers resume for a failure that resuming can help, and keeps the error one click down", async () => {
    stubBrowser();
    const calls = stubControlPlane({ "GET /runs/run-1": resource({ state: "FAILED", resumable: true }), "GET /runs/run-1/overview": overview({ state: "FAILED", reason: "ProviderInvocationFailure: Provider openai failed after 3 attempts (TIMEOUT: Provider stage timed out after 900000ms)", gate: null }),
      "POST /runs/run-1/resume": resource({ state: "CREATED", resumable: true }), ...artifactRoutes("run-1", {}) });
    visit("?run=run-1");
    render(<App />);
    const failed = await screen.findByRole("region", { name: "The run failed" });
    expect(within(failed).getByText("A model call kept running past its time limit.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(calls).toContain("POST /runs/run-1/resume"));
  });

  // Observed live (October 27, 2026, v0.3.1, macOS): five files in a failed ten-hour audit's scope were edited, its resume
  // answered 500, and the way on was to put them back or start over, losing every finished part.
  it("names the files that changed when a resume is refused, and starts a new audit that reuses what the run finished", async () => {
    stubBrowser();
    const refusal = "RUN_REPOSITORY_CHANGED:run-1: the repository no longer holds the files the run read. Put them back as they were to resume it, or start an incremental audit of the project as it is now with this run as its base (run <config> --incremental run-1), which reuses the discovery it finished. 12 files changed since the run read them (11 changed, 1 added): "
      + [...Array.from({ length: 9 }, (_, index) => `changed scripts/step-${index}.sh`), "added docs/INSTALL.md"].join(", ") + " and 2 more";
    const calls = stubControlPlane({ "GET /runs/run-1": resource({ state: "FAILED", resumable: true }), "GET /runs/run-1/overview": modelOverview({ state: "FAILED", reason: "ProviderInvocationFailure: Provider openai failed after 3 attempts (TIMEOUT: Provider stage timed out after 900000ms)", gate: null }),
      "GET /runs/run-1/progress": finishedProgress({ state: "FAILED" }), "POST /runs/run-1/resume": () => json({ statusCode: 409, error: "REQUEST_FAILED", message: refusal }, 409),
      "POST /runs/run-1/incremental": resource({ runId: "run-2", state: "CREATED", resumable: true }), ...artifactRoutes("run-1", {}) });
    visit("?run=run-1");
    render(<App />);
    await screen.findByRole("region", { name: "The run failed" });
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    const changed = await screen.findByRole("alert", { name: "The project's files changed" });
    expect(within(changed).getByText("The project's files changed after the run read them, so the run cannot go on from where it stopped.")).toBeTruthy();
    expect(within(changed).getByText("12 files changed since the run read them:")).toBeTruthy();
    const files = within(changed).getByRole("list", { name: "files changed since the run read them" });
    expect(within(files).getAllByRole("listitem").map((item) => item.textContent)).toEqual([...Array.from({ length: 9 }, (_, index) => `scripts/step-${index}.sh · changed`), "docs/INSTALL.md · added"]);
    expect(within(changed).getByText("and 2 more files")).toBeTruthy();
    expect(within(changed).getByText(/^Put the files back as they were to resume, or start a new audit of the project as it is now\. It reuses the parts this run finished/u)).toBeTruthy();
    expect(within(changed).getByText(`${refusal} (RUN_API_409)`).closest("details")).not.toBeNull();
    fireEvent.click(within(changed).getByRole("button", { name: "New audit that reuses what this run finished" }));
    await waitFor(() => expect(address().get("run")).toBe("run-2"));
    expect(calls).toContain("POST /runs/run-1/incremental");
  });

  it("names the files that changed for a scripted audit, and offers no reuse a scripted audit cannot make", async () => {
    stubBrowser();
    const refusal = "RUN_REPOSITORY_CHANGED:run-1: the repository no longer holds the files the run read. Put them back as they were to resume it, or start a new run of the project as it is now. 1 file changed since the run read them (1 removed): removed src/old.ts";
    stubControlPlane({ "GET /runs/run-1": resource({ state: "CANCELLED", resumable: true }), "GET /runs/run-1/overview": overview({ state: "CANCELLED", gate: null }),
      "POST /runs/run-1/resume": () => json({ statusCode: 409, error: "REQUEST_FAILED", message: refusal }, 409), ...artifactRoutes("run-1", {}) });
    visit("?run=run-1");
    render(<App />);
    await screen.findByRole("region", { name: "Cancelled" });
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    const changed = await screen.findByRole("alert", { name: "The project's files changed" });
    expect(within(changed).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["src/old.ts · removed"]);
    expect(within(changed).getByText("Put the files back as they were to resume, or start a new audit of the project as it is now.")).toBeTruthy();
    expect(within(changed).queryByRole("button")).toBeNull();
  });

  it("says when a run paused for usage goes on by itself", async () => {
    stubBrowser();
    const reason = "ProviderUsageLimitError: Provider openai reached its usage limit (QUOTA: CLI_USAGE_LIMIT_REACHED: the Codex CLI subscription's usage allowance is exhausted until 2026-10-25T11:46:00.000Z)";
    stubControlPlane({ "GET /runs/run-1": resource({ state: "SUSPENDED_RATE_LIMIT", resumable: true }), "GET /runs/run-1/overview": overview({ state: "SUSPENDED_RATE_LIMIT", reason, gate: null }), ...artifactRoutes("run-1", {}) });
    visit("?run=run-1");
    render(<App />);
    const paused = await screen.findByRole("region", { name: "Paused for usage" });
    expect(within(paused).getByText(/Codex CLI's usage limit was reached\. Everything it has done is kept\. The limit resets at/u)).toBeTruthy();
    expect(document.querySelector(".run-header .chip")?.textContent).toBe("paused for usage");
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
  });

  it("tells how a finished run went in full, keeps the recorded codes in the details, and has its records one click down", async () => {
    stubBrowser();
    stubControlPlane({ "GET /runs/run-1": resource({ workflow: BALANCED_WORKFLOW }), "GET /runs/run-1/overview": modelOverview(), "GET /runs/run-1/progress": finishedProgress(), "GET /runs/run-1/metrics": metrics(),
      "GET /runs/run-1/traces*": EMPTY_TRACES, ...artifactRoutes("run-1", { ...ARTIFACT_CONTENT, preflight: { fileCount: 416, lineCount: 103_575 } }) });
    visit("?run=run-1&view=how-it-ran");
    render(<App />);
    const facts = await screen.findByRole("region", { name: "Time, tokens and models" });
    await waitFor(() => expect(fact(facts, "tokens")).toBe("26.8M · 213K per confirmed issue"));
    expect(fact(facts, "time")).toBe("1 h 45 · finding 53 min, merging 4 min, checking 19 min, plan 26 min, review 2 min");
    expect(fact(facts, "found issues")).toBe("Opus 5.5 · xhigh, GPT-6.1 Sol · xhigh");
    expect(fact(facts, "checked them")).toBe("Opus 5.5 · high");
    expect(fact(facts, "wrote the plan")).toBe("Opus 5.5 · high");
    await waitFor(() => expect(fact(facts, "reviewed the plan")).toBe("GPT-6.1 Sol · high · 1 objection"));
    const settings = screen.getByRole("region", { name: "What it read and how" });
    expect(fact(settings, "project")).toBe("/work/veritra · 416 files, 103,575 lines");
    expect(fact(settings, "review rounds")).toBe("none: each issue goes straight to its check");
    const codes = screen.getByText("Recorded codes").closest("details") as HTMLElement;
    expect(within(codes).getByText("COMPLETED")).toBeTruthy();
    expect(within(codes).getByText("audit-balanced")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Activity" }));
    await waitFor(() => expect(address().get("view")).toBe("activity"));
    const records = screen.getByRole("navigation", { name: "records" });
    expect(within(records).getAllByRole("link").map((link) => link.textContent)).toEqual(["← How it ran", "Activity", "Evaluation"]);
    expect(within(screen.getByRole("navigation", { name: "run views" })).getByRole("link", { name: "How it ran" }).getAttribute("aria-current")).toBe("page");
    expect(await screen.findByRole("region", { name: "trace browser" })).toBeTruthy();
  });

  it("names the run an incremental audit reuses the work of, in what it read and how", async () => {
    stubBrowser();
    const configuration = { ...MODEL_CONFIGURATION, workflow: { ...(MODEL_CONFIGURATION["workflow"] as Readonly<Record<string, unknown>>), incremental: { baseRunId: "run-0" } } };
    stubControlPlane({ "GET /runs/run-1": resource({ workflow: BALANCED_WORKFLOW }), "GET /runs/run-1/overview": modelOverview({ configuration }), "GET /runs/run-1/progress": finishedProgress(), "GET /runs/run-1/metrics": metrics(),
      ...artifactRoutes("run-1") });
    visit("?run=run-1&view=how-it-ran");
    render(<App />);
    const settings = await screen.findByRole("region", { name: "What it read and how" });
    expect(fact(settings, "reuses the work of")).toBe("run-0 · what it finished whose files did not change");
    expect(within(settings).getByRole("link", { name: "run-0" }).getAttribute("href")).toBe("/?run=run-0");
  });

  it("puts a blocked run's decision above every tab and resumes only once nothing is left to decide", async () => {
    stubBrowser();
    const pending: HumanCheckpointResource = { kind: "human", checkpointId: "approval", version: "a".repeat(64), mode: "interactive", status: "pending", prompt: 'Release the plan? <img src=x onerror="window.__injected=1">', decisions: ["approve", "reject"] };
    let decided = false;
    const calls = stubControlPlane({
      "GET /runs/run-1": () => resource({ state: "BLOCKED", resumable: true, checkpoints: [decided ? { ...pending, status: "approved" } : pending] }),
      "GET /runs/run-1/overview": () => overview({ state: "BLOCKED", gate: null, pendingDecisions: decided ? 0 : 1 }),
      "POST /runs/run-1/checkpoints/approval": ({ body }: { body: unknown }) => { expect(body).toEqual({ version: "a".repeat(64), decision: "approve" }); decided = true; return { accepted: true }; },
      "POST /runs/run-1/resume": () => resource({ state: "RUNNING", resumable: true }),
      ...artifactRoutes("run-1"),
    });
    visit("?run=run-1&view=plan");
    render(<App />);
    const banner = () => screen.getByRole("region", { name: /This run is waiting for your decision/u });
    await screen.findByRole("region", { name: /This run is waiting for your decision/u });
    expect(document.querySelector(".run-header .chip")?.textContent).toBe("needs you");
    expect(within(banner()).getByText(/Release the plan\? <img src=x/u)).toBeTruthy();
    expect(document.querySelector("img[src='x']")).toBeNull();
    expect((within(banner()).getByRole("button", { name: "resume run" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(banner()).getByRole("button", { name: "approve" }));
    await waitFor(() => expect((within(banner()).getByRole("button", { name: "resume run" }) as HTMLButtonElement).disabled).toBe(false));
    expect(within(banner()).getByText("checkpoint approval · approved").dataset.state).toBe("verified");
    fireEvent.click(within(banner()).getByRole("button", { name: "resume run" }));
    await waitFor(() => expect(calls).toContain("POST /runs/run-1/resume"));
    expect(calls.indexOf("POST /runs/run-1/checkpoints/approval")).toBeLessThan(calls.indexOf("POST /runs/run-1/resume"));
  });

  it("takes an answer to every blocking plan question, sends them once for the plan's version, then offers resume", async () => {
    stubBrowser();
    const version = "b".repeat(64);
    const questions: PlanQuestionsCheckpointResource = { kind: "plan-questions", checkpointId: "plan-questions", version, status: "pending",
      questions: [{ id: "Q-1", question: "Throw or clamp an out-of-range value?", blastRadius: "high" }, { id: "Q-2", question: "Keep the old log format?", blastRadius: "low" }] };
    let answered = false;
    const calls = stubControlPlane({
      "GET /runs/run-1": () => resource({ state: "BLOCKED", resumable: true, checkpoints: [answered ? { ...questions, status: "answered" } : questions] }),
      "GET /runs/run-1/overview": () => overview({ state: "BLOCKED", executor: "models", gate: null, pendingDecisions: answered ? 0 : 1 }),
      "POST /runs/run-1/checkpoints/plan-questions": ({ body }: { body: unknown }) => { expect(body).toEqual({ version, answers: [{ questionId: "Q-1", answer: "Throw a typed error." }, { questionId: "Q-2", answer: "Yes." }] }); answered = true; return { accepted: true }; },
      "POST /runs/run-1/resume": () => resource({ state: "RUNNING", resumable: true }),
      ...artifactRoutes("run-1"),
    });
    visit("?run=run-1");
    render(<App />);
    const banner = () => screen.getByRole("region", { name: /This run is waiting for your decision/u });
    const form = await screen.findByRole("form", { name: "plan questions" });
    expect(screen.getByRole("region", { name: "Needs you" }).textContent).toContain("The run waits on the decisions above.");
    expect(within(form).getByText("Throw or clamp an out-of-range value?")).toBeTruthy();
    const send = within(form).getByRole("button", { name: "send answers" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText(/Q-1 · high impact/u), { target: { value: "  Throw a typed error. " } });
    // Every question needs an answer before any is sent.
    expect(send.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText(/Q-2 · low impact/u), { target: { value: "Yes." } });
    expect(send.disabled).toBe(false);
    expect((within(banner()).getByRole("button", { name: "resume run" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(send);
    await waitFor(() => expect(within(banner()).getByText("plan questions · answered").dataset.state).toBe("verified"));
    expect(screen.queryByRole("form", { name: "plan questions" })).toBeNull();
    expect(calls.filter((call) => call === "POST /runs/run-1/checkpoints/plan-questions")).toHaveLength(1);
    fireEvent.click(within(banner()).getByRole("button", { name: "resume run" }));
    await waitFor(() => expect(calls).toContain("POST /runs/run-1/resume"));
  });

  it("lands a link to a tab this mode does not have, or the old Overview, on the Summary", async () => {
    stubBrowser();
    stubControlPlane({
      "GET /runs/run-2": resource({ runId: "run-2", workflow: FEATURE_WORKFLOW }),
      "GET /runs/run-2/overview": overview({ runId: "run-2", mode: "feature", workflowId: "feature-simple", executor: "models", gate: { status: "passed", reasons: [] }, configuration: { mode: "feature", models: {}, workflow: {} } }),
      "GET /runs/run-2/requirements": null, ...artifactRoutes("run-2", {}),
    });
    visit("?run=run-2&view=issues");
    render(<App />);
    const tabs = await screen.findByRole("navigation", { name: "run views" });
    await waitFor(() => expect(address().get("view")).toBeNull());
    expect(within(tabs).getAllByRole("link").map((link) => link.textContent)).toEqual(["Summary", "Requirements", "Plan", "How it ran"]);
    expect(within(tabs).getByRole("link", { name: "Summary" }).getAttribute("aria-current")).toBe("page");
    expect(await screen.findByRole("region", { name: "Requirements and handoff" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "fixture · feature" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "How it ended" }).textContent).toBe("gate passed");
  });

  it("names any other reason an audit's gate did not pass under Needs you, in words", async () => {
    stubBrowser();
    stubControlPlane({ "GET /runs/run-1": resource(), "GET /runs/run-1/overview": overview({ gate: { status: "failed", reasons: ["degraded_coverage", "checkpoint_rejected:approval"] } }), "GET /runs/run-1/metrics": metrics({ confirmedYield: { ...metrics().confirmedYield as object, unsettled: 0 } }),
      "GET /handoff/runs/run-1": { saved: [] }, ...artifactRoutes("run-1") });
    visit("?run=run-1");
    render(<App />);
    const needs = await screen.findByRole("region", { name: "Needs you" });
    await waitFor(() => expect(within(needs).getByRole("link", { name: /^The gate did not pass: checkpoint approval was rejected/u }).getAttribute("href")).toBe("/?run=run-1&view=how-it-ran"));
    expect(main().textContent).not.toMatch(/checkpoint_rejected/u);
  });

  it("explains a node from the run's own records, including that a scripted auditor calls no model", async () => {
    stubBrowser();
    stubControlPlane({ "GET /runs/run-1": resource(), "GET /runs/run-1/overview": overview(), "GET /runs/run-1/traces*": EMPTY_TRACES, ...artifactRoutes("run-1", { "findings-auditor-a": [] }, { "findings-auditor-a": "auditor-a" }) });
    visit("?run=run-1&view=activity&item=node:auditor-a");
    render(<App />);
    const details = await screen.findByRole("complementary", { name: "details · Find issues" });
    expect(await within(details).findByText("scripted detector · this node makes no model call")).toBeTruthy();
    expect(within(details).queryByRole("region", { name: "model attempts" })).toBeNull();
    expect(await within(details).findByRole("button", { name: "findings-auditor-a" })).toBeTruthy();
    expect(await screen.findByText("no model attempts · scripted detectors make no model calls")).toBeTruthy();
    expect(screen.getByLabelText("node kinds").textContent).toContain("human checkpoint");
  });

  it("shows a compiled prompt as what the model received: provenance, then each layer at its recorded bytes", async () => {
    stubBrowser();
    const text = '{"layer":"locked"}{"layer":"round","value":"Review é"}';
    const prompt = { text, breakpoints: [{ afterLayer: "locked", endByte: 18, prefixHash: "x" }, { afterLayer: "round", endByte: new TextEncoder().encode(text).length, prefixHash: "y" }],
      provenance: { modelId: "model-x", nodeId: "feature/requirements", protocolId: "feature-requirements", protocolVersion: "1.0.0", promptHash: "p".repeat(64), protocolHash: "h".repeat(64), redactionCount: 0, overrides: { before: null, after: null } } };
    const kind = `compiled-prompt-${"7d61".repeat(16)}`;
    stubControlPlane({ "GET /runs/run-2": resource({ runId: "run-2", workflow: FEATURE_WORKFLOW }), "GET /runs/run-2/overview": overview({ runId: "run-2", mode: "feature", executor: "models" }), "GET /runs/run-2/traces*": EMPTY_TRACES,
      ...artifactRoutes("run-2", { [kind]: prompt }, { [kind]: "feature/requirements" }) });
    visit(`?run=run-2&view=activity&item=${encodeURIComponent(`artifact:artifact:${kind}`)}`);
    render(<App />);
    const details = await screen.findByRole("complementary", { name: "details · artifact" });
    expect(await within(details).findByText("feature-requirements@1.0.0")).toBeTruthy();
    expect(within(details).getByText("compiled-prompt · 7d617d61")).toBeTruthy();
    expect(within(details).getByText("prompt layer · locked")).toBeTruthy();
    expect(within(details).getByText(/"value": "Review é"/u)).toBeTruthy();
  });

  it("becomes a modal drawer below 1180px that takes focus, and closes", async () => {
    stubBrowser({ narrow: true });
    stubControlPlane({ "GET /runs/run-1": resource(), "GET /runs/run-1/overview": overview(), ...artifactRoutes("run-1") });
    visit("?run=run-1&view=issues&item=issue:issue-1");
    render(<App />);
    const dialog = await screen.findByRole("dialog", { name: "details · issue issue-1" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const close = within(dialog).getByRole("button", { name: "close details" });
    await waitFor(() => expect(document.activeElement).toBe(close));
    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("cancels a running run from the header, then offers to resume it", async () => {
    stubBrowser();
    let state = "DISCOVERY_RUNNING";
    const calls = stubControlPlane({ "GET /runs/run-1": () => resource({ state, resumable: true }), "GET /runs/run-1/overview": () => overview({ state, gate: null, live: state !== "CANCELLED" }),
      "GET /runs/run-1/progress": () => discoveryProgress({ state, live: state !== "CANCELLED" }), "POST /runs/run-1/cancel": () => { state = "CANCELLED"; return resource({ state, resumable: true }); }, ...artifactRoutes("run-1") });
    visit("?run=run-1");
    render(<App />);
    await waitFor(() => expect(document.querySelector(".run-header .chip")?.textContent).toBe("running"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.querySelector(".run-header .chip")?.textContent).toBe("cancelled"));
    expect(await screen.findByRole("region", { name: "Cancelled" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
    expect(calls).toContain("POST /runs/run-1/cancel");
  });

  it("offers resume, not cancel, for a running run this arbitra is not executing, and says why", async () => {
    stubBrowser();
    const calls = stubControlPlane({ "GET /runs/run-1": resource({ state: "PEER_REVIEW_RUNNING", resumable: true }), "GET /runs/run-1/overview": overview({ state: "PEER_REVIEW_RUNNING", gate: null, live: false }),
      "POST /runs/run-1/resume": resource({ state: "PEER_REVIEW_RUNNING", resumable: true }), ...artifactRoutes("run-1") });
    visit("?run=run-1");
    render(<App />);
    expect(await screen.findByText(/This arbitra is not running this run\. Another arbitra, such as the command line, may be running it/u)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(calls).toContain("POST /runs/run-1/resume"));
  });

  it("says so in words when the run cannot be opened, with the recorded error one click down", async () => {
    stubBrowser();
    // The control plane answers an absent run with 404 (it answered 500 until October 25, 2026).
    stubControlPlane({ "GET /runs/run-9": () => json({ statusCode: 404, error: "REQUEST_FAILED", message: "RUN_ABSENT:run-9" }, 404) });
    visit("?run=run-9");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "This run could not be opened" })).toBeTruthy();
    expect(screen.getByText(/^No run with this ID is recorded by this arbitra\./u)).toBeTruthy();
    expect(screen.getByText(/RUN_ABSENT:run-9 \(RUN_API_404\)/u).closest("details")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Back to all runs" }).getAttribute("href")).toBe("/");
  });
});
