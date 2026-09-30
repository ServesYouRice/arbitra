// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/app/App.js";
import { getIn, lines, placeholders, roleSlots, setIn, withGraph, withPreset, withScopeKind } from "../../src/pages/new-run/draft.js";
import { SCRIPTED_AUDIT, TEMPLATES } from "../../src/pages/new-run/templates.js";
import { address, stubBrowser, stubControlPlane, visit } from "../support.js";
import { artifactRoutes, overview, resource } from "./fixtures.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); visit(""); });
const template = (id: string) => { const found = TEMPLATES.find((item) => item.id === id); if (found === undefined) throw new Error(`no template ${id}`); return found; };
const AUDIT_DEEP = { schemaVersion: 1, id: "audit-deep", goal: { objective: "Audit", doneWhen: [], stopWhen: [], blockedWhen: [] }, entryNodeId: "preflight",
  nodes: ["preflight", "auditor-a", "auditor-b", "consensus"].map((id) => ({ id, kind: id.startsWith("auditor") ? "model" : "deterministic", label: id === "preflight" ? "Preflight" : id === "consensus" ? "Consensus" : `Auditor ${id.slice(-1).toUpperCase()}`, goal: { objective: id, doneWhen: [], stopWhen: [], blockedWhen: [] } })),
  edges: [["preflight", "auditor-a"], ["preflight", "auditor-b"], ["auditor-a", "consensus"], ["auditor-b", "consensus"]].map(([from, to]) => ({ id: `${from}-${to}`, from, to })) };
const BASE_ROUTES = { "GET /configurations": [], "GET /repositories/selected": { repository: "/work/fixture" }, "GET /workflows": { graphs: [], templates: [AUDIT_DEEP] } };
const READY = { valid: true, ready: true, mode: "audit", preset: "audit-deep", modelBacked: false, diagnostics: [], repository: "/work/fixture", estimateError: null,
  estimate: { estimate: { files: 12, lines: 34, nodes: 8, auditors: 3, providerCalls: 0, costUsd: 0, currency: null, basis: "scripted_auditors_make_no_provider_calls" }, gate: "clear" } };

describe("configuration drafts", () => {
  it("edits nested values without mutating the draft, and removes a key set to undefined", () => {
    const edited = setIn(SCRIPTED_AUDIT, ["workflow", "modelExecution", "maximumTokens"], 1000);
    expect(getIn(edited, ["workflow", "modelExecution", "maximumTokens"])).toBe(1000);
    expect(getIn(SCRIPTED_AUDIT, ["workflow", "modelExecution"])).toBeUndefined();
    expect(getIn(setIn(edited, ["workflow", "modelExecution"], undefined), ["workflow"])).toEqual({ preset: "audit-deep" });
    expect(lines(" src/a \n\n src/b ")).toEqual(["src/a", "src/b"]);
    expect(lines("  \n")).toBeUndefined();
  });

  it("keeps a preset and a saved graph exclusive, and a new scope kind keeps only its exclusions", () => {
    const graph = withGraph(SCRIPTED_AUDIT, { id: "reviewed", version: "abc" });
    expect(getIn(graph, ["workflow"])).toEqual({ graph: { id: "reviewed", version: "abc" } });
    expect(getIn(withPreset(graph, "diff-fast"), ["workflow"])).toEqual({ preset: "diff-fast" });
    const scoped = setIn(setIn(SCRIPTED_AUDIT, ["scope", "modules"], ["src"]), ["scope", "exclude"], ["vendor"]);
    expect(getIn(withScopeKind(scoped, "diff"), ["scope"])).toEqual({ kind: "diff", diffMode: "range", head: "HEAD", exclude: ["vendor"] });
  });

  it("names each mode's model roles where the runtime reads them", () => {
    expect(roleSlots(SCRIPTED_AUDIT)).toEqual([]);
    expect(roleSlots(template("subscription-audit").config).map(({ path }) => path.join("."))).toEqual(["workflow.modelExecution.roles.planner", "workflow.modelExecution.roles.verifier", "workflow.modelExecution.roles.critic"]);
    expect(roleSlots(template("subscription-feature-interactive").config).map(({ label, multiple }) => `${label}${multiple ? "[]" : ""}`)).toEqual(["requirements", "exploration", "planner", "reviewers[]", "critic"]);
    expect(roleSlots(template("testing-execute").config).map(({ label }) => label)).toEqual(["analyst", "planner", "fast writer", "balanced writer", "frontier writer"]);
    expect(roleSlots(template("testing-plan").config).map(({ label }) => label)).toEqual(["analyst", "planner"]);
  });

  it("lists every value a template leaves to fill in, by path", () => {
    expect(placeholders(SCRIPTED_AUDIT)).toEqual([]);
    expect(placeholders(template("subscription-audit").config)).toEqual(["models.auditor-a.modelId", "models.auditor-a.family", "models.auditor-b.modelId", "models.auditor-b.family", "models.auditor-c.modelId", "models.auditor-c.family"]);
    expect(placeholders(template("testing-execute").config)).toEqual(expect.arrayContaining(["workflow.testing.goal", "workflow.testing.execution.verification.execution.image"]));
  });

  it("offers every model-backed template, each in the mode it says", () => {
    expect(TEMPLATES.map(({ id }) => id)).toEqual(["scripted-audit", "subscription-audit", "audit-mixed-providers", "audit-compatible-chat", "subscription-feature-interactive", "subscription-feature-automatic", "feature-interactive", "feature-automatic", "subscription-testing-plan", "subscription-testing-execute", "testing-plan", "testing-execute"]);
    for (const { mode, config } of TEMPLATES) expect(config["mode"]).toBe(mode);
  });
});

describe("the new-run page", () => {
  it("starts from the scripted smoke test, says it calls no model, and describes the preset's steps", async () => {
    stubBrowser();
    stubControlPlane(BASE_ROUTES);
    visit("?page=new-run");
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "New run" })).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "starting point" }) as HTMLSelectElement).value).toBe("template:scripted-audit");
    expect(await screen.findByText("no models · the auditors are deterministic detectors")).toBeTruthy();
    expect(await screen.findByText(/Steps: Preflight → Auditor A, Auditor B → Consensus\./u)).toBeTruthy();
    expect((await screen.findByRole("textbox", { name: "repository path" }) as HTMLInputElement).value).toBe("/work/fixture");
  });

  it("lists what a template leaves open, and the list shrinks as values are filled in", async () => {
    stubBrowser();
    stubControlPlane(BASE_ROUTES);
    visit("?page=new-run&from=template:subscription-audit");
    render(<App />);
    const list = await screen.findByRole("list", { name: "placeholders to fill in" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(6);
    fireEvent.change(screen.getByRole("textbox", { name: "model ID for auditor-a" }), { target: { value: "claude-sonnet-5" } });
    await waitFor(() => expect(within(screen.getByRole("list", { name: "placeholders to fill in" })).getAllByRole("listitem")).toHaveLength(5));
    expect((screen.getByRole("combobox", { name: "planner role" }) as HTMLSelectElement).value).toBe("auditor-a");
  });

  it("checks the unsaved draft against the repository, then shows each problem and the estimate", async () => {
    stubBrowser();
    const bodies: unknown[] = [];
    const calls = stubControlPlane({ ...BASE_ROUTES, "POST /preflight": ({ body }: { body: unknown }) => { bodies.push(body); return { ...READY, ready: false, modelBacked: true,
      diagnostics: [{ code: "SUBSCRIPTION_CLI_NOT_INSTALLED:claude-code", severity: "error", scope: "environment", path: "$environment", message: "Claude Code is not available." }],
      estimate: { ...READY.estimate, estimate: { ...READY.estimate.estimate, providerCalls: null, costUsd: null } } }; } });
    visit("?page=new-run&from=template:subscription-audit");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "check configuration" }));
    const result = await screen.findByRole("region", { name: "check result" });
    expect(result.textContent).toContain("valid, but this machine is not ready · 1 problem");
    expect(within(result).getByText("SUBSCRIPTION_CLI_NOT_INSTALLED:claude-code")).toBeTruthy();
    expect(within(result).getByText("Claude Code is not available.")).toBeTruthy();
    expect(within(result).getByText("not known before the run")).toBeTruthy();
    expect(within(result).getByText("unavailable · no pricing is configured")).toBeTruthy();
    expect(bodies).toEqual([{ config: template("subscription-audit").config, repository: "/work/fixture" }]);
    expect(calls.filter((call) => call.startsWith("POST /configurations"))).toEqual([]);
    fireEvent.change(screen.getByRole("spinbutton", { name: "review rounds" }), { target: { value: "3" } });
    expect(await screen.findByText("the configuration changed after this check · check it again")).toBeTruthy();
  });

  it("saves the configuration, starts the run from it, and opens the run", async () => {
    stubBrowser();
    const calls = stubControlPlane({ ...BASE_ROUTES, "POST /preflight": READY,
      "POST /configurations": ({ body }: { body: { name: string; config: unknown } }) => ({ id: "cfg-1", name: body.name, config: body.config }),
      "POST /runs": ({ body }: { body: unknown }) => { expect(body).toEqual({ configurationId: "cfg-1", repository: "/work/fixture" }); return resource({ runId: "run-new", state: "CREATED" }); },
      "GET /runs/run-new": resource({ runId: "run-new" }), "GET /runs/run-new/overview": overview({ runId: "run-new" }), ...artifactRoutes("run-new") });
    visit("?page=new-run");
    render(<App />);
    fireEvent.change(await screen.findByRole("textbox", { name: "configuration name" }), { target: { value: "Smoke" } });
    fireEvent.click(screen.getByRole("button", { name: "save and start" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Audit run · audit-deep" })).toBeTruthy();
    expect(address().get("run")).toBe("run-new");
    expect(calls.filter((call) => call.startsWith("POST"))).toEqual(["POST /preflight", "POST /configurations", "POST /runs"]);
  });

  it("neither saves nor starts a configuration that fails preflight", async () => {
    stubBrowser();
    const calls = stubControlPlane({ ...BASE_ROUTES, "POST /preflight": { ...READY, valid: false, ready: false, estimate: null, diagnostics: [{ code: "MODEL_IDENTITY_PLACEHOLDER", severity: "error", scope: "configuration", path: "models.auditor-a.modelId", message: "Replace the placeholder." }] } });
    visit("?page=new-run&from=template:subscription-audit");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "save and start" }));
    expect(await screen.findByText("Starting needs a configuration that passes preflight; fix the problems above first.")).toBeTruthy();
    expect(screen.getByRole("region", { name: "check result" }).textContent).toContain("not valid · 1 problem in the configuration");
    expect(calls.filter((call) => call.startsWith("POST"))).toEqual(["POST /preflight"]);
  });

  it("updates the saved configuration it started from, and says which save a button makes", async () => {
    stubBrowser();
    const calls = stubControlPlane({ ...BASE_ROUTES, "GET /configurations": [{ id: "cfg-7", name: "Nightly" }], "GET /configurations/cfg-7": { id: "cfg-7", name: "Nightly", config: SCRIPTED_AUDIT },
      "PUT /configurations/cfg-7": ({ body }: { body: { name: string; config: unknown } }) => ({ id: "cfg-7", name: body.name, config: body.config }) });
    visit("?page=new-run&from=config:cfg-7");
    render(<App />);
    expect(await screen.findByRole("button", { name: "save changes and start" })).toBeTruthy();
    expect(screen.getByText(/Saving updates the saved configuration “Nightly”/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "save changes" }));
    expect(await screen.findByText("saved as configuration Nightly")).toBeTruthy();
    expect(calls).toContain("PUT /configurations/cfg-7");
    fireEvent.change(screen.getByRole("textbox", { name: "configuration name" }), { target: { value: "Nightly copy" } });
    expect(screen.getByRole("button", { name: "save and start" })).toBeTruthy();
  });

  it("asks before leaving with unsaved edits, and leaves only when told to discard them", async () => {
    stubBrowser();
    stubControlPlane({ ...BASE_ROUTES, "GET /runs": [] });
    visit("?page=new-run");
    render(<App />);
    fireEvent.change(await screen.findByRole("spinbutton", { name: "review rounds" }), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("link", { name: "Runs" }));
    const guard = await screen.findByRole("alertdialog", { name: "unsaved configuration" });
    await waitFor(() => expect(document.activeElement).toBe(within(guard).getByRole("button", { name: "keep editing" })));
    fireEvent.click(within(guard).getByRole("button", { name: "keep editing" }));
    expect(address().get("page")).toBe("new-run");
    fireEvent.click(screen.getByRole("link", { name: "Runs" }));
    fireEvent.click(within(await screen.findByRole("alertdialog", { name: "unsaved configuration" })).getByRole("button", { name: "discard changes" }));
    expect(await screen.findByText("no runs yet")).toBeTruthy();
  });

  it("guards a browser back step and a reload the same way, and discarding completes the step", async () => {
    stubBrowser();
    stubControlPlane({ ...BASE_ROUTES, "GET /runs": [] });
    render(<App />);
    fireEvent.click(within(await screen.findByRole("navigation", { name: "main" })).getByRole("link", { name: "New run" }));
    fireEvent.change(await screen.findByRole("spinbutton", { name: "review rounds" }), { target: { value: "3" } });
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    act(() => window.history.back());
    const guard = await screen.findByRole("alertdialog", { name: "unsaved configuration" });
    expect(address().get("page")).toBe("new-run");
    fireEvent.click(within(guard).getByRole("button", { name: "discard changes" }));
    expect(await screen.findByText("no runs yet")).toBeTruthy();
    expect(window.location.search).toBe("");
    const after = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it("keeps what is typed into a path list, and records only the parsed paths", async () => {
    stubBrowser();
    stubControlPlane(BASE_ROUTES);
    visit("?page=new-run");
    render(<App />);
    fireEvent.change(await screen.findByRole("combobox", { name: "scope" }), { target: { value: "module" } });
    const modules = screen.getByRole("textbox", { name: "modules" }) as HTMLTextAreaElement;
    fireEvent.change(modules, { target: { value: "src\n" } });
    expect(modules.value).toBe("src\n");
    fireEvent.change(modules, { target: { value: "src\n  packages/api  \n" } });
    expect(modules.value).toBe("src\n  packages/api  \n");
    expect((screen.getByRole("textbox", { name: "configuration JSON" }) as HTMLTextAreaElement).value).toContain('"modules": [\n      "src",\n      "packages/api"\n    ]');
  });

  it("refuses to apply JSON edits made over a configuration the form has since changed", async () => {
    stubBrowser();
    stubControlPlane(BASE_ROUTES);
    visit("?page=new-run");
    render(<App />);
    const json = await screen.findByRole("textbox", { name: "configuration JSON" }) as HTMLTextAreaElement;
    fireEvent.change(json, { target: { value: json.value.replace('"maxConsensusRounds": 2', '"maxConsensusRounds": 1') } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "review rounds" }), { target: { value: "3" } });
    expect(await screen.findByText("the form changed after these JSON edits began · applying them is refused")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "apply JSON" }));
    expect(screen.getByRole("alert").textContent).toContain("discard them and edit again");
    expect((screen.getByRole("spinbutton", { name: "review rounds" }) as HTMLInputElement).value).toBe("3");
    fireEvent.click(screen.getByRole("button", { name: "discard JSON edits" }));
    expect(json.value).toContain('"maxConsensusRounds": 3');
  });

  it("reruns a finished run against the repository it read", async () => {
    stubBrowser();
    stubControlPlane({ ...BASE_ROUTES, "GET /runs/run-1/overview": overview({ repository: "/work/other" }) });
    visit("?page=new-run&from=run:run-1");
    render(<App />);
    await waitFor(() => expect((screen.getByRole("textbox", { name: "repository path" }) as HTMLInputElement).value).toBe("/work/other"));
    expect(screen.getByText("Starting from the settings run run-1 was created with.")).toBeTruthy();
  });

  it("starts from a saved workflow graph with interactive checkpoints", async () => {
    stubBrowser();
    stubControlPlane({ ...BASE_ROUTES, "GET /workflows": { graphs: [{ graphId: "reviewed", versions: [{ graphId: "reviewed", version: "abc123", parentVersion: null, savedAt: "2026-09-29T09:00:00.000Z", authorizations: [] }] }], templates: [AUDIT_DEEP] } });
    visit("?page=new-run&graph=reviewed@abc123");
    render(<App />);
    await waitFor(() => expect((screen.getByRole("combobox", { name: "workflow" }) as HTMLSelectElement).value).toBe("graph:reviewed:abc123"));
    expect((screen.getByRole("combobox", { name: "checkpoints" }) as HTMLSelectElement).value).toBe("interactive");
    expect(screen.getByText("Starting from saved graph reviewed @ abc123.")).toBeTruthy();
  });
});
