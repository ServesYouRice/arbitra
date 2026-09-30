// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactApi } from "../../src/api/artifacts.js";
import { IssueBoardView } from "../../src/views/issue-board/IssueBoardView.js";
import { IssueDetails } from "../../src/views/issue-board/IssueDetails.js";
import { EMPTY_FILTERS, filterIssues, issueRows } from "../../src/views/issue-board/model.js";
import { ARTIFACT_CONTENT, findings, issueSet, operations, verifications } from "./fixtures.js";
import { fromPackageRoot } from "../package-root.js";

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

  it("gives each issue one line: severity as stripe width, consensus with its support, verification and the first location", async () => {
    stubArtifacts();
    render(<IssueBoardView api={new ArtifactApi()} runId="run-1" />);
    const first = (await screen.findByText("Role check missing on update")).closest("li");
    expect(first?.dataset.severity).toBe("critical");
    expect(within(first as HTMLElement).getByText("critical · blocker")).toBeTruthy();
    expect(within(first as HTMLElement).getByText("accepted · 2 of 3 support").dataset.state).toBe("verified");
    expect(within(first as HTMLElement).getByText("verified · cited_lines").dataset.state).toBe("verified");
    expect(within(first as HTMLElement).getByText("src/roles.ts:40-52")).toBeTruthy();
    const second = screen.getByText("Retry loop is unbounded").closest("li");
    expect(within(second as HTMLElement).getByText("single source · 1 of 3 support").dataset.state).toBe("unexamined");
    expect(within(second as HTMLElement).getByText("not verified").dataset.state).toBe("unexamined");
    // No dissent was recorded on the second issue, so its row makes no dissent claim at all.
    expect(within(second as HTMLElement).queryByText(/^dissent/u)).toBeNull();
  });

  it("says so when the plan takes a one-auditor issue because targeted verification confirmed it", async () => {
    const [first, second] = issueSet.issues;
    stubArtifacts({ ...ARTIFACT_CONTENT, "canonical-issues": { ...issueSet, issues: [first, { ...second, disposition: "verified_single_source", verificationOutcome: "CONFIRMED" }] } });
    render(<IssueBoardView api={new ArtifactApi()} runId="run-1" />);
    const row = (await screen.findByText("Retry loop is unbounded")).closest("li");
    expect(within(row as HTMLElement).getByText("single source · confirmed by verification · 1 of 3 support").dataset.state).toBe("unexamined");
  });

  it("keeps dissent visible on the row when filters combine", async () => {
    stubArtifacts();
    render(<IssueBoardView api={new ArtifactApi()} runId="run-1" />);
    expect(await screen.findByText("2 of 2 canonical issues shown")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("severity"), { target: { value: "critical" } });
    fireEvent.change(screen.getByLabelText("auditor"), { target: { value: "reviewer-c" } });
    fireEvent.change(screen.getByLabelText("consensus"), { target: { value: "accepted" } });
    fireEvent.change(screen.getByLabelText("verification"), { target: { value: "CONFIRMED" } });
    fireEvent.change(screen.getByLabelText("blocker"), { target: { value: "true" } });
    expect(screen.getByText("1 of 2 canonical issues shown")).toBeTruthy();
    const dissent = screen.getByText(/dissent · reviewer-c reject: the guard runs in middleware/);
    expect(dissent.dataset.state).toBe("dissent");
    expect(dissent.closest("details")).toBeNull();
    fireEvent.click(screen.getByText("clear filters"));
    expect(screen.getByText("2 of 2 canonical issues shown")).toBeTruthy();
    expect((screen.getByText("clear filters") as HTMLButtonElement).disabled).toBe(true);
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

  it("selects an issue from its row", async () => {
    stubArtifacts();
    const select = vi.fn();
    render(<IssueBoardView api={new ArtifactApi()} runId="run-1" selectedId="issue-2" onSelect={select} />);
    expect((await screen.findByRole("button", { name: "Retry loop is unbounded" })).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Role check missing on update" }));
    expect(select).toHaveBeenCalledWith("issue-1");
  });

  it("details an issue with its disagreement first, then the untrusted claim, the peer record and each source finding's evidence", async () => {
    stubArtifacts();
    render(<IssueDetails api={new ArtifactApi()} runId="run-1" candidateId="issue-1" />);
    const dissent = await screen.findByRole("region", { name: "dissent" });
    expect(within(dissent).getByText("reviewer-c · reject · the guard runs in middleware").dataset.state).toBe("dissent");
    expect(within(dissent).getByText("counter-evidence ce-1 · middleware asserts the role earlier").dataset.state).toBe("dissent");
    expect(within(screen.getByRole("region", { name: "claim" })).getByText("Any authenticated user can change another user's role.").dataset.state).toBe("tainted");
    const regions = screen.getAllByRole("region").map((region) => region.getAttribute("aria-label"));
    expect(regions.indexOf("dissent")).toBeLessThan(regions.indexOf("claim"));
    expect(screen.getByText("accepted · 2 of 3 reviewers support it")).toBeTruthy();
    expect(screen.getByText("verified · cited_lines")).toBeTruthy();
    expect(screen.getByText("accepted")).toBeTruthy();
    const peer = screen.getByRole("region", { name: "peer review" });
    expect(peer.textContent).toContain("round 1 · reviewer-a · vote · accept · cited lines");
    expect(peer.textContent).toContain("round 1 · reviewer-c · objection · middleware guard");
    const findings = screen.getByRole("region", { name: "source findings" });
    fireEvent.click(within(findings).getByText("reviewer-a/f-1 · critical · SECURITY"));
    expect(screen.getByLabelText("evidence for reviewer-a/f-1").textContent).toContain("updateRole runs before the authorization guard");
  });

  it("says so when a selected issue is not in the run's issue set", async () => {
    stubArtifacts();
    render(<IssueDetails api={new ArtifactApi()} runId="run-1" candidateId="issue-9" />);
    expect((await screen.findByText("issue issue-9 is not in this run's issue set")).dataset.state).toBe("unexamined");
  });

  it("labels an absent canonical issue artifact instead of rendering an empty board", async () => {
    vi.stubGlobal("fetch", async () => json([]));
    render(<IssueBoardView api={new ArtifactApi()} runId="run-1" />);
    expect((await screen.findByText("canonical issue artifact absent")).dataset.state).toBe("unexamined");
  });

  it("computes no consensus in the client and reads only persisted fields", () => {
    const source = ["src/views/issue-board/model.ts", "src/views/issue-board/IssueBoardView.tsx", "src/views/issue-board/IssueDetails.tsx", "src/views/issue-board/run-artifacts.ts"].map((path) => readFileSync(fromPackageRoot(path), "utf8")).join("\n");
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
    const tokens = readFileSync(fromPackageRoot("src/tokens.css"), "utf8");
    expect(tokens).toContain('[data-severity="critical"] { --stripe: 5px; }');
    const css = readFileSync(fromPackageRoot("src/views/issue-board/issue-board.css"), "utf8");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
    expect(css).not.toMatch(/data-severity[^{]*\{[^}]*color/iu);
    expect(css).toContain("var(--row-h)");
    expect(css).toContain("@media (forced-colors: active)");
    expect(css.match(/box-shadow:[^;]+/gu)).toEqual(["box-shadow: none"]);
    for (const state of screen.getAllByText(/^(dissent|consensus|verification|security coverage|suppression candidates|unexamined surfaces|minority findings retained) /u)) expect(state.textContent?.trim().length).toBeGreaterThan(0);
  });
});

function stubArtifacts(content: Readonly<Record<string, unknown>> = ARTIFACT_CONTENT): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/runs/run-1/artifacts") return json(Object.keys(content).map((kind) => ({ artifactId: `artifact:${kind}`, kind, mediaType: "application/json", bytes: 256, redacted: true })));
    const match = /^\/runs\/run-1\/artifacts\/artifact%3A(.+)$/u.exec(path);
    const kind = match?.[1];
    if (kind !== undefined) return json({ artifactId: `artifact:${kind}`, kind, mediaType: "application/json", bytes: 256, redacted: true, content: JSON.stringify(content[kind]), truncated: false, continuationArtifactId: null });
    return json({}, 404);
  });
}
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
