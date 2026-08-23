// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactApi } from "../../src/api/artifacts.js";
import { PlanView } from "../../src/views/plan/PlanView.js";
import { backward, forward, type TraceGraph } from "../../src/views/plan/traceability.js";
import { ARTIFACT_CONTENT, findings, issueSet, plan } from "./fixtures.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const graph: TraceGraph = { plan, issues: issueSet.issues, findings };

describe("plan view and traceability navigation", () => {
  it("shows canonical issue counts, validation contract, tasks, routing, dependency graph, critic feedback and premise honesty", async () => {
    stubArtifacts();
    render(<PlanView api={new ArtifactApi()} runId="run-1" />);
    expect(await screen.findByText("Authorization repair · mode audit · 1 accepted canonical issues · 1 tasks")).toBeTruthy();
    expect(screen.getByText(/premise · null · smoke_test_only_not_proof · one repository, one run/).dataset.state).toBe("unexamined");
    expect(screen.getByText(/Unauthorized users cannot change another user's role\. · evidence authorization regression test/)).toBeTruthy();
    expect(screen.getByText(/Enforce the role guard · frontier \/ high · recommended frontier \/ high · security critical/)).toBeTruthy();
    expect(screen.getByText("TASK-001 → TASK-002")).toBeTruthy();
    expect(screen.getByText("One blocking gap in validation coverage.")).toBeTruthy();
    expect(screen.getByText(/validation_gap · blocking · No assertion covers the invite flow\./).dataset.state).toBe("refuted");
    expect(screen.getByText(/Q-1 · Is the invite flow in scope\? · blast radius high/).dataset.state).toBe("refuted");
  });

  it("reaches source evidence from a task in four clicks", async () => {
    stubArtifacts();
    render(<PlanView api={new ArtifactApi()} runId="run-1" />);
    fireEvent.click(await screen.findByText("TASK-001"));
    fireEvent.click(within(screen.getByLabelText("forward links")).getByText("validation · VAL-001"));
    fireEvent.click(within(screen.getByLabelText("forward links")).getByText("issue · issue-1"));
    fireEvent.click(within(screen.getByLabelText("forward links")).getByText("finding · reviewer-a/f-1"));
    const trail = screen.getByLabelText("traceability trail");
    expect(within(trail).getByText("task · TASK-001")).toBeTruthy();
    expect(within(screen.getByLabelText("forward links")).getByText("evidence · ev-1")).toBeTruthy();
    expect(screen.getByLabelText("forward links").textContent).toContain("updateRole runs before the authorization guard");
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

  it("navigates backward through the rendered view and lets the trail be rewound", async () => {
    stubArtifacts();
    render(<PlanView api={new ArtifactApi()} runId="run-1" />);
    fireEvent.click(await screen.findByText("VAL-001"));
    fireEvent.click(within(screen.getByLabelText("backward links")).getByText("task · TASK-001"));
    expect(within(screen.getByLabelText("traceability trail")).getByText("task · TASK-001")).toBeTruthy();
    fireEvent.click(within(screen.getByLabelText("traceability trail")).getByText("validation · VAL-001"));
    expect(screen.getByLabelText("traceability trail").querySelectorAll("li")).toHaveLength(1);
    fireEvent.click(screen.getByText("clear trail"));
    expect(screen.getByText(/select a task or validation assertion to trace it/).dataset.state).toBe("unexamined");
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
      return match === null ? json({}, 404) : json({ artifactId: `artifact:${match[1]!}`, kind: match[1]!, mediaType: "application/json", bytes: 256, redacted: true, content: JSON.stringify(ARTIFACT_CONTENT[match[1]!]), truncated: false, continuationArtifactId: null });
    });
    render(<PlanView api={new ArtifactApi()} runId="run-1" />);
    expect((await screen.findByText("critic feedback absent")).dataset.state).toBe("unexamined");
  });

  it("uses only the supplied scales and keeps dense rows monochrome-legible", () => {
    const css = readFileSync(resolve(process.cwd(), "src/views/plan/plan.css"), "utf8");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
    expect(css).toContain("var(--row-h)");
    expect(css).toContain("border-radius: var(--radius)");
    expect(css).toContain("@media (forced-colors: active)");
    expect(css.match(/box-shadow:[^;]+/gu)).toEqual(["box-shadow: none"]);
    expect(css).not.toContain("gradient(");
    const source = readFileSync(resolve(process.cwd(), "src/views/plan/PlanView.tsx"), "utf8");
    expect(source).not.toMatch(/consensus\(|tallyVotes|computeConsensus|@arbitra\/workflow/iu);
  });
});

function stubArtifacts(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/runs/run-1/artifacts") return json(Object.keys(ARTIFACT_CONTENT).map((kind) => ({ artifactId: `artifact:${kind}`, kind, mediaType: "application/json", bytes: 256, redacted: true })));
    const match = /^\/runs\/run-1\/artifacts\/artifact%3A(.+)$/u.exec(path);
    if (match !== null) return json({ artifactId: `artifact:${match[1]!}`, kind: match[1]!, mediaType: "application/json", bytes: 256, redacted: true, content: JSON.stringify(ARTIFACT_CONTENT[match[1]!]), truncated: false, continuationArtifactId: null });
    return json({}, 404);
  });
}
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
