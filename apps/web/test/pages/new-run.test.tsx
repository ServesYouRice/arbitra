// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/app/App.js";
import { getIn, lines, placeholders, roleSlots, setIn, withGraph, withPreset, withScopeKind } from "../../src/pages/new-run/draft.js";
import { SCRIPTED_AUDIT, TEMPLATES } from "../../src/pages/new-run/templates.js";
import { offeredCatalog, withStrongestOffered } from "../../src/pages/new-run/model-catalog.js";
import { address, json, stubBrowser, stubControlPlane, visit } from "../support.js";
import { artifactRoutes, overview, resource } from "./fixtures.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); visit(""); localStorage.clear(); });
const template = (id: string) => { const found = TEMPLATES.find((item) => item.id === id); if (found === undefined) throw new Error(`no template ${id}`); return found; };
const AUDIT_THREE_FINDERS = { schemaVersion: 1, id: "audit-three-finders", goal: { objective: "Audit", doneWhen: [], stopWhen: [], blockedWhen: [] }, entryNodeId: "preflight",
  nodes: ["preflight", "auditor-a", "auditor-b", "consensus"].map((id) => ({ id, kind: id.startsWith("auditor") ? "model" : id === "consensus" ? "loop" : "deterministic", label: id === "preflight" ? "Preflight" : id === "consensus" ? "Consensus" : `Auditor ${id.slice(-1).toUpperCase()}`, goal: { objective: id, doneWhen: [], stopWhen: [], blockedWhen: [] } })),
  edges: [["preflight", "auditor-a"], ["preflight", "auditor-b"], ["auditor-a", "consensus"], ["auditor-b", "consensus"]].map(([from, to]) => ({ id: `${from}-${to}`, from, to })) };
const BASE_ROUTES = { "GET /configurations": [], "GET /repositories/selected": { repository: "/work/fixture" }, "GET /workflows": { graphs: [], templates: [AUDIT_THREE_FINDERS] } };
/** A project of four files: a folder of each, one test and one generated file. */
const FILES = [
  { path: "mobile/lib/app.dart", lines: 400, test: false, leftOut: false }, { path: "mobile/lib/db.g.dart", lines: 200, test: false, leftOut: false },
  { path: "server/main.go", lines: 300, test: false, leftOut: false }, { path: "server/main_test.go", lines: 100, test: true, leftOut: false },
];
/** This computer as the October 25 probe saw it, with Claude Code missing and Argon offered. */
const ENVIRONMENT = { build: "test", checkedAt: "2026-10-25T10:21:00.000Z", apiKeys: {}, clis: [
  { transport: "claude-code-cli", name: "Claude Code", path: null, version: "2.1.310", state: "not_installed", note: "not found", fix: "Install Claude Code." },
  { transport: "codex-cli", name: "Codex CLI", path: "C:/bin/codex.cmd", version: "0.162.1", state: "ready", note: "signed in", fix: null },
  { transport: "antigravity-cli", name: "Antigravity CLI", path: "C:/bin/agy.exe", version: "1.4.7", state: "ready", note: "ready", fix: null,
    models: [{ id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" }, { id: "gemini-4-argon", name: "Gemini 4 Argon" }, { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6" }] },
] };
const SUGGESTED = [{ path: "mobile/lib/db.g.dart", lines: 200, reason: "its first lines say: // GENERATED CODE - DO NOT MODIFY BY HAND" }];
const READY = { valid: true, ready: true, mode: "audit", preset: "audit-two-finders", modelBacked: true, diagnostics: [], repository: "/work/fixture", estimateError: null,
  estimate: { estimate: { files: 4, lines: 1000, nodes: 7, auditors: 2, providerCalls: null, costUsd: null, currency: null, basis: "configured_models_cost_unknown_without_pricing_and_outputs" },
    read: { complete: true, files: FILES }, suggestedLeaveOut: [], gate: "clear" } };

describe("configuration drafts", () => {
  it("edits nested values without mutating the draft, and removes a key set to undefined", () => {
    const edited = setIn(SCRIPTED_AUDIT, ["workflow", "modelExecution", "maximumTokens"], 1000);
    expect(getIn(edited, ["workflow", "modelExecution", "maximumTokens"])).toBe(1000);
    expect(getIn(SCRIPTED_AUDIT, ["workflow", "modelExecution"])).toBeUndefined();
    expect(getIn(setIn(edited, ["workflow", "modelExecution"], undefined), ["workflow"])).toEqual({ preset: "audit-three-finders" });
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
    expect(roleSlots(template("subscription-audit").config).map(({ path }) => path.join("."))).toEqual(["workflow.modelExecution.roles.planner", "workflow.modelExecution.roles.verifier", "workflow.modelExecution.roles.mediumVerifier", "workflow.modelExecution.roles.critic", "workflow.modelExecution.roles.variantSearcher"]);
    expect(roleSlots(template("subscription-feature-interactive").config).map(({ label, multiple }) => `${label}${multiple ? "[]" : ""}`)).toEqual(["requirements", "exploration", "planner", "reviewers[]", "critic"]);
    expect(roleSlots(template("testing-execute").config).map(({ label }) => label)).toEqual(["analyst", "planner", "fast writer", "balanced writer", "frontier writer"]);
    expect(roleSlots(template("testing-plan").config).map(({ label }) => label)).toEqual(["analyst", "planner"]);
  });

  it("lists every value a template leaves to fill in, by path", () => {
    expect(placeholders(SCRIPTED_AUDIT)).toEqual([]);
    // The subscription templates come with the recommended models chosen; the API-key ones leave them open.
    expect(placeholders(template("subscription-audit").config)).toEqual([]);
    expect(placeholders(template("audit-mixed-providers").config)).toEqual(["models.auditor-a.modelId", "models.auditor-a.family", "models.auditor-b.modelId", "models.auditor-b.family", "models.auditor-c.modelId", "models.auditor-c.family"]);
    expect(placeholders(template("testing-execute").config)).toEqual(expect.arrayContaining(["workflow.testing.goal", "workflow.testing.execution.verification.execution.image"]));
  });

  it("adds the Gemini models this machine's CLI offers, Argon first, and moves an untouched template to it", () => {
    const offered = { "antigravity-cli": [{ id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" }, { id: "gemini-4-argon", name: "Gemini 4 Argon" }, { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6" }] };
    expect(offeredCatalog("antigravity-cli", offered)?.map(({ modelId }) => modelId)).toEqual(["gemini-4-argon", "gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low"]);
    const audit = template("subscription-audit-gemini").config;
    expect(getIn(withStrongestOffered(audit, offered), ["models", "auditor-c", "modelId"])).toBe("gemini-4-argon");
    expect(withStrongestOffered(audit, { "antigravity-cli": [] })).toBe(audit);
  });

  it("offers every model-backed template, each in the mode it says", () => {
    expect(TEMPLATES.map(({ id }) => id)).toEqual(["subscription-audit", "subscription-audit-gemini", "scripted-audit", "audit-mixed-providers", "audit-compatible-chat", "subscription-feature-interactive", "subscription-feature-automatic", "feature-interactive", "feature-automatic", "subscription-testing-plan", "subscription-testing-execute", "testing-plan", "testing-execute"]);
    for (const { mode, config } of TEMPLATES) expect(config["mode"]).toBe(mode);
  });
});


const project = (path: string) => fireEvent.change(screen.getByRole("combobox", { name: "project folder" }), { target: { value: path } });
const checked = (name: string) => (screen.getByRole("checkbox", { name }) as HTMLInputElement).checked;
const leftOutPaths = () => (screen.getByRole("textbox", { name: "left out paths" }) as HTMLTextAreaElement).value;
/** The check reads the project a moment after the last change. */
const AFTER_CHECK = { timeout: 3_000 };
type Body = { config: Record<string, unknown>; repository?: string };

describe("the new-run page", () => {
  it("opens on Claude Code and Codex at deep, with no project chosen and Gemini left out", async () => {
    stubBrowser();
    stubControlPlane(BASE_ROUTES);
    visit("?page=new-run");
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "New audit" })).toBeTruthy();
    await screen.findByRole("radio", { name: "Deep" });
    // The server's own folder is not a project (inventory, October 25, 2026): the field starts empty.
    expect((screen.getByRole("combobox", { name: "project folder" }) as HTMLInputElement).value).toBe("");
    expect((screen.getByRole("button", { name: "Start audit" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Choose the project first.")).toBeTruthy();
    expect((screen.getByRole("radio", { name: "Deep" }) as HTMLInputElement).checked).toBe(true);
    const deep = screen.getByRole("radio", { name: "Deep" }).closest(".lineup-card");
    expect(deep?.textContent).toContain("Opus 5.5 · xhigh");
    expect(deep?.textContent).toContain("second opinion GPT-6.1 Sol · high");
    expect(screen.getByRole("radio", { name: "Balanced" }).closest(".lineup-card")?.textContent).toContain("medium Sonnet 5.5 · high");
    expect((screen.getByRole("combobox", { name: "model for auditor-a" }) as HTMLSelectElement).value).toBe("claude-opus-5-5");
    expect(screen.queryByRole("combobox", { name: "model for auditor-c" })).toBeNull();
    expect(checked("add a third finder")).toBe(false);
    expect(screen.queryByRole("list", { name: "placeholders to fill in" })).toBeNull();
  });

  it("reads the project once it is chosen, and says what each depth will use and on what basis", async () => {
    stubBrowser();
    const bodies: Body[] = [];
    stubControlPlane({ ...BASE_ROUTES, "POST /preflight": ({ body }: { body: Body }) => { bodies.push(body); return READY; } });
    visit("?page=new-run");
    render(<App />);
    await screen.findByRole("radio", { name: "Deep" });
    project("/work/fixture");
    expect(await screen.findByText("Ready to start.", {}, AFTER_CHECK)).toBeTruthy();
    expect(bodies).toEqual([{ config: template("subscription-audit").config, repository: "/work/fixture" }]);
    expect(screen.getByText("4 source files · 1,000 lines, 100 of them tests")).toBeTruthy();
    const deep = screen.getByRole("radio", { name: "Deep" }).closest(".lineup-card")?.textContent ?? "";
    expect(deep).toContain("≈ 600K–700K tokens");
    expect(deep).toContain("Claude Code ≈ 522K–609K · Codex ≈ 78K–91K");
    expect(deep).toContain("time not measured at this size: the smallest measured, commentanywhere, 11,719 lines, took 40 min");
    expect(deep).toContain("basis: 3 measured runs, 605–688 tokens a line");
    // The whole basis is one click down, below the cards.
    expect(screen.getByText("How the estimates are made").closest("details")?.textContent).toContain("basis: 3 runs at deep on October 23 and 24, 11,719 to 38,967 lines");
    expect(screen.getByRole("radio", { name: "Cheap" }).closest(".lineup-card")?.textContent).toContain("not measured yet");
  });

  it("leaves a folder out with one tick and the tests with another, and counts them without reading the project again", async () => {
    stubBrowser();
    const calls = stubControlPlane({ ...BASE_ROUTES, "POST /preflight": READY });
    visit("?page=new-run");
    render(<App />);
    await screen.findByRole("radio", { name: "Deep" });
    project("/work/fixture");
    const folders = await screen.findByRole("table", { name: "folders" }, AFTER_CHECK);
    expect(within(folders).getAllByRole("row").slice(1).map(({ textContent }) => textContent)).toEqual(["mobile260060%", "server240040%"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "read mobile" }));
    expect(within(folders).getAllByRole("row").slice(1).map(({ textContent }) => textContent)).toEqual(["mobile2600left out", "server2400100%"]);
    expect(screen.getByText("2 source files · 400 lines, 100 of them tests")).toBeTruthy();
    expect(checked("audit the tests")).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "audit the tests" }));
    expect(leftOutPaths()).toBe("mobile\nserver/main_test.go");
    expect(screen.getByText("1 source file · 300 lines")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "audit the tests" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "read mobile" }));
    expect(leftOutPaths()).toBe("");
    await new Promise((resolve) => { setTimeout(resolve, 900); });
    expect(calls.filter((call) => call === "POST /preflight")).toHaveLength(1);
  });

  it("leaves the files that look generated out, each with its reason, and reads one anyway when it is unticked", async () => {
    stubBrowser();
    const bodies: Body[] = [];
    stubControlPlane({ ...BASE_ROUTES, "POST /preflight": ({ body }: { body: Body }) => { bodies.push(body); return { ...READY, estimate: { ...READY.estimate, suggestedLeaveOut: SUGGESTED } }; } });
    visit("?page=new-run");
    render(<App />);
    await screen.findByRole("radio", { name: "Deep" });
    project("/work/fixture");
    const generated = await screen.findByRole("list", { name: "generated files" }, AFTER_CHECK);
    // Closed by default: one line per file, its reason and its lines.
    expect(generated.closest("details")?.open).toBe(false);
    expect(generated.closest("details")?.querySelector("summary")?.textContent).toBe("Left out · 1 generated file · 200 lines");
    expect(generated.textContent).toBe("mobile/lib/db.g.dartits first lines say: // GENERATED CODE - DO NOT MODIFY BY HAND200");
    expect(checked("leave out mobile/lib/db.g.dart")).toBe(true);
    expect(leftOutPaths()).toBe("mobile/lib/db.g.dart");
    // Leaving it out is the check's own setting: the page is not edited by it.
    expect(screen.getByText("3 source files · 800 lines, 100 of them tests")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "leave out mobile/lib/db.g.dart" }));
    expect(leftOutPaths()).toBe("");
    // A later check does not leave it out again.
    fireEvent.click(screen.getByRole("radio", { name: "Balanced" }));
    await waitFor(() => expect(bodies).toHaveLength(2), AFTER_CHECK);
    expect(getIn(bodies[1]?.config ?? {}, ["scope", "exclude"])).toBeUndefined();
    expect(leftOutPaths()).toBe("");
  });

  it("sets the depth, the third finder and each step as a choice of its own, with the plan review recommended off and why", async () => {
    stubBrowser();
    const bodies: Body[] = [];
    stubControlPlane({ ...BASE_ROUTES, "POST /preflight": ({ body }: { body: Body }) => { bodies.push(body); return READY; } });
    visit("?page=new-run&from=template:subscription-audit");
    render(<App />);
    fireEvent.click(await screen.findByRole("radio", { name: "Cheap" }));
    expect((screen.getByRole("radio", { name: "Cheap" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "add a third finder" }));
    expect(screen.getByRole("radio", { name: "Cheap" }).closest(".lineup-card")?.textContent).toContain("Gemini 3.8 Flash · high");
    const steps = screen.getByRole("list", { name: "steps" });
    expect(within(steps).getAllByRole("listitem").map((item) => item.querySelector(".step__name")?.textContent)).toEqual(["Find issuesalways", "Merge duplicates", "Review roundrecommended off", "Check each issuealways", "Second opinion", "Search for variants", "Write the planalways", "Review the planrecommended off"]);
    expect(steps.textContent).toContain("it caught 1 of the 21 plan errors met when the plan was carried out");
    expect(checked("Review the plan")).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: "Review the plan" }));
    fireEvent.click(screen.getByRole("radio", { name: "Critical and high issues only" }));
    project("/work/fixture");
    await waitFor(() => expect(bodies).toHaveLength(1), AFTER_CHECK);
    const sent = bodies[0]?.config ?? {};
    expect([sent["auditDepth"], getIn(sent, ["workflow", "preset"]), getIn(sent, ["workflow", "critic"]), getIn(sent, ["models", "auditor-c", "modelId"]), getIn(sent, ["models", "auditor-a", "modelId"]), getIn(sent, ["workflow", "modelExecution", "planScope", "minimumSeverity"])])
      .toEqual(["cheap", "audit-three-finders", true, "gemini-3.8-flash-high", "claude-sonnet-5-5", "high"]);
  });

  it("offers the variant search as a step, off by default, with Sonnet searching or Gemini when it is a finder", async () => {
    stubBrowser();
    const bodies: Body[] = [];
    stubControlPlane({ ...BASE_ROUTES, "POST /preflight": ({ body }: { body: Body }) => { bodies.push(body); return READY; } });
    visit("?page=new-run&from=template:subscription-audit");
    render(<App />);
    await screen.findByRole("radio", { name: "Deep" });
    expect(checked("Search for variants")).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: "Search for variants" }));
    project("/work/fixture");
    await waitFor(() => expect(bodies).toHaveLength(1), AFTER_CHECK);
    const sent = bodies[0]?.config ?? {};
    expect([getIn(sent, ["workflow", "variantSearch"]), getIn(sent, ["workflow", "modelExecution", "roles", "variantSearcher"]), getIn(sent, ["models", "variant-searcher", "modelId"]), getIn(sent, ["workflow", "modelExecution", "stageEffort", "variantSearch"])])
      .toEqual([true, "variant-searcher", "claude-sonnet-5-5", "high"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "add a third finder" }));
    await waitFor(() => expect(getIn(bodies.at(-1)?.config ?? {}, ["workflow", "modelExecution", "roles", "variantSearcher"])).toBe("auditor-c"), AFTER_CHECK);
    expect(getIn(bodies.at(-1)?.config ?? {}, ["models", "variant-searcher"])).toBeUndefined();
  });

  it("says in words why the project cannot be read, keeps the code one click down, and does not call it ready", async () => {
    stubBrowser();
    let answer: unknown = { ...READY, ready: false, estimate: null, estimateError: "REPOSITORY_FILE_LIMIT_EXCEEDED:1000" };
    stubControlPlane({ ...BASE_ROUTES, "POST /preflight": () => answer });
    visit("?page=new-run");
    render(<App />);
    await screen.findByRole("radio", { name: "Deep" });
    project("/work/fixture");
    expect(await screen.findByText(/^The project has more than 1,000 source files, more than one run reads\./u, {}, AFTER_CHECK)).toBeTruthy();
    expect(screen.getByText("REPOSITORY_FILE_LIMIT_EXCEEDED:1000").closest("details")).toBeTruthy();
    expect(screen.queryByText("Ready to start.")).toBeNull();
    expect(screen.getByText("Not ready: the project could not be read (above).")).toBeTruthy();
    answer = json({ statusCode: 404, error: "Not Found", message: "REPOSITORY_NOT_FOUND:/work/absent" }, 404);
    project("/work/absent");
    expect(await screen.findByText("There is no folder at /work/absent.", {}, AFTER_CHECK)).toBeTruthy();
  });

  it("lists the folders of a project over the file limit, and reads it again once folders are left out", async () => {
    stubBrowser();
    const bodies: Body[] = [];
    const over = { ...READY, ready: false, estimate: null, estimateError: "REPOSITORY_FILE_LIMIT_EXCEEDED:1000",
      folders: { complete: true, folders: [{ path: "app", files: 700 }, { path: "vendor", files: 301 }, { path: "", files: 1 }] } };
    // Once it fits, the folders it leaves out are not listed: the whole project is still more than a run reads.
    const fits = { ...READY, estimate: { ...READY.estimate, read: { complete: false, files: FILES } } };
    stubControlPlane({ ...BASE_ROUTES, "POST /preflight": ({ body }: { body: Body }) => { bodies.push(body); return bodies.length === 2 ? fits : over; } });
    visit("?page=new-run");
    render(<App />);
    await screen.findByRole("radio", { name: "Deep" });
    project("/work/fixture");
    const folders = await screen.findByRole("table", { name: "folders" }, AFTER_CHECK);
    expect(within(folders).getAllByRole("row").slice(1).map(({ textContent }) => textContent)).toEqual(["app700", "vendor301", "files at the top1"]);
    expect(screen.getByText("1,002 source files: a run reads at most 1,000. Leave out folders until it fits.")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "read vendor" }));
    expect(screen.getByText("701 source files with these folders left out: that fits.")).toBeTruthy();
    expect(await screen.findByText("Ready to start.", {}, AFTER_CHECK)).toBeTruthy();
    expect(getIn(bodies[1]?.config ?? {}, ["scope", "exclude"])).toEqual(["vendor"]);
    // The folder left out stays a row, ticked back in to read the project again.
    expect(within(screen.getByRole("table", { name: "folders" })).getAllByRole("row").at(-1)?.textContent).toBe("vendornot countedleft out");
    fireEvent.click(screen.getByRole("checkbox", { name: "read vendor" }));
    await waitFor(() => expect(bodies).toHaveLength(3), AFTER_CHECK);
    expect(getIn(bodies[2]?.config ?? {}, ["scope", "exclude"])).toBeUndefined();
  });

  it("names what this computer lacks in one line beside Start, pointing up, with the recorded codes one click down", async () => {
    stubBrowser();
    stubControlPlane({ ...BASE_ROUTES, "GET /diagnostics/environment": ENVIRONMENT,
      "POST /preflight": { ...READY, ready: false, diagnostics: [{ code: "SUBSCRIPTION_CLI_NOT_INSTALLED:claude-code", severity: "error", scope: "environment", path: "$environment", message: "Claude Code is not available." },
        { code: "SUBSCRIPTION_CLI_UNVERIFIED:antigravity-cli", severity: "warning", scope: "configuration", path: "workflow", message: "Antigravity support is declared but not yet verified." }] } });
    visit("?page=new-run");
    render(<App />);
    await screen.findByRole("radio", { name: "Deep" });
    const computer = await screen.findByRole("table", { name: "CLIs on this computer" });
    expect(within(computer).getAllByRole("row").map(({ textContent }) => textContent)).toEqual([
      "Claude Code 2.1.310not installedhow to fixInstall Claude Code.in this lineup", "Codex CLI 0.162.1signed inin this lineup", "Antigravity CLI 1.4.7readyoffers Gemini 3.8 Flash (High), Gemini 4 Argonnot in this lineup"]);
    project("/work/fixture");
    const result = await screen.findByRole("region", { name: "check result" }, AFTER_CHECK);
    expect(within(result).getByText("Not ready: Claude Code is not installed; see This computer above.")).toBeTruthy();
    // This computer's problem is not repeated; its code, and the check's note, are one click down.
    expect(result.textContent).not.toContain("Claude Code is not available.");
    expect(within(result).getByText("SUBSCRIPTION_CLI_NOT_INSTALLED:claude-code").closest("details")?.querySelector("summary")?.textContent).toBe("recorded codes, and 1 note from the check");
  });

  it("changes a step's model and effort in place, marks the depth changed, and resets it from the card", async () => {
    stubBrowser();
    const bodies: Body[] = [];
    stubControlPlane({ ...BASE_ROUTES, "POST /preflight": ({ body }: { body: Body }) => { bodies.push(body); return READY; } });
    visit("?page=new-run");
    render(<App />);
    await screen.findByRole("radio", { name: "Deep" });
    const planner = screen.getByRole("combobox", { name: "model: write the plan" }) as HTMLSelectElement;
    expect(planner.value).toBe("t:claude-code-cli|claude-opus-5-5");
    // Gemini is never offered for a core step.
    expect([...planner.options].map(({ value }) => value).some((value) => value.includes("antigravity"))).toBe(false);
    fireEvent.change(planner, { target: { value: "t:claude-code-cli|claude-sonnet-5-5" } });
    fireEvent.change(screen.getByRole("combobox", { name: "effort: write the plan" }), { target: { value: "max" } });
    expect(screen.getByRole("radio", { name: "Deep" }).closest(".lineup-card")?.textContent).toContain("Deep, changed");
    expect(screen.getByRole("radio", { name: "Deep" }).closest(".lineup-card")?.textContent).toContain("Sonnet 5.5 · max");
    project("/work/fixture");
    await waitFor(() => expect(bodies).toHaveLength(1), AFTER_CHECK);
    const sent = bodies[0]?.config ?? {};
    const plans = String(getIn(sent, ["workflow", "modelExecution", "roles", "planner"]));
    expect([getIn(sent, ["models", plans, "modelId"]), getIn(sent, ["models", "auditor-a", "modelId"]), getIn(sent, ["workflow", "modelExecution", "stageEffort", "planner", plans])]).toEqual(["claude-sonnet-5-5", "claude-opus-5-5", "max"]);
    fireEvent.click(screen.getByRole("button", { name: "reset to deep" }));
    expect(screen.getByRole("radio", { name: "Deep" }).closest(".lineup-card")?.textContent).not.toContain("changed");
    expect((screen.getByRole("combobox", { name: "model: write the plan" }) as HTMLSelectElement).value).toBe("t:claude-code-cli|claude-opus-5-5");
  });

  it("takes any model the lineup reaches as the third finder, Argon first when Antigravity offers it, and says it is not measured", async () => {
    stubBrowser();
    const bodies: Body[] = [];
    stubControlPlane({ ...BASE_ROUTES, "GET /diagnostics/environment": ENVIRONMENT, "POST /preflight": ({ body }: { body: Body }) => { bodies.push(body); return READY; } });
    visit("?page=new-run");
    render(<App />);
    await screen.findByRole("table", { name: "CLIs on this computer" });
    fireEvent.click(screen.getByRole("checkbox", { name: "add a third finder" }));
    const third = screen.getByRole("combobox", { name: "model: third finder" }) as HTMLSelectElement;
    expect(third.value).toBe("t:antigravity-cli|gemini-3.8-flash");
    expect([...third.options].map(({ textContent }) => textContent).slice(0, 3)).toEqual(["Gemini 4 Argon (strongest, offered by your CLI, not measured)", "Gemini 3.8 Flash", "Opus 5.5 (strongest, slowest)"]);
    expect([...third.options].at(-1)?.textContent).toBe("another model: an OpenAI-compatible endpoint…");
    fireEvent.change(third, { target: { value: "t:antigravity-cli|gemini-4-argon" } });
    expect(screen.getByText(/this model as a third finder is not measured/u)).toBeTruthy();
    expect(screen.getByText(/Through Antigravity: Google's terms/u)).toBeTruthy();
    project("/work/fixture");
    await waitFor(() => expect(bodies).toHaveLength(1), AFTER_CHECK);
    expect([getIn(bodies[0]?.config ?? {}, ["models", "auditor-c", "modelId"]), getIn(bodies[0]?.config ?? {}, ["workflow", "preset"])]).toEqual(["gemini-4-argon", "audit-three-finders"]);
  });

  it("takes a model the person names as the third finder: Kimi through Moonshot's OpenAI-compatible endpoint", async () => {
    stubBrowser();
    const bodies: Body[] = [];
    stubControlPlane({ ...BASE_ROUTES, "POST /preflight": ({ body }: { body: Body }) => { bodies.push(body); return READY; } });
    visit("?page=new-run");
    render(<App />);
    await screen.findByRole("radio", { name: "Deep" });
    fireEvent.click(screen.getByRole("checkbox", { name: "add a third finder" }));
    fireEvent.change(screen.getByRole("combobox", { name: "model: third finder" }), { target: { value: "add another model" } });
    const form = screen.getByRole("group", { name: "another model: third finder" });
    expect([(within(form).getByRole("textbox", { name: "base URL: third finder" }) as HTMLInputElement).value, (within(form).getByRole("textbox", { name: "key variable: third finder" }) as HTMLInputElement).value])
      .toEqual(["https://api.moonshot.ai/v1", "ARBITRA_MOONSHOT_API_KEY"]);
    expect((within(form).getByRole("button", { name: "use it" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(form).getByRole("textbox", { name: "model ID: third finder" }), { target: { value: "kimi-3.1" } });
    fireEvent.click(within(form).getByRole("button", { name: "use it" }));
    const third = screen.getByRole("combobox", { name: "model: third finder" }) as HTMLSelectElement;
    expect([third.value, third.selectedOptions[0]?.textContent]).toEqual(["e:moonshot|kimi-3.1", "kimi-3.1 (not measured)"]);
    expect(screen.getByText(/this model as a third finder is not measured/u)).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Deep" }).closest(".lineup-card")?.textContent).toContain("kimi-3.1 · high");
    project("/work/fixture");
    await waitFor(() => expect(bodies).toHaveLength(1), AFTER_CHECK);
    const sent = bodies[0]?.config ?? {};
    expect([getIn(sent, ["models", "auditor-c", "transport"]), getIn(sent, ["models", "auditor-c", "modelId"]), getIn(sent, ["workflow", "modelExecution", "modelEndpoints", "auditor-c"])]).toEqual(["openai-chat", "kimi-3.1", "moonshot"]);
    expect(getIn(sent, ["workflow", "modelExecution", "endpoints"])).toContainEqual({ id: "moonshot", providerId: "moonshot", transport: "openai-chat", endpoint: "https://api.moonshot.ai/v1", apiKeyEnvVar: "ARBITRA_MOONSHOT_API_KEY" });
  });

  it("reaches the same depths through API keys, and says a model with no API equivalent on its card", async () => {
    stubBrowser();
    const bodies: Body[] = [];
    stubControlPlane({ ...BASE_ROUTES, "GET /diagnostics/environment": ENVIRONMENT, "POST /preflight": ({ body }: { body: Body }) => { bodies.push(body); return READY; } });
    visit("?page=new-run");
    render(<App />);
    await screen.findByRole("table", { name: "CLIs on this computer" });
    fireEvent.click(screen.getByRole("checkbox", { name: "add a third finder" }));
    fireEvent.change(screen.getByRole("combobox", { name: "model: third finder" }), { target: { value: "t:antigravity-cli|gemini-4-argon" } });
    fireEvent.click(screen.getByRole("radio", { name: "API keys" }));
    expect(within(screen.getByRole("radiogroup", { name: "models run through" })).getByText(/ARBITRA_ANTHROPIC_API_KEY, ARBITRA_OPENAI_API_KEY, ARBITRA_GEMINI_API_KEY/u)).toBeTruthy();
    expect(within(screen.getByRole("table", { name: "CLIs on this computer" })).getByText(/read from ARBITRA_ANTHROPIC_API_KEY/u)).toBeTruthy();
    const deep = screen.getByRole("radio", { name: "Deep" }).closest(".lineup-card")?.textContent ?? "";
    expect(deep).toContain("Opus 5.5 · xhigh");
    expect(deep).toContain("Gemini 4 Argon · not offered through an API key");
    fireEvent.click(screen.getByRole("radio", { name: "Cheap" }));
    project("/work/fixture");
    await waitFor(() => expect(bodies).toHaveLength(1), AFTER_CHECK);
    const sent = bodies[0]?.config ?? {};
    expect([getIn(sent, ["models", "auditor-a", "transport"]), getIn(sent, ["models", "auditor-a", "modelId"]), getIn(sent, ["models", "auditor-b", "transport"])]).toEqual(["anthropic-messages", "claude-sonnet-5-5", "openai-responses"]);
  });

  it("starts the run from this project's last start, saved, and opens it", async () => {
    stubBrowser();
    const calls = stubControlPlane({ ...BASE_ROUTES, "POST /preflight": READY,
      "POST /configurations": ({ body }: { body: { name: string; config: unknown } }) => { expect(body.name).toBe("last start · fixture"); return { id: "cfg-1", name: body.name, config: body.config }; },
      "POST /runs": ({ body }: { body: unknown }) => { expect(body).toEqual({ configurationId: "cfg-1", repository: "/work/fixture" }); return resource({ runId: "run-new", state: "CREATED" }); },
      "GET /runs/run-new": resource({ runId: "run-new" }), "GET /runs/run-new/overview": overview({ runId: "run-new" }), ...artifactRoutes("run-new") });
    visit("?page=new-run");
    render(<App />);
    await screen.findByRole("radio", { name: "Deep" });
    project("/work/fixture");
    await screen.findByText("Ready to start.", {}, AFTER_CHECK);
    fireEvent.click(screen.getByRole("button", { name: "Start audit" }));
    expect(await screen.findByRole("heading", { level: 1, name: "fixture · audit" })).toBeTruthy();
    expect(address().get("run")).toBe("run-new");
    expect(calls.filter((call) => call.startsWith("POST"))).toEqual(["POST /preflight", "POST /preflight", "POST /configurations", "POST /runs"]);
  });

  it("updates this project's last start rather than saving another", async () => {
    stubBrowser();
    const calls = stubControlPlane({ ...BASE_ROUTES, "GET /configurations": [{ id: "cfg-9", name: "last start · fixture" }], "POST /preflight": READY,
      "PUT /configurations/cfg-9": ({ body }: { body: { name: string; config: unknown } }) => ({ id: "cfg-9", name: body.name, config: body.config }),
      "POST /runs": resource({ runId: "run-new", state: "CREATED" }), "GET /runs/run-new": resource({ runId: "run-new" }), "GET /runs/run-new/overview": overview({ runId: "run-new" }), ...artifactRoutes("run-new") });
    visit("?page=new-run");
    render(<App />);
    await screen.findByRole("radio", { name: "Deep" });
    project("/work/fixture");
    await screen.findByText("Ready to start.", {}, AFTER_CHECK);
    fireEvent.click(screen.getByRole("button", { name: "Start audit" }));
    await screen.findByRole("heading", { level: 1, name: "fixture · audit" });
    expect(calls).toContain("PUT /configurations/cfg-9");
    expect(calls).not.toContain("POST /configurations");
  });

  it("neither saves nor starts a lineup that fails the check", async () => {
    stubBrowser();
    const calls = stubControlPlane({ ...BASE_ROUTES, "POST /preflight": { ...READY, valid: false, ready: false, estimate: null, diagnostics: [{ code: "MODEL_IDENTITY_PLACEHOLDER", severity: "error", scope: "configuration", path: "models.auditor-a.modelId", message: "Replace the placeholder." }] } });
    visit("?page=new-run");
    render(<App />);
    await screen.findByRole("radio", { name: "Deep" });
    project("/work/fixture");
    fireEvent.click(screen.getByRole("button", { name: "Start audit" }));
    expect(await screen.findByText("Not ready: 1 problem in the lineup.")).toBeTruthy();
    expect(calls.filter((call) => call.startsWith("POST") && call !== "POST /preflight")).toEqual([]);
  });

  it("saves the lineup under a name, and saves changes to the saved lineup it started from", async () => {
    stubBrowser();
    const calls = stubControlPlane({ ...BASE_ROUTES, "GET /configurations": [{ id: "cfg-7", name: "Nightly" }], "GET /configurations/cfg-7": { id: "cfg-7", name: "Nightly", config: SCRIPTED_AUDIT },
      "PUT /configurations/cfg-7": ({ body }: { body: { name: string; config: unknown } }) => ({ id: "cfg-7", name: body.name, config: body.config }),
      "POST /configurations": ({ body }: { body: { name: string; config: unknown } }) => ({ id: "cfg-8", name: body.name, config: body.config }) });
    visit("?page=new-run&from=config:cfg-7");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Save changes to “Nightly”" }));
    expect((screen.getByRole("textbox", { name: "lineup name" }) as HTMLInputElement).value).toBe("Nightly");
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    expect(await screen.findByText("saved as the lineup “Nightly”")).toBeTruthy();
    expect(calls).toContain("PUT /configurations/cfg-7");
    fireEvent.click(screen.getByRole("button", { name: "Save changes to “Nightly”" }));
    fireEvent.change(screen.getByRole("textbox", { name: "lineup name" }), { target: { value: "Nightly copy" } });
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    expect(await screen.findByText("saved as the lineup “Nightly copy”")).toBeTruthy();
    expect(calls).toContain("POST /configurations");
  });

  it("runs the scripted smoke test without models, and says so", async () => {
    stubBrowser();
    stubControlPlane({ ...BASE_ROUTES, "POST /preflight": { ...READY, modelBacked: false } });
    visit("?page=new-run&from=template:scripted-audit");
    render(<App />);
    expect(await screen.findByText("Scripted detectors")).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "lineup" }) as HTMLSelectElement).value).toBe("template:scripted-audit");
    expect(screen.queryByRole("list", { name: "steps" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "graph" }).parentElement?.textContent).toContain("Steps: Read the project → Find issues ×2 → Merge duplicates.");
    project("/work/fixture");
    expect(await screen.findByText("Ready to start. It calls no model: scripted detectors.", {}, AFTER_CHECK)).toBeTruthy();
  });

  it("lists what a template leaves open, and the list shrinks as values are filled in", async () => {
    stubBrowser();
    stubControlPlane(BASE_ROUTES);
    visit("?page=new-run&from=template:audit-mixed-providers");
    render(<App />);
    const list = await screen.findByRole("list", { name: "placeholders to fill in" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(6);
    fireEvent.change(screen.getByRole("combobox", { name: "model for auditor-a" }), { target: { value: "gpt-6-luna" } });
    await waitFor(() => expect(within(screen.getByRole("list", { name: "placeholders to fill in" })).getAllByRole("listitem")).toHaveLength(4));
    expect(screen.queryByRole("textbox", { name: "model ID for auditor-a" })).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "model for auditor-b" }), { target: { value: "other" } });
    fireEvent.change(screen.getByRole("textbox", { name: "model ID for auditor-b" }), { target: { value: "claude-next-preview" } });
    fireEvent.change(screen.getByRole("textbox", { name: "family for auditor-b" }), { target: { value: "claude" } });
    await waitFor(() => expect(within(screen.getByRole("list", { name: "placeholders to fill in" })).getAllByRole("listitem")).toHaveLength(2));
    expect((screen.getByRole("combobox", { name: "writes the plan" }) as HTMLSelectElement).value).toBe("auditor-a");
  });

  it("asks before leaving with unsaved edits, and leaves only when told to discard them", async () => {
    stubBrowser();
    stubControlPlane({ ...BASE_ROUTES, "GET /runs": [] });
    visit("?page=new-run");
    render(<App />);
    fireEvent.click(await screen.findByRole("radio", { name: "Balanced" }));
    fireEvent.click(screen.getByRole("link", { name: "Runs" }));
    const guard = await screen.findByRole("alertdialog", { name: "unsaved lineup" });
    await waitFor(() => expect(document.activeElement).toBe(within(guard).getByRole("button", { name: "keep editing" })));
    fireEvent.click(within(guard).getByRole("button", { name: "keep editing" }));
    expect(address().get("page")).toBe("new-run");
    fireEvent.click(screen.getByRole("link", { name: "Runs" }));
    fireEvent.click(within(await screen.findByRole("alertdialog", { name: "unsaved lineup" })).getByRole("button", { name: "discard changes" }));
    expect(await screen.findByText("no runs yet")).toBeTruthy();
  });

  it("guards a browser back step and a reload the same way, and discarding completes the step", async () => {
    stubBrowser();
    stubControlPlane({ ...BASE_ROUTES, "GET /runs": [] });
    render(<App />);
    fireEvent.click(within(await screen.findByRole("navigation", { name: "main" })).getByRole("link", { name: "New run" }));
    fireEvent.click(await screen.findByRole("radio", { name: "Balanced" }));
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    act(() => window.history.back());
    const guard = await screen.findByRole("alertdialog", { name: "unsaved lineup" });
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
    expect((screen.getByRole("textbox", { name: "lineup JSON" }) as HTMLTextAreaElement).value).toContain('"modules": [\n      "src",\n      "packages/api"\n    ]');
  });

  it("refuses to apply JSON edits made over a lineup the page has since changed", async () => {
    stubBrowser();
    stubControlPlane(BASE_ROUTES);
    visit("?page=new-run");
    render(<App />);
    const json = await screen.findByRole("textbox", { name: "lineup JSON" }) as HTMLTextAreaElement;
    fireEvent.change(json, { target: { value: json.value.replace('"maxConsensusRounds": 0', '"maxConsensusRounds": 2') } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Review round" }));
    expect(await screen.findByText("the page changed after these JSON edits began · applying them is refused")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "apply JSON" }));
    expect(screen.getByRole("alert").textContent).toContain("discard them and edit again");
    expect((screen.getByRole("spinbutton", { name: "review rounds" }) as HTMLInputElement).value).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "discard JSON edits" }));
    expect(json.value).toContain('"maxConsensusRounds": 1');
  });

  it("checks every place of a rejected merged issue only when asked", async () => {
    // Observed (P20 pilot): checking every place took 10 to 16% of a panel's tokens and confirmed 7 of 50, none a planted defect.
    stubBrowser();
    const bodies: Body[] = [];
    stubControlPlane({ ...BASE_ROUTES, "POST /preflight": ({ body }: { body: Body }) => { bodies.push(body); return READY; } });
    visit("?page=new-run&from=template:subscription-audit");
    render(<App />);
    expect((await screen.findByRole("checkbox", { name: "check every place of a rejected merged issue" }) as HTMLInputElement).checked).toBe(false);
    expect(template("subscription-audit").config["verification"]).not.toHaveProperty("reaskMergedPlaces");
    fireEvent.click(screen.getByRole("checkbox", { name: "check every place of a rejected merged issue" }));
    project("/work/fixture");
    await waitFor(() => expect(bodies).toHaveLength(1), AFTER_CHECK);
    expect(getIn(bodies[0]?.config ?? {}, ["verification", "reaskMergedPlaces"])).toBe("always");
  });

  it("reruns a finished run against the project it read", async () => {
    stubBrowser();
    stubControlPlane({ ...BASE_ROUTES, "GET /runs/run-1/overview": overview({ repository: "/work/other" }) });
    visit("?page=new-run&from=run:run-1");
    render(<App />);
    await waitFor(() => expect((screen.getByRole("combobox", { name: "project folder" }) as HTMLInputElement).value).toBe("/work/other"));
    expect((screen.getByRole("combobox", { name: "lineup" }) as HTMLSelectElement).value).toBe("run:run-1");
    expect(screen.getByText("Starting from the settings run run-1 was created with.")).toBeTruthy();
  });

  it("starts from a saved workflow graph that asks before going on", async () => {
    stubBrowser();
    stubControlPlane({ ...BASE_ROUTES, "GET /workflows": { graphs: [{ graphId: "reviewed", versions: [{ graphId: "reviewed", version: "abc123", parentVersion: null, savedAt: "2026-09-29T09:00:00.000Z", authorizations: [] }] }], templates: [AUDIT_THREE_FINDERS] } });
    visit("?page=new-run&graph=reviewed@abc123");
    render(<App />);
    await waitFor(() => expect((screen.getByRole("combobox", { name: "graph" }) as HTMLSelectElement).value).toBe("graph:reviewed:abc123"));
    expect((screen.getByRole("combobox", { name: "ask me before" }) as HTMLSelectElement).value).toBe("interactive");
    expect(screen.getByText("Starting from the saved graph reviewed @ abc123.")).toBeTruthy();
  });

  it("loads a saved lineup that names a preset by its earlier name, and says what it runs", async () => {
    stubBrowser();
    stubControlPlane({ ...BASE_ROUTES, "GET /configurations": [{ id: "cfg-8", name: "Old" }], "GET /configurations/cfg-8": { id: "cfg-8", name: "Old", config: { ...SCRIPTED_AUDIT, workflow: { preset: "audit-deep" } } } });
    visit("?page=new-run&from=config:cfg-8");
    render(<App />);
    await waitFor(() => expect((screen.getByRole("combobox", { name: "graph" }) as HTMLSelectElement).value).toBe("preset:audit-deep"));
    expect(screen.getByRole("option", { name: "audit-deep (the earlier name of audit-three-finders)" })).toBeTruthy();
    expect(await screen.findByText(/Steps: Read the project → Find issues ×2 → Merge duplicates\./u)).toBeTruthy();
  });
});
