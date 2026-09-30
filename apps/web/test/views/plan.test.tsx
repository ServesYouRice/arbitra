// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { useState, type ReactElement } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactApi } from "../../src/api/artifacts.js";
import { PlanView, routingText } from "../../src/views/plan/PlanView.js";
import { TraceDetails } from "../../src/views/plan/TraceDetails.js";
import { backward, findTraceNode, forward, type TraceGraph, type TraceLevel } from "../../src/views/plan/traceability.js";
import { ARTIFACT_CONTENT, findings, issueSet, plan } from "./fixtures.js";
import { fromPackageRoot } from "../package-root.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const graph: TraceGraph = { plan, issues: issueSet.issues, findings };

describe("plan view and traceability navigation", () => {
  it("shows what blocks the plan first, then tasks, routing, the validation contract, dependencies and premise honesty", async () => {
    stubArtifacts();
    render(<PlanView api={new ArtifactApi()} runId="run-1" />);
    expect(await screen.findByText("Authorization repair · mode audit · 1 planned canonical issues · 1 tasks")).toBeTruthy();
    expect(screen.getByText(/premise · null · smoke_test_only_not_proof · one repository, one run/).dataset.state).toBe("unexamined");
    expect(screen.getByText("Q-1 · Is the invite flow in scope? · blast radius high · blocks the plan gate").dataset.state).toBe("refuted");
    expect(screen.getByText("One blocking gap in validation coverage.")).toBeTruthy();
    expect(screen.getByText(/validation_gap · blocking · No assertion covers the invite flow\./).dataset.state).toBe("refuted");
    const row = within(screen.getByRole("table", { name: "plan tasks" })).getByRole("row", { name: /TASK-001/u });
    expect(row.textContent).toContain("Enforce the role guard");
    expect(row.textContent).toContain("frontier / high · security critical");
    expect(screen.getByText(/Unauthorized users cannot change another user's role\. · evidence authorization regression test/)).toBeTruthy();
    expect(screen.getByText("TASK-001 → TASK-002")).toBeTruthy();
    const headings = screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
    expect(headings.indexOf("unresolved questions")).toBeLessThan(headings.indexOf("tasks and capability routing"));
  });

  it("states a routing recommendation only where it differs from the task's routing", () => {
    expect(routingText({ capability: "frontier", effort: "high", reason: [] }, { capability: "frontier", effort: "high", reason: ["security critical"] })).toBe("frontier / high · security critical");
    expect(routingText({ capability: "balanced", effort: "medium", reason: ["scope"] }, { capability: "frontier", effort: "high", reason: ["security critical"] })).toBe("balanced / medium · recommended frontier / high · security critical");
    expect(routingText({ capability: "fast", effort: "low", reason: [] }, null)).toBe("fast / low");
  });

  it("selects a task or an assertion for tracing", async () => {
    stubArtifacts();
    const select = vi.fn();
    render(<PlanView api={new ArtifactApi()} runId="run-1" selected={{ level: "validation", id: "VAL-001" }} onSelect={select} />);
    expect((await screen.findByRole("button", { name: "VAL-001" })).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "TASK-001" }));
    expect(select).toHaveBeenCalledWith("task", "TASK-001");
  });

  it("reaches source evidence from a task in three steps, keeping the path in a trail", async () => {
    stubArtifacts();
    render(<Traced level="task" id="TASK-001" />);
    fireEvent.click(await within(await screen.findByRole("region", { name: "forward links" })).findByText("validation · VAL-001"));
    fireEvent.click(within(screen.getByRole("region", { name: "forward links" })).getByText("issue · issue-1"));
    fireEvent.click(within(screen.getByRole("region", { name: "forward links" })).getByText("finding · reviewer-a/f-1"));
    const trail = screen.getByLabelText("traceability trail");
    expect([...trail.querySelectorAll("li")].map((item) => item.textContent?.split(" · ").slice(0, 2).join(" · "))).toEqual(["task · TASK-001", "validation · VAL-001", "issue · issue-1", "finding · reviewer-a/f-1"]);
    expect(within(screen.getByRole("region", { name: "forward links" })).getByText("evidence · ev-1")).toBeTruthy();
    expect(screen.getByRole("region", { name: "forward links" }).textContent).toContain("updateRole runs before the authorization guard");
  });

  it("navigates the same chain backward from evidence to task", () => {
    expect(backward(graph, { level: "evidence", id: "ev-1", label: "" })).toEqual([{ level: "finding", id: "reviewer-a/f-1", label: "Role check missing on update" }]);
    expect(backward(graph, { level: "finding", id: "reviewer-a/f-1", label: "" })).toEqual([{ level: "issue", id: "issue-1", label: "Role check missing on update" }]);
    expect(backward(graph, { level: "issue", id: "issue-1", label: "" })).toEqual([{ level: "validation", id: "VAL-001", label: "Unauthorized users cannot change another user's role." }]);
    expect(backward(graph, { level: "validation", id: "VAL-001", label: "" })).toEqual([{ level: "task", id: "TASK-001", label: "Enforce the role guard" }]);
    expect(backward(graph, { level: "task", id: "TASK-001", label: "" })).toEqual([]);
  });

  it("links every forward step of the chain and reports a missing link rather than inventing one", () => {
    expect(forward(graph, { level: "task", id: "TASK-001", label: "" }).map(({ id }) => id)).toEqual(["VAL-001"]);
    expect(forward(graph, { level: "validation", id: "VAL-001", label: "" }).map(({ id }) => id)).toEqual(["issue-1"]);
    expect(forward(graph, { level: "issue", id: "issue-1", label: "" }).map(({ id }) => id)).toEqual(["reviewer-a/f-1"]);
    expect(forward(graph, { level: "finding", id: "reviewer-a/f-1", label: "" }).map(({ id }) => id)).toEqual(["ev-1"]);
    expect(forward(graph, { level: "evidence", id: "ev-1", label: "" })).toEqual([]);
    expect(forward({ ...graph, findings: [] }, { level: "issue", id: "issue-1", label: "" })).toEqual([{ level: "finding", id: "reviewer-a/f-1", label: "source finding unavailable" }]);
  });

  it("navigates backward and rewinds the trail to an earlier step", async () => {
    stubArtifacts();
    render(<Traced level="validation" id="VAL-001" />);
    fireEvent.click(await within(await screen.findByRole("region", { name: "backward links" })).findByText("task · TASK-001"));
    expect(screen.getByLabelText("traceability trail").querySelectorAll("li")).toHaveLength(2);
    fireEvent.click(within(screen.getByLabelText("traceability trail")).getByRole("button", { name: "validation · VAL-001" }));
    expect(screen.getByLabelText("traceability trail").querySelectorAll("li")).toHaveLength(1);
    expect(findTraceNode(graph, "evidence", "ev-1")).toEqual({ level: "evidence", id: "ev-1", label: "updateRole runs before the authorization guard" });
    expect(findTraceNode(graph, "task", "TASK-404")).toBeNull();
  });

  it("labels absent plan and critic artifacts instead of rendering an empty plan", async () => {
    vi.stubGlobal("fetch", async () => json([]));
    const empty = render(<PlanView api={new ArtifactApi()} runId="run-1" />);
    expect((await screen.findByText("plan artifact absent")).dataset.state).toBe("unexamined");
    empty.unmount();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/runs/run-1/artifacts") return json(["plan-ir", "canonical-issues", "source-findings"].map((kind) => ({ artifactId: `artifact:${kind}`, kind, mediaType: "application/json", bytes: 256, redacted: true })));
      const match = /^\/runs\/run-1\/artifacts\/artifact%3A(.+)$/u.exec(path);
      const kind = match?.[1];
      return kind === undefined ? json({}, 404) : json({ artifactId: `artifact:${kind}`, kind, mediaType: "application/json", bytes: 256, redacted: true, content: JSON.stringify(ARTIFACT_CONTENT[kind]), truncated: false, continuationArtifactId: null });
    });
    render(<PlanView api={new ArtifactApi()} runId="run-1" />);
    expect((await screen.findByText("critic feedback absent")).dataset.state).toBe("unexamined");
  });

  it("uses only the supplied scales and keeps dense rows monochrome-legible", () => {
    const css = readFileSync(fromPackageRoot("src/views/plan/plan.css"), "utf8");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
    expect(css).toContain("var(--row-h)");
    expect(css).toContain("border-radius: var(--radius)");
    expect(css).toContain("@media (forced-colors: active)");
    expect(css.match(/box-shadow:[^;]+/gu)).toEqual(["box-shadow: none"]);
    expect(css).not.toContain("gradient(");
    const source = readFileSync(fromPackageRoot("src/views/plan/PlanView.tsx"), "utf8");
    expect(source).not.toMatch(/consensus\(|tallyVotes|computeConsensus|@arbitra\/workflow/iu);
  });
});

/** TraceDetails as the run page uses it: the selection it reports becomes the one it shows. */
function Traced({ level, id }: { readonly level: TraceLevel; readonly id: string }): ReactElement {
  const [selected, setSelected] = useState({ level, id });
  const [api] = useState(() => new ArtifactApi());
  return <TraceDetails api={api} runId="run-1" level={selected.level} id={selected.id} onSelect={(next, value) => setSelected({ level: next, id: value })} />;
}

function stubArtifacts(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/runs/run-1/artifacts") return json(Object.keys(ARTIFACT_CONTENT).map((kind) => ({ artifactId: `artifact:${kind}`, kind, mediaType: "application/json", bytes: 256, redacted: true })));
    const match = /^\/runs\/run-1\/artifacts\/artifact%3A(.+)$/u.exec(path);
    const kind = match?.[1];
    if (kind !== undefined) return json({ artifactId: `artifact:${kind}`, kind, mediaType: "application/json", bytes: 256, redacted: true, content: JSON.stringify(ARTIFACT_CONTENT[kind]), truncated: false, continuationArtifactId: null });
    return json({}, 404);
  });
}
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
