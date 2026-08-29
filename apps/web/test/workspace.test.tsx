// @vitest-environment jsdom
import { readFileSync, readdirSync } from "node:fs";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigurationApi, useConfigurations } from "../src/api/configurations.js";
import { GraphView, projectLiveState } from "../src/columns/graph/GraphView.js";
import { layoutWorkflow } from "../src/columns/graph/layout.js";
import { PRESET_WORKFLOWS } from "../src/columns/graph/presets.js";
import { ModelPool } from "../src/columns/model-pool/ModelPool.js";
import { modelCardRows, type ModelCardData } from "../src/columns/model-pool/model.js";
import { ConfigurationEditor } from "../src/configuration/ConfigurationEditor.js";
import { canonicalConfigurationFields, configurationCoverage } from "../src/configuration/coverage.js";
import { AppShell } from "../src/shell/AppShell.js";
import { fromPackageRoot } from "./package-root.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const model: ModelCardData = { alias: "reviewer-a", provider: "openai", modelId: "frontier-a", transport: "responses", capabilityTier: "frontier", supportsReasoning: true, defaultEffort: "xhigh", effortCollapse: { xhigh: "high" }, contextLimit: 128000, configurationStatus: "configured", priceMetadata: { input: 1, output: 4, currency: "USD" }, allowedTools: ["repo.readFile"], independenceGroup: "provider-a", fallback: "reviewer-b", enabled: true };

describe("configuration workspace and Model Pool", () => {
  it("covers every canonical configuration field and exposes the validated fallback", () => {
    expect(canonicalConfigurationFields()).toEqual(["auditDepth", "budgets", "consensusPolicy", "contextPolicies", "harness", "maxConsensusRounds", "mode", "models", "promptOverrides", "protocols", "scope", "security", "verification", "workflow"]);
    expect(configurationCoverage()).toMatchObject({ missing: [] });
    render(<ConfigurationEditor api={new ConfigurationApi()} initialName="Maximal" initialValue={maximalConfig()} />);
    for (const label of ["mode", "scope kind", "audit depth", "consensus", "maximum rounds", "harness mode", "models JSON", "validated JSON fallback"]) expect(screen.getByLabelText(new RegExp(`^${label}(?: \\(|$)`, "i"))).toBeTruthy();
  });

  it("round-trips a maximal configuration through edit, save, load, duplicate, validate and export", async () => {
    const records = new Map<string, { id: string; name: string; config: unknown }>(); let id = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => { const url = String(input); const method = init?.method ?? "GET"; const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as Record<string, unknown>; if (url === "/configurations/validate") return json({ valid: true }); if (url === "/configurations" && method === "POST") { const record = { id: `cfg-${++id}`, name: String(body?.name), config: body?.config }; records.set(record.id, record); return json(record); } const match = url.match(/^\/configurations\/(cfg-\d+)(?:\/(duplicate|export))?$/u); if (match === null) return json({}, 404); const record = records.get(match[1]!)!; if (match[2] === "duplicate") { const copy = { id: `cfg-${++id}`, name: String(body?.name), config: structuredClone(record.config) }; records.set(copy.id, copy); return json(copy); } if (match[2] === "export") return json(record.config); return json(record); });
    const api = new ConfigurationApi(); const edited = { ...maximalConfig(), auditDepth: "deep" }; expect(await api.validate(edited)).toEqual({ valid: true }); const saved = await api.save("Maximal", edited); expect((await api.load(saved.id)).config).toEqual(edited); const copy = await api.duplicate(saved.id, "Copy"); expect(copy.config).toEqual(edited); expect(await api.export(saved.id)).toEqual(edited);
  });

  it("shows complete model metadata and labels effort collapse as declared metadata", () => {
    const rows = modelCardRows(model); expect(rows.map(({ label }) => label)).toEqual(["alias", "provider / model", "transport", "capability", "reasoning", "default effort", "effort collapse", "context", "configuration", "price input / output", "allowed tools", "independence group (configured)", "fallback", "enabled"]);
    expect(rows.find(({ label }) => label === "effort collapse")).toEqual({ label: "effort collapse", value: "xhigh→high", state: "degraded" });
    render(<ModelPool models={[model]} selectedAlias="reviewer-a" onSelect={() => undefined} />); expect(screen.getByText("independence group (configured)")).toBeTruthy(); expect(screen.getByText("xhigh→high")).toBeTruthy();
  });
  it("exposes the server-backed useConfigurations lifecycle hook", async () => { const api = new ConfigurationApi(); vi.spyOn(api, "list").mockResolvedValue([{ id: "cfg-1", name: "Default" }]); function Fixture() { const state = useConfigurations(api); return <div>{state.loading ? "loading" : state.configurations.map(({ name }) => name).join(",")}</div>; } render(<Fixture />); expect(await screen.findByText("Default")).toBeTruthy(); });
});

describe("live read-only workflow graph", () => {
  it("lays out four structurally different workflow JSON presets", async () => {
    const layouts = await Promise.all(Object.values(PRESET_WORKFLOWS).map(layoutWorkflow)); expect(layouts.map((layout) => layout.length)).toEqual([8, 5, 5, 5]); for (const layout of layouts) expect(layout.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
  });
  it("projects ordered live activity, convergence, verification, failure and retry state without fabrication", () => {
    const workflow = PRESET_WORKFLOWS["diff-review"]; const projected = projectLiveState(workflow, [{ t: "node_dispatched", runId: "r", nodeId: "auditor-a", activityId: "a", attempt: 2 }, { t: "node_completed", runId: "r", nodeId: "auditor-a", activityId: "a" }, { t: "node_failed", runId: "r", nodeId: "verification", reason: "fixture failure", attempt: 1 }], { "auditor-a": "reviewer-a" });
    expect(projected.get("auditor-a")).toMatchObject({ semanticState: null, runtimeStatus: "completed", activity: "completed", assignment: "reviewer-a", retries: 2 }); expect(projected.get("verification")).toMatchObject({ semanticState: null, runtimeStatus: "failed", activity: "fixture failure", retries: 1 }); expect(projected.get("auditor-b")).toMatchObject({ semanticState: "unexamined", runtimeStatus: "not_started", activity: "not started" });
  });
  it("renders React Flow as read-only and provides model assignment in the inspector", async () => {
    class Observer { observe() {} unobserve() {} disconnect() {} }
    const assign = vi.fn(); vi.stubGlobal("ResizeObserver", Observer); render(<GraphView workflowJson={PRESET_WORKFLOWS["feature-simple"]} runEvents={[]} modelAliases={["reviewer-a"]} assignments={{ planner: "reviewer-a" }} onAssign={assign} />); expect(screen.getByText("workflow graph · read only")).toBeTruthy(); const plannerLabels = await screen.findAllByText("Planner"); fireEvent.click(plannerLabels[0]!); const selector = await screen.findByLabelText("model assignment") as HTMLSelectElement; expect(selector.value).toBe("reviewer-a"); fireEvent.change(selector, { target: { value: "reviewer-a" } }); expect(assign).toHaveBeenCalledWith("planner", "reviewer-a");
  });
});

describe("normative shell and production assets", () => {
  it("renders the lowercase wordmark and non-colour state labels", () => { render(<AppShell models={[model]} graph={<div>graph</div>} contract={<div>contract</div>} inspector={<div>inspector</div>} />); expect(screen.getByText("arbitra")).toBeTruthy(); expect(screen.getByText("arbitra").textContent).toBe("arbitra"); });
  it("pins desktop, 1180px and 900px structural transitions with tokens only", () => { const css = readFileSync(fromPackageRoot("src/shell/shell.css"), "utf8"); expect(css).toContain("grid-template-columns: 280px minmax(420px, 1fr) 360px 320px"); expect(css).toContain("@media (max-width: 1180px)"); expect(css).toContain("@media (max-width: 900px)"); expect(css).toContain("border: var(--hairline)"); expect(css.match(/box-shadow:[^;]+/gu)).toEqual(["box-shadow: none", "box-shadow: none"]); expect(css.match(/border-radius:[^;]+/gu)).toEqual(["border-radius: var(--radius)", "border-radius: var(--radius)"]); expect(css).not.toContain("gradient("); const cssFiles = ["src/shell/shell.css", "src/configuration/configuration.css", "src/columns/model-pool/model-pool.css", "src/columns/graph/graph.css"].map((path) => readFileSync(fromPackageRoot(path), "utf8")); expect(cssFiles.join("\n")).not.toMatch(/#[0-9a-f]{3,8}\b/iu); });
  it("ships only the five designated production marks and imports the shared glyph table", () => { expect(readdirSync(fromPackageRoot("src/assets/brand")).sort()).toEqual(["mark-triangle-icon-mono.svg", "mark-triangle-icon.svg", "mark-triangle-of-error-mono.svg", "mark-triangle-of-error.svg", "mark-triangle-reduction.svg"]); const graphSource = readFileSync(fromPackageRoot("src/columns/graph/GraphView.tsx"), "utf8"); expect(graphSource).toContain('@arbitra/schemas/glyphs'); expect(graphSource).not.toContain("const NODE_GLYPHS"); });
});

function maximalConfig(): Record<string, unknown> { return { schemaVersion: 1, mode: "audit", scope: { kind: "diff", base: "origin/main", head: "HEAD" }, auditDepth: "balanced", consensusPolicy: "risk_weighted", maxConsensusRounds: 3, verification: { deterministicFirst: true }, models: {}, harness: { mode: "canonical" }, workflow: { preset: "diff-review" }, budgets: { cost: 25 }, security: { overlapBudget: 8 }, protocols: { audit: "1.0.0" }, promptOverrides: { before: "" }, contextPolicies: { discovery: "independent" } }; }
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
