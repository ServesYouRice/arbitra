// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TraceEntry, TracePage } from "@arbitra/schemas/trace-browser.js";
import { AttemptDetails, TraceView } from "../../src/views/traces/TraceView.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const entry: TraceEntry = { traceId: "0", trace: {
  schemaVersion: 1, runId: "run-1", nodeId: "audit", activityId: "audit/a/turn/0", attempt: 2,
  modelId: "model-a", modelProfileVersion: "profile-1", transportId: "openai-responses", transportVersion: "1.0.0",
  harnessId: "canonical", harnessVersion: "1.0.0", harnessPolicyHash: "policy-1", protocolId: "production-audit", protocolVersion: "1.0.0", protocolHash: "protocol-1",
  promptHash: "prompt-1", resolvedProviderConfigHash: "provider-1", capability: "balanced", effortRequested: "high", effortResolved: "medium",
  inputArtifactRefs: ["artifacts/input.json"], outputArtifactRef: "artifacts/output.json", durationMs: 20, tokenUsage: null, costUsd: null, cacheHitRate: null,
  toolCallCount: 0, toolCallErrors: 0, repairCount: 0, refusal: "cannot process this source", error: null, continuationState: null, advisorTokens: null, outcome: "refusal",
} };
const page: TracePage = { entries: [entry], offset: 0, total: 1, nextOffset: null, facets: { nodeIds: ["audit"], modelIds: ["model-a"], protocolIds: ["production-audit"] } };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

describe("model trace inspection", () => {
  it("shows identity and unknown usage honestly, separates refusals, and loads untrusted artifacts as text", async () => {
    const paths: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const path = String(input); paths.push(path);
      return path.endsWith("/artifacts/output") ? json({ content: '<script>alert("untrusted")</script>', reference: "artifacts/output.json", redacted: true }) : json(page);
    });
    render(<TraceView runId="run-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "audit/a/turn/0 · attempt 2" }));
    const detail = screen.getByLabelText("attempt details");
    expect(detail.textContent).toContain("profile-1"); expect(detail.textContent).toContain("policy-1"); expect(detail.textContent).toContain("protocol-1");
    expect(within(detail).getByText("input tokens").nextElementSibling?.textContent).toBe("unavailable");
    expect(within(detail).getByText("cost USD").nextElementSibling?.textContent).toBe("unavailable");
    expect(within(detail).getByText("refusal", { selector: "dt" }).nextElementSibling?.textContent).toBe("cannot process this source");
    expect(within(detail).getByText("error").nextElementSibling?.textContent).toBe("none recorded");
    fireEvent.click(within(detail).getByRole("button", { name: "output" }));
    const artifact = await screen.findByLabelText("trace artifact");
    expect(artifact.querySelector("script")).toBeNull(); expect(artifact.textContent).toContain('<script>alert("untrusted")</script>');
    expect(paths).toEqual(["/runs/run-1/traces?offset=0&limit=25", "/runs/run-1/traces/0/artifacts/output"]);
  });

  it("passes filters to the server, resets pagination, refreshes on run events, and reports empty results", async () => {
    const paths: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const path = String(input); paths.push(path);
      return json(path.includes("outcome=error") ? { ...page, entries: [], total: 0 } : { ...page, total: 26, nextOffset: path.includes("offset=25") ? null : 25 });
    });
    const view = render(<TraceView runId="run-1" />);
    await screen.findByText(/26 matching/);
    fireEvent.click(screen.getByRole("button", { name: "next attempts" }));
    await waitFor(() => expect(paths.at(-1)).toContain("offset=25"));
    await screen.findByText(/26 matching/);
    fireEvent.change(screen.getByLabelText("outcome"), { target: { value: "error" } });
    await screen.findByText("no recorded attempts match these filters");
    expect(paths.at(-1)).toBe("/runs/run-1/traces?offset=0&limit=25&outcome=error");
    view.rerender(<TraceView runId="run-1" refreshKey={1} />);
    await waitFor(() => expect(paths).toHaveLength(4));
    fireEvent.click(screen.getByRole("button", { name: "refresh traces" }));
    await waitFor(() => expect(paths).toHaveLength(5));
  });

  it("discards late results and selected content when the run changes", async () => {
    let resolveOld: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => String(input).includes("run-old") ? new Promise<Response>((resolve) => { resolveOld = resolve; }) : json(page));
    const view = render(<TraceView runId="run-old" />);
    view.rerender(<TraceView runId="run-1" />);
    fireEvent.click(await screen.findByRole("button", { name: /attempt 2/ }));
    view.rerender(<TraceView runId={null} />);
    resolveOld?.(json(page));
    await waitFor(() => expect(screen.queryByLabelText("attempt details")).toBeNull());
    expect(screen.getByText("select a run to inspect model activity")).toBeTruthy();
    expect(screen.queryByLabelText("model activity attempts")).toBeNull();
  });

  it("reports trace and artifact read failures instead of showing empty successful results", async () => {
    vi.stubGlobal("fetch", async () => json({}, 500));
    const view = render(<TraceView runId="failed" />);
    expect((await screen.findByRole("alert")).textContent).toContain("traces unavailable · TRACE_API_500");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => String(input).includes("/artifacts/") ? json({}, 404) : json(page));
    view.rerender(<TraceView runId="run-1" />);
    fireEvent.click(await screen.findByRole("button", { name: /attempt 2/ }));
    fireEvent.click(screen.getByRole("button", { name: "input 1" }));
    expect((await screen.findByRole("alert")).textContent).toContain("artifact unavailable · TRACE_API_404");
  });

  it("hands a selected attempt to the caller, which loads it by trace ID", async () => {
    const paths: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => { const path = String(input); paths.push(path); return json(path.endsWith("/traces/0") ? entry : page); });
    const selected = vi.fn();
    const view = render(<TraceView runId="run-1" selectedTraceId="0" onSelect={selected} />);
    const button = await screen.findByRole("button", { name: "audit/a/turn/0 · attempt 2" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button);
    expect(selected).toHaveBeenCalledWith("0");
    expect(screen.queryByLabelText("attempt details")).toBeNull();
    view.unmount();
    render(<AttemptDetails runId="run-1" traceId="0" />);
    expect((await screen.findByLabelText("attempt details")).textContent).toContain("profile-1");
    expect(paths.at(-1)).toBe("/runs/run-1/traces/0");
  });

  it("shortens hashes in activity IDs on screen but keeps the full ID as the accessible name", async () => {
    const hashed = { ...entry, trace: { ...entry.trace, activityId: `testing/risk/${"b9".repeat(32)}/turn-0` } };
    vi.stubGlobal("fetch", async () => json({ ...page, entries: [hashed] }));
    render(<TraceView runId="run-1" onSelect={() => undefined} />);
    const button = await screen.findByRole("button", { name: `testing/risk/${"b9".repeat(32)}/turn-0 · attempt 2` });
    expect(button.textContent).toBe("testing/risk/b9b9b9b9…/turn-0 · attempt 2");
    expect(button.getAttribute("title")).toBe(`testing/risk/${"b9".repeat(32)}/turn-0`);
  });

  it("shows only why a run recorded no attempts, without filters or paging", async () => {
    vi.stubGlobal("fetch", async () => json({ ...page, entries: [], total: 0 }));
    render(<TraceView runId="run-1" emptyNote="no model attempts · scripted detectors make no model calls" />);
    expect((await screen.findByText("no model attempts · scripted detectors make no model calls")).dataset.state).toBe("unexamined");
    expect(screen.queryByLabelText("outcome")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "trace pages" })).toBeNull();
  });
});
