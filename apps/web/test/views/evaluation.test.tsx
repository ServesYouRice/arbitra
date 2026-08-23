// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvaluationApi, measured } from "../../src/views/evaluation/api.js";
import { EvaluationView } from "../../src/views/evaluation/EvaluationView.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const measuredRow = { modelIdentity: "model-a", activityCount: 3, successCount: 3, refusalCount: 0, errorCount: 0, cacheHitRate: 0.25, repairCount: 1, recall: 0.5, precision: 0.75, falsePositiveRate: 0.25, uniqueTrueContribution: 2, marginalTrueContribution: 2, repairFrequency: 0.25, invalidEvidenceRate: 0, refusalRate: 0, costUsd: 0.01, latencyMs: 1200, independenceGroup: "provider-a" };
const unmeasuredRow = { ...measuredRow, modelIdentity: "model-b", recall: null, precision: null, falsePositiveRate: null, uniqueTrueContribution: null, marginalTrueContribution: null, repairFrequency: null, invalidEvidenceRate: null, refusalRate: null, costUsd: null, latencyMs: null, independenceGroup: null };
const metrics = { rows: [measuredRow, unmeasuredRow], denominator: { activityCount: 6, auditorCount: 2, groundTruthAvailable: true }, segmentation: ["model"], independence: { applicable: true, reason: null, groups: ["provider-a", "provider-b"] }, totalCostUsd: 0.02, currency: "USD", costPerTrueAcceptedIssue: 2.05, consensusPrecision: 0.5, consensusRecall: 0.5, verificationResolutionRate: 0.75, cacheHitRate: 0.25, escalatedPairs: 2, securityOverlapBudget: { budget: 8, used: 6, usage: 0.75 }, suppressionCandidateCount: 1 };

describe("web evaluation surface over the localhost routes", () => {
  it("shows every per-auditor and per-run metric with its denominator and identity segmentation", async () => {
    stubMetrics(metrics);
    render(<EvaluationView api={new EvaluationApi()} runId="run-1" />);
    expect(await screen.findByText("segmented by model · 6 model activities · 2 scored auditors · ground truth available")).toBeTruthy();
    const table = screen.getByLabelText("per-auditor contribution");
    for (const column of ["recall", "precision", "false-positive rate", "unique true contribution", "marginal contribution", "repair frequency", "invalid-evidence rate", "refusal rate", "cost", "latency"]) expect(within(table).getByText(column)).toBeTruthy();
    const summary = screen.getByLabelText("per-run evaluation");
    expect(within(summary).getByText("consensus precision").nextElementSibling?.textContent).toBe("0.5");
    expect(within(summary).getByText("verification resolution rate").nextElementSibling?.textContent).toBe("0.75");
    expect(within(summary).getByText("cache hit rate").nextElementSibling?.textContent).toBe("0.25");
    expect(within(summary).getByText("escalated pairs").nextElementSibling?.textContent).toBe("2");
    expect(within(summary).getByText("security overlap budget").nextElementSibling?.textContent).toBe("6 of 8 · usage 0.75");
    expect(within(summary).getByText("suppression candidates").nextElementSibling?.textContent).toBe("1");
    expect(within(summary).getByText("cost per true accepted issue").nextElementSibling?.textContent).toBe("2.05");
  });

  it("renders every unmeasured value as unavailable rather than zero", async () => {
    stubMetrics(metrics);
    render(<EvaluationView api={new EvaluationApi()} runId="run-1" />);
    const table = await screen.findByLabelText("per-auditor contribution");
    const unavailable = within(table).getAllByText("unavailable");
    expect(unavailable).toHaveLength(11);
    for (const cell of unavailable) expect(cell.dataset.state).toBe("unexamined");
    const unmeasured = within(table).getByText("model-b").closest("tr");
    expect(within(unmeasured as HTMLElement).queryByText("0")).toBeNull();
    expect(measured(null)).toBe("unavailable");
    expect(measured(undefined)).toBe("unavailable");
    expect(measured(0)).toBe("0");
  });

  it("states explicitly that a run with no independence data is not applicable", async () => {
    stubMetrics({ ...metrics, denominator: { activityCount: 3, auditorCount: 1, groundTruthAvailable: true }, independence: { applicable: false, reason: "single_auditor_run_produces_no_independence_data", groups: ["provider-a"] } });
    render(<EvaluationView api={new EvaluationApi()} runId="run-1" />);
    const independence = await screen.findByText(/independence · not applicable · single_auditor_run_produces_no_independence_data/);
    expect(independence.dataset.state).toBe("unexamined");
  });

  it("shows the server's refusal for a cross-protocol comparison instead of a computed result", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input); calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/runs/run-1/metrics") return json(metrics);
      return json({ comparable: false, error: "CROSS_PROTOCOL_COMPARISON_REFUSED", message: "audit@1.0.0 and audit@2.0.0 are different protocol identities" }, 409);
    });
    render(<EvaluationView api={new EvaluationApi()} runId="run-1" />);
    await screen.findByLabelText("per-auditor contribution");
    fireEvent.change(screen.getByLabelText("protocol a"), { target: { value: "audit@1.0.0" } });
    fireEvent.change(screen.getByLabelText("protocol b"), { target: { value: "audit@2.0.0" } });
    fireEvent.click(screen.getByText("compare"));
    const refusal = await screen.findByText(/refused · CROSS_PROTOCOL_COMPARISON_REFUSED · audit@1\.0\.0 and audit@2\.0\.0 are different protocol identities/);
    expect(refusal.dataset.state).toBe("refuted");
    expect(refusal.getAttribute("role")).toBe("alert");
    expect(calls).toEqual(["GET /runs/run-1/metrics", "POST /runs/compare"]);
  });

  it("surfaces an identity aggregation refusal on the metrics route as a labelled state", async () => {
    vi.stubGlobal("fetch", async () => json({ comparable: false, error: "INCOMPARABLE_IDENTITY_MIX", message: "INCOMPARABLE_IDENTITY_MIX:protocol: group by protocol or narrow the filter" }, 409));
    render(<EvaluationView api={new EvaluationApi()} runId="run-1" />);
    const state = await screen.findByText(/metrics unavailable · INCOMPARABLE_IDENTITY_MIX:protocol/);
    expect(state.dataset.state).toBe("degraded");
  });

  it("reports a comparable comparison when both sides share a protocol identity", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => String(input) === "/runs/run-1/metrics" ? json(metrics) : json({ comparable: true, protocolIdentity: "audit@1.0.0", sides: [{ protocolIdentity: "audit@1.0.0", rows: [] }, { protocolIdentity: "audit@1.0.0", rows: [] }] }));
    render(<EvaluationView api={new EvaluationApi()} runId="run-1" />);
    await screen.findByLabelText("per-auditor contribution");
    fireEvent.click(screen.getByText("compare"));
    await waitFor(() => expect(screen.getByText(/comparable · audit@1\.0\.0 · 2 segments/).dataset.state).toBe("verified"));
  });

  it("imports no persistence code and derives no metric in the browser", () => {
    const source = ["src/views/evaluation/api.ts", "src/views/evaluation/EvaluationView.tsx"].map((path) => readFileSync(resolve(process.cwd(), path), "utf8")).join("\n");
    expect(source).not.toMatch(/@arbitra\/persistence|MetricStore|contributionQuery|costQuery|protocolComparison\(/u);
    expect(source).not.toMatch(/reduce\(|\/ *denominator|Math\.round/u);
    expect(source).toContain("/runs/compare");
  });

  it("uses only the supplied scales and stays legible in forced colours", () => {
    const css = readFileSync(resolve(process.cwd(), "src/views/evaluation/evaluation.css"), "utf8");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
    expect(css).toContain("var(--row-h)");
    expect(css).toContain("border-radius: var(--radius)");
    expect(css).toContain("@media (forced-colors: active)");
    expect(css.match(/box-shadow:[^;]+/gu)).toEqual(["box-shadow: none"]);
    expect(css).not.toContain("gradient(");
  });
});

function stubMetrics(value: unknown): void { vi.stubGlobal("fetch", async () => json(value)); }
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
