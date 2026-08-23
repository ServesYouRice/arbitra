// @vitest-environment jsdom
import type { ReactElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactApi } from "../../src/api/artifacts.js";
import { PRESET_WORKFLOWS } from "../../src/columns/graph/presets.js";
import type { ModelCardData } from "../../src/columns/model-pool/model.js";
import { ArbitraWorkspace, WORKSPACE_VIEWS } from "../../src/shell/ArbitraWorkspace.js";
import { EvaluationApi } from "../../src/views/evaluation/api.js";
import { ARTIFACT_CONTENT } from "./fixtures.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const model: ModelCardData = { alias: "reviewer-a", provider: "openai", modelId: "frontier-a", transport: "responses", capabilityTier: "frontier", supportsReasoning: true, defaultEffort: "xhigh", effortCollapse: {}, contextLimit: 128000, configurationStatus: "configured", priceMetadata: { input: 1, output: 4, currency: "USD" }, allowedTools: ["repo.readFile"], independenceGroup: "provider-a", fallback: null, enabled: true };
const configuration = { schemaVersion: 1, mode: "audit", scope: { kind: "repository" }, auditDepth: "deep", consensusPolicy: "risk_weighted", maxConsensusRounds: 2, verification: {}, models: {}, harness: { mode: "canonical" }, workflow: { preset: "audit-deep" }, budgets: {}, security: {}, protocols: {}, promptOverrides: {}, contextPolicies: {} };
const metrics = { rows: [{ modelIdentity: "model-a", activityCount: 1, successCount: 1, refusalCount: 0, errorCount: 0, cacheHitRate: null, repairCount: 0, recall: null, precision: null, falsePositiveRate: null, uniqueTrueContribution: null, marginalTrueContribution: null, repairFrequency: null, invalidEvidenceRate: null, refusalRate: null, costUsd: null, latencyMs: null, independenceGroup: null }], denominator: { activityCount: 1, auditorCount: 0, groundTruthAvailable: false }, segmentation: ["model"], independence: { applicable: false, reason: "no_ground_truth_measurement", groups: [] } };

describe("the shell mounts every run-level view", () => {
  it("offers one tab per view and starts on the workflow graph", async () => {
    stub();
    render(<Workspace />);
    const tabs = screen.getByLabelText("workspace views");
    for (const label of Object.values(WORKSPACE_VIEWS)) expect(tab(tabs, label)).toBeTruthy();
    expect(tab(tabs, "workflow graph").getAttribute("aria-current")).toBe("page");
    expect(await screen.findByText("workflow graph · read only")).toBeTruthy();
  });

  it("renders the Issue Board over persisted artifacts when its tab is selected", async () => {
    stub();
    render(<Workspace />);
    fireEvent.click(tab(screen.getByLabelText("workspace views"), "issue board"));
    expect(await screen.findByText("3 auditors · 31 source findings · 2 accepted · 26 rejected · 2 unresolved · 1 single-source")).toBeTruthy();
    expect(screen.getByText("suppression candidates · 1")).toBeTruthy();
    expect(screen.queryByText("workflow graph · read only")).toBeNull();
  });

  it("renders the Plan view and its traceability trail when its tab is selected", async () => {
    stub();
    render(<Workspace />);
    fireEvent.click(tab(screen.getByLabelText("workspace views"), "plan"));
    expect(await screen.findByText("Authorization repair · mode audit · 1 accepted canonical issues · 1 tasks")).toBeTruthy();
    fireEvent.click(screen.getByText("TASK-001"));
    expect(screen.getByLabelText("forward links").textContent).toContain("validation · VAL-001");
  });

  it("renders the Evaluation view through the metrics route when its tab is selected", async () => {
    stub();
    render(<Workspace />);
    fireEvent.click(tab(screen.getByLabelText("workspace views"), "evaluation"));
    expect(await screen.findByText(/segmented by model · 1 model activities/)).toBeTruthy();
    expect(screen.getByText(/independence · not applicable · no_ground_truth_measurement/)).toBeTruthy();
  });

  it("returns to the graph without losing the run controls beside it", async () => {
    stub();
    render(<Workspace />);
    fireEvent.click(tab(screen.getByLabelText("workspace views"), "issue board"));
    await screen.findByLabelText("issue board");
    fireEvent.click(tab(screen.getByLabelText("workspace views"), "workflow graph"));
    await waitFor(() => expect(screen.getByText("workflow graph · read only")).toBeTruthy());
    expect(screen.getByText("run controls")).toBeTruthy();
    expect(screen.getByText("workflow inspector")).toBeTruthy();
  });
});

function Workspace(): ReactElement {
  return <ArbitraWorkspace artifactApi={new ArtifactApi()} evaluationApi={new EvaluationApi()} runId="run-1" workflow={PRESET_WORKFLOWS["audit-deep"]} models={[model]} defaultConfiguration={configuration} />;
}
function tab(container: HTMLElement, text: string): HTMLElement {
  const match = [...container.querySelectorAll("button")].find((button) => button.textContent === text);
  if (match === undefined) throw new Error(`no control labelled ${text}`);
  return match;
}
function stub(): void {
  class Observer { observe() {} unobserve() {} disconnect() {} }
  class Source { onmessage: ((event: MessageEvent) => void) | null = null; close() {} }
  vi.stubGlobal("ResizeObserver", Observer); vi.stubGlobal("EventSource", Source);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/configurations") return json([{ id: "cfg-1", name: "Default" }]);
    if (path === "/runs/run-1") return json({ runId: "run-1", state: "BLOCKED", resumable: true, checkpoints: [] });
    if (path === "/runs/run-1/metrics") return json(metrics);
    if (path === "/runs/run-1/artifacts") return json(Object.keys(ARTIFACT_CONTENT).map((kind) => ({ artifactId: `artifact:${kind}`, kind, mediaType: "application/json", bytes: 256, redacted: true })));
    const match = /^\/runs\/run-1\/artifacts\/artifact%3A(.+)$/u.exec(path);
    if (match !== null) return json({ artifactId: `artifact:${match[1]!}`, kind: match[1]!, mediaType: "application/json", bytes: 256, redacted: true, content: JSON.stringify(ARTIFACT_CONTENT[match[1]!]), truncated: false, continuationArtifactId: null });
    return json({}, 404);
  });
}
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
