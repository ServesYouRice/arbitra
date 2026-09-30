// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HumanCheckpointResource, PlanQuestionsCheckpointResource } from "../../src/api/runs.js";
import { App } from "../../src/app/App.js";
import { address, json, stubBrowser, stubControlPlane, visit } from "../support.js";
import { artifactRoutes, EMPTY_TRACES, FEATURE_WORKFLOW, overview, resource } from "./fixtures.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); visit(""); });

describe("the run page", () => {
  it("opens a finished scripted audit on its overview: the gate in words and codes, and only the Audit tabs", async () => {
    stubBrowser();
    stubControlPlane({ "GET /runs/run-1": resource(), "GET /runs/run-1/overview": overview(), ...artifactRoutes("run-1") });
    visit("?run=run-1");
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Audit run · audit-deep" })).toBeTruthy();
    const tabs = screen.getByRole("navigation", { name: "run views" });
    expect(within(tabs).getAllByRole("link").map((link) => link.textContent)).toEqual(["Overview", "Issues", "Plan", "Activity", "Evaluation"]);
    expect(within(tabs).getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBe("page");
    const result = await screen.findByRole("region", { name: "result" });
    expect(within(result).getByText("coverage is incomplete")).toBeTruthy();
    expect(within(result).getByText("degraded_coverage")).toBeTruthy();
    expect(within(result).getByText(/a scripted run always fails the gate on coverage/u)).toBeTruthy();
    expect(screen.getAllByText(/scripted detectors · no model calls/u).length).toBeGreaterThan(0);
    expect(await screen.findByText(/2 canonical issues from 31 source findings by 3 auditors/u)).toBeTruthy();
    expect(screen.getByRole("link", { name: "open the issue board" }).getAttribute("href")).toBe("/?run=run-1&view=issues");
  });

  it("holds the tab until the header has the run's settings, so no row moves under a click", async () => {
    stubBrowser();
    let release = (): void => undefined;
    const arrived = new Promise<void>((resolve) => { release = resolve; });
    stubControlPlane({ "GET /runs/run-1": resource(), "GET /runs/run-1/overview": async () => { await arrived; return overview(); }, ...artifactRoutes("run-1") });
    visit("?run=run-1&view=issues");
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Audit run · audit-deep" })).toBeTruthy();
    // Observed in Firefox: the rows drew first, the header then grew by two lines, and a
    // click aimed at the first issue landed on the filters that moved into its place.
    expect(screen.getByText("loading the run")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "issue board" })).toBeNull();
    release();
    expect(await screen.findByRole("region", { name: "issue board" })).toBeTruthy();
    expect(screen.getByText("/work/fixture")).toBeTruthy();
  });

  it("opens the tab without the run's settings when they cannot be read, and says so", async () => {
    stubBrowser();
    stubControlPlane({ "GET /runs/run-1": resource(), "GET /runs/run-1/overview": () => new Response("{}", { status: 503 }), ...artifactRoutes("run-1") });
    visit("?run=run-1&view=issues");
    render(<App />);
    expect(await screen.findByRole("region", { name: "issue board" })).toBeTruthy();
    expect(screen.getByText(/^run settings unavailable · /u).dataset.state).toBe("degraded");
    expect(screen.getAllByText("unavailable").length).toBe(4);
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
    expect((await within(details).findByText("reviewer-c · reject · the guard runs in middleware")).dataset.state).toBe("dissent");
    expect(within(details).getByText("Any authenticated user can change another user's role.").dataset.state).toBe("tainted");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("complementary", { name: /^details/u })).toBeNull());
    expect(address().get("item")).toBeNull();
    expect(address().get("view")).toBe("issues");
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

  it("lands a link to a tab this mode does not have on the overview", async () => {
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
    expect(within(tabs).getAllByRole("link").map((link) => link.textContent)).toEqual(["Overview", "Requirements", "Plan", "Activity", "Evaluation"]);
    expect(within(tabs).getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBe("page");
    expect((await screen.findAllByText("gate passed")).length).toBeGreaterThan(0);
  });

  it("explains a node from the run's own records, including that a scripted auditor calls no model", async () => {
    stubBrowser();
    stubControlPlane({ "GET /runs/run-1": resource(), "GET /runs/run-1/overview": overview(), "GET /runs/run-1/traces*": EMPTY_TRACES, ...artifactRoutes("run-1", { "findings-auditor-a": [] }, { "findings-auditor-a": "auditor-a" }) });
    visit("?run=run-1&view=activity&item=node:auditor-a");
    render(<App />);
    const details = await screen.findByRole("complementary", { name: "details · Auditor A" });
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
      "POST /runs/run-1/cancel": () => { state = "CANCELLED"; return resource({ state, resumable: true }); }, ...artifactRoutes("run-1") });
    visit("?run=run-1");
    render(<App />);
    expect(await screen.findByText("running · discovery")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "cancel run" }));
    expect(await screen.findByText("cancelled")).toBeTruthy();
    expect(screen.getByRole("button", { name: "resume run" })).toBeTruthy();
    expect(calls).toContain("POST /runs/run-1/cancel");
  });

  it("offers resume, not cancel, for a running run this control plane is not executing, and says why", async () => {
    stubBrowser();
    const calls = stubControlPlane({ "GET /runs/run-1": resource({ state: "PEER_REVIEW_RUNNING", resumable: true }), "GET /runs/run-1/overview": overview({ state: "PEER_REVIEW_RUNNING", gate: null, live: false }),
      "POST /runs/run-1/resume": resource({ state: "PEER_REVIEW_RUNNING", resumable: true }), ...artifactRoutes("run-1") });
    visit("?run=run-1");
    render(<App />);
    expect(await screen.findByText(/This control plane is not executing this run\. Another arbitra process, such as the CLI, may be running it/u)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "cancel run" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "resume run" }));
    await waitFor(() => expect(calls).toContain("POST /runs/run-1/resume"));
  });

  it("says so when the run cannot be opened", async () => {
    stubBrowser();
    stubControlPlane({ "GET /runs/run-9": () => json({ statusCode: 500, error: "REQUEST_FAILED", message: "RUN_ABSENT:run-9" }, 500) });
    visit("?run=run-9");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "This run could not be opened" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("RUN_ABSENT:run-9 (RUN_API_500)");
    expect(screen.getByRole("link", { name: "back to all runs" }).getAttribute("href")).toBe("/");
  });
});
