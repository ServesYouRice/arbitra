// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactApi } from "../../src/api/artifacts.js";
import { IssueBoardView } from "../../src/views/issue-board/IssueBoardView.js";
import { EMPTY_FILTERS, filterIssues, issueRows } from "../../src/views/issue-board/model.js";
import { ARTIFACT_CONTENT, findings, issueSet, operations, verifications } from "./fixtures.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("issue board over persisted artifacts", () => {
  it("reports the honest null summary and surfaces suppression candidates, unexamined surfaces and degraded coverage without a disclosure", async () => {
    stubArtifacts();
    render(<IssueBoardView api={new ArtifactApi()} runId="run-1" />);
    expect(await screen.findByText("3 auditors · 31 source findings · 2 accepted · 26 rejected · 2 unresolved · 1 single-source")).toBeTruthy();
    expect(screen.getByText(/security coverage · degraded · one security auditor unavailable/).dataset.state).toBe("degraded");
    expect(screen.getByText("suppression candidates · 1").dataset.state).toBe("tainted");
    expect(screen.getByText(/docs\/notes\.md · instruction risk high · read by reviewer-a/)).toBeTruthy();
    expect(screen.getByText(/billing · critical · risk 0\.9/).dataset.state).toBe("unexamined");
    expect(screen.getByText("Third auditor produced no parsable findings.").dataset.state).toBe("degraded");
    expect(screen.getByText("minority findings retained · 1").dataset.state).toBe("dissent");
  });

  it("shows every declared row field including verification result and method and the review denominator", async () => {
    stubArtifacts();
    render(<IssueBoardView api={new ArtifactApi()} runId="run-1" />);
    expect(await screen.findByText("Role check missing on update")).toBeTruthy();
    expect(screen.getByText("severity critical")).toBeTruthy();
    expect(screen.getByText("blocker · yes")).toBeTruthy();
    expect(screen.getByText("blocker · no")).toBeTruthy();
    expect(screen.getByText("status accepted")).toBeTruthy();
    expect(screen.getByText("consensus accepted").dataset.state).toBe("verified");
    expect(screen.getByText("support 2 of 3 reviewers")).toBeTruthy();
    expect(screen.getByText("verification CONFIRMED · method cited_lines").dataset.state).toBe("verified");
    expect(screen.getByText(/source auditors · reviewer-a, reviewer-b, reviewer-c · SECURITY/)).toBeTruthy();
    expect(screen.getByText("votes 1 · objections 1 · supplements 1")).toBeTruthy();
    expect(screen.getByText("src/roles.ts:40-52")).toBeTruthy();
    expect(screen.getByText(/counter-evidence · ce-1: middleware asserts the role earlier/).dataset.state).toBe("dissent");
    expect(screen.getByText(/verification not run · method unavailable/).dataset.state).toBe("unexamined");
  });

  it("keeps dissent visible when filters combine", async () => {
    stubArtifacts();
    render(<IssueBoardView api={new ArtifactApi()} runId="run-1" />);
    expect(await screen.findByText("2 of 2 canonical issues shown")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("severity"), { target: { value: "critical" } });
    fireEvent.change(screen.getByLabelText("auditor"), { target: { value: "reviewer-c" } });
    fireEvent.change(screen.getByLabelText("consensus state"), { target: { value: "accepted" } });
    fireEvent.change(screen.getByLabelText("verification outcome"), { target: { value: "CONFIRMED" } });
    fireEvent.change(screen.getByLabelText("blocker"), { target: { value: "true" } });
    expect(screen.getByText("1 of 2 canonical issues shown")).toBeTruthy();
    const dissent = screen.getByText(/dissent · reviewer-c reject: the guard runs in middleware/);
    expect(dissent.dataset.state).toBe("dissent");
    expect(dissent.closest("details")).toBeNull();
    fireEvent.click(screen.getByText("clear filters"));
    expect(screen.getByText("2 of 2 canonical issues shown")).toBeTruthy();
  });

  it("filters by status and category and reports an empty combination honestly", async () => {
    stubArtifacts();
    render(<IssueBoardView api={new ArtifactApi()} runId="run-1" />);
    expect(await screen.findByText("2 of 2 canonical issues shown")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("status"), { target: { value: "open" } });
    expect(screen.getByText("1 of 2 canonical issues shown")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("category"), { target: { value: "SECURITY" } });
    expect(screen.getByText("no canonical issue matches these filters").dataset.state).toBe("unexamined");
  });

  it("reaches persisted source findings and their evidence from a row", async () => {
    stubArtifacts();
    const select = vi.fn();
    render(<IssueBoardView api={new ArtifactApi()} runId="run-1" onSelectFinding={select} />);
    fireEvent.click(await screen.findByText("reviewer-a/f-1"));
    expect(select).toHaveBeenCalledWith("reviewer-a/f-1");
    fireEvent.click(screen.getByText("Role check missing on update"));
    expect(screen.getByLabelText("evidence for issue-1").textContent).toContain("updateRole runs before the authorization guard");
  });

  it("labels an absent canonical issue artifact instead of rendering an empty board", async () => {
    vi.stubGlobal("fetch", async () => json([]));
    render(<IssueBoardView api={new ArtifactApi()} runId="run-1" />);
    expect((await screen.findByText("canonical issue artifact absent")).dataset.state).toBe("unexamined");
  });

  it("computes no consensus in the client and reads only persisted fields", () => {
    const source = ["src/views/issue-board/model.ts", "src/views/issue-board/IssueBoardView.tsx", "src/views/issue-board/run-artifacts.ts"].map((path) => readFileSync(resolve(process.cwd(), path), "utf8")).join("\n");
    expect(source).not.toMatch(/consensus\(|tallyVotes|computeConsensus|riskWeighted|@arbitra\/workflow/iu);
    const rows = issueRows({ issueSet, findings, operations, verifications });
    expect(rows[0]).toMatchObject({ supportCount: 2, reviewDenominator: 3, consensusState: "accepted", status: "accepted", verificationMethod: "cited_lines" });
    expect(rows[1]).toMatchObject({ consensusState: "single_source", verificationOutcome: null, verificationMethod: null, status: "open" });
    expect(filterIssues(rows, { ...EMPTY_FILTERS, auditor: "reviewer-c" }).map(({ candidateId }) => candidateId)).toEqual(["issue-1"]);
  });

  it("encodes severity as stripe width and keeps every state legible without hue", async () => {
    stubArtifacts();
    render(<IssueBoardView api={new ArtifactApi()} runId="run-1" />);
    const rows = await screen.findAllByRole("listitem");
    const critical = rows.find((row) => row.dataset.candidateId === "issue-1");
    expect(critical?.dataset.severity).toBe("critical");
    expect(rows.find((row) => row.dataset.candidateId === "issue-2")?.dataset.severity).toBe("medium");
    const tokens = readFileSync(resolve(process.cwd(), "src/tokens.css"), "utf8");
    expect(tokens).toContain('[data-severity="critical"] { --stripe: 5px; }');
    const css = readFileSync(resolve(process.cwd(), "src/views/issue-board/issue-board.css"), "utf8");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
    expect(css).not.toMatch(/data-severity[^{]*\{[^}]*color/iu);
    expect(css).toContain("var(--row-h)");
    expect(css).toContain("@media (forced-colors: active)");
    expect(css.match(/box-shadow:[^;]+/gu)).toEqual(["box-shadow: none"]);
    for (const state of screen.getAllByText(/^(dissent|consensus|verification|security coverage|suppression candidates|unexamined surfaces|minority findings retained) /u)) expect(state.textContent?.trim().length).toBeGreaterThan(0);
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
