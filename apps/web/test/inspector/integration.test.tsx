// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowJson } from "../../src/columns/graph/layout.js";
import { PRESET_WORKFLOWS } from "../../src/columns/graph/presets.js";
import { inspectorSelectionFor } from "../../src/columns/inspector/selection.js";
import type { ModelCardData } from "../../src/columns/model-pool/model.js";
import { ArbitraWorkspace, INSPECTOR_OVERLAY_QUERY } from "../../src/shell/ArbitraWorkspace.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const model: ModelCardData = { alias: "reviewer-a", provider: "openai", modelId: "frontier-a", transport: "responses", capabilityTier: "frontier", supportsReasoning: true, defaultEffort: "xhigh", effortCollapse: { xhigh: "high" }, contextLimit: 128000, configurationStatus: "configured", priceMetadata: { input: 1, output: 4, currency: "USD" }, allowedTools: ["repo.readFile"], independenceGroup: "provider-a", fallback: "reviewer-b", enabled: true };
const configuration = { schemaVersion: 1, mode: "audit", scope: { kind: "repository" }, auditDepth: "deep", consensusPolicy: "risk_weighted", maxConsensusRounds: 2, verification: {}, models: {}, harness: { mode: "canonical" }, workflow: { preset: "audit-deep" }, budgets: {}, security: {}, protocols: {}, promptOverrides: {}, contextPolicies: {} };
const persisted = { artifactId: "artifact:prompt-a", redacted: true, nodeId: "auditor-a", modelAlias: "reviewer-a", protocol: { id: "production-audit", version: "1.0.0", hash: "abc123", locked: true }, overrides: { before: "", after: "" }, compiledPreview: "[REDACTED:api_key] persisted prompt", promptHash: "integrated-hash-a", lint: [], context: { policy: "selected_artifacts", trust: "untrusted", included: [], excluded: [], tokenEstimate: 4200, estimateBasis: "canonical bytes" }, output: { schema: "SourceFindingIR", requiredFields: ["id"], validationBehaviour: "repair_once", structuredOutputTier: "provider_native", tierDegradation: null }, cacheHitRate: 0.75 };

describe("integrated workspace selection, prompts and run controls", () => {
  it("loads the selected auditor's persisted prompt artifact through the declared artifact routes", async () => {
    stubEnvironment(); const calls = stubFetch();
    render(<ArbitraWorkspace runId="run-1" workflow={PRESET_WORKFLOWS["audit-deep"]} models={[model]} defaultConfiguration={configuration} />);
    fireEvent.click((await screen.findAllByText("Auditor A"))[0]!);
    expect(await screen.findByText("integrated-hash-a")).toBeTruthy();
    expect(screen.getByText(/never recompiled in browser/)).toBeTruthy();
    expect(calls).toContain("GET /runs/run-1/artifacts");
    expect(calls).toContain("GET /runs/run-1/artifacts/artifact%3Aprompt-a");
  });

  it("shows deterministic transformation configuration instead of a prompt panel", async () => {
    stubEnvironment(); stubFetch();
    const workflow: WorkflowJson = { id: "deterministic", nodes: [{ id: "cluster", kind: "deterministic", label: "Cluster", config: { strategy: "exact-signals" } }], edges: [] };
    render(<ArbitraWorkspace runId="run-1" workflow={workflow} models={[model]} defaultConfiguration={configuration} />);
    fireEvent.click((await screen.findAllByText("Cluster"))[0]!);
    expect(await screen.findByText("deterministic transformation")).toBeTruthy();
    expect(screen.getByText(/exact-signals/)).toBeTruthy();
    expect(screen.queryByText("persisted redacted compiled preview")).toBeNull();
  });

  it("rehydrates the run before streaming and exposes run controls and persisted artifacts", async () => {
    stubEnvironment(); stubFetch();
    render(<ArbitraWorkspace runId="run-1" workflow={PRESET_WORKFLOWS["audit-deep"]} models={[model]} defaultConfiguration={configuration} />);
    expect(await screen.findByText("workflow inspector")).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/BLOCKED/)).toBeTruthy());
    expect(await screen.findByText("run controls")).toBeTruthy();
    fireEvent.click(await screen.findByText(/compiled-prompt · artifact:prompt-a/));
    expect(await screen.findByText(/persisted redacted content · 512 bytes/)).toBeTruthy();
    expect(screen.getByText(/persisted redacted content · 512 bytes/).dataset.state).toBe("tainted");
    expect(screen.getByText("complete bounded artifact")).toBeTruthy();
  });

  it("becomes the documented overlay at the 1180px transition without losing run controls", async () => {
    stubEnvironment(true); stubFetch();
    render(<ArbitraWorkspace runId="run-1" workflow={PRESET_WORKFLOWS["audit-deep"]} models={[model]} defaultConfiguration={configuration} />);
    const open = await screen.findByText("open inspector");
    expect(screen.queryByLabelText("run inspector")).toBeNull();
    fireEvent.click(open);
    const overlay = await screen.findByLabelText("run inspector");
    expect(overlay.getAttribute("aria-modal")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText("close inspector")));
    expect(screen.getByText("run controls")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByLabelText("run inspector")).toBeNull());
  });

  it("reports unavailable rather than fabricated values for fields the run never persisted", () => {
    expect(inspectorSelectionFor({ node: null, model: null, configuration: {}, run: null, repository: null })).toMatchObject({ kind: "workflow", repository: "unavailable", snapshot: "unavailable", base: null, head: null, concurrency: null, retries: null, runState: "unavailable" });
    expect(inspectorSelectionFor({ node: { id: "planner", kind: "model", label: "Planner" }, model: null, configuration: {}, run: null, repository: null })).toMatchObject({ kind: "planner", criticPolicy: "unavailable", validationRules: [] });
    expect(inspectorSelectionFor({ node: { id: "preflight", kind: "deterministic", label: "Preflight" }, model, configuration, run: null, repository: null })).toMatchObject({ kind: "audit", depth: "deep", rounds: 2, securityOverlapBudget: null, tools: ["repo.readFile"] });
  });
});

function stubEnvironment(overlay = false): void {
  class Observer { observe() {} unobserve() {} disconnect() {} }
  class Source { onmessage: ((event: MessageEvent) => void) | null = null; close() {} }
  vi.stubGlobal("ResizeObserver", Observer); vi.stubGlobal("EventSource", Source);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: overlay && query === INSPECTOR_OVERLAY_QUERY, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
}

function stubFetch(): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input); calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/configurations") return json([{ id: "cfg-1", name: "Default" }]);
    if (path === "/runs/run-1") return json({ runId: "run-1", state: "BLOCKED", resumable: true, checkpoints: [] });
    if (path === "/runs/run-1/artifacts") return json([{ artifactId: "artifact:prompt-a", kind: "compiled-prompt", mediaType: "application/json", bytes: 512, redacted: true, nodeId: "auditor-a" }]);
    if (path === "/runs/run-1/artifacts/artifact%3Aprompt-a") return json({ artifactId: "artifact:prompt-a", kind: "compiled-prompt", mediaType: "application/json", bytes: 512, redacted: true, content: JSON.stringify(persisted), truncated: false, continuationArtifactId: null });
    return json({}, 404);
  });
  return calls;
}
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
