// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequirementsResource } from "../../src/api/operator.js";
import type { RunResource } from "../../src/api/runs.js";
import { FeatureView } from "../../src/views/feature/FeatureView.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const injected = '<img src=x onerror="window.__featureInjected=1">';
const contract = (artifactId: string, accepted: boolean): RequirementsResource => ({
  artifactId, pendingAmbiguityIds: accepted ? [] : ["migration"],
  contract: { schemaVersion: 1, featureRequest: "Add session preferences", assumptions: [{ id: "assumption", statement: `Keep sessions ${injected}`, confidence: "high" }],
    ambiguities: [{ id: "migration", question: "Migrate?", proposedDefault: "Keep sessions", blastRadius: "high" }, { id: "naming", question: "Naming?", proposedDefault: "camelCase", blastRadius: "low" }],
    acceptance: [{ id: "acceptance", assertion: "Sessions keep preferences" }], outOfScope: [],
    decision: { mode: "interactive", acceptedDefaults: accepted ? [{ ambiguityId: "migration", value: "Keep sessions", acceptedBy: "operator" }] : [] } },
});
const run: RunResource = { runId: "run-1", state: "BLOCKED", resumable: true, checkpoints: [], workflow: { id: "feature-simple", nodes: [], edges: [] } };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

describe("Feature contract controls", () => {
  it("inspects the contract as text, approves the selected default and reports a stale version", async () => {
    const calls: { path: string; body: unknown }[] = [];
    let current = contract("contract-a", false);
    let stale = true;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input); const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown;
      calls.push({ path, body });
      if (path === "/runs/run-1/requirements") return json(current);
      if (path.endsWith("/approve")) {
        if (stale) { stale = false; current = contract("contract-b", false); return json({ statusCode: 409, error: "REQUEST_FAILED", message: "STALE_REQUIREMENTS_CHECKPOINT" }, 409); }
        current = contract("contract-b", true); return json(current);
      }
      return json({}, 404);
    });
    render(<FeatureView runId="run-1" run={run} artifacts={[]} />);
    expect(await screen.findByText(/Keep sessions <img src=x/u)).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("no operator approval required at this blast radius")).toBeTruthy();
    const approve = screen.getByRole("button", { name: "approve selected defaults" }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("approve default for migration"));
    fireEvent.click(approve);
    expect((await screen.findByRole("alert")).textContent).toContain("stale · refused by the server · STALE_REQUIREMENTS_CHECKPOINT");
    expect(calls.find(({ path }) => path.endsWith("/approve"))?.body).toEqual({ artifactId: "contract-a", ambiguityIds: ["migration"] });
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "reload contract" }));
    expect(await screen.findByText("contract-b")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("approve default for migration"));
    fireEvent.click(screen.getByRole("button", { name: "approve selected defaults" }));
    expect(await screen.findByText("accepted by operator")).toBeTruthy();
    expect(calls.filter(({ path }) => path.endsWith("/approve")).at(-1)?.body).toEqual({ artifactId: "contract-b", ambiguityIds: ["migration"] });
    // Approval never resumes: no resume request was made.
    expect(calls.some(({ path }) => path.endsWith("/resume"))).toBe(false);
  });

  it("revises the draft, applies a proposal and resumes only on request", async () => {
    const proposal = { artifactId: "proposal-1", baseArtifactId: "contract-a", reviewArtifactId: "review", modelProfileId: "planner", revision: { draft: { ...contract("x", false).contract, ambiguities: [{ id: "migration", question: "Migrate?", proposedDefault: "Keep sessions (revised)", blastRadius: "high" as const }] }, lineage: [], addedRequirementIds: [], resolutions: [{ requirementId: "migration", resolution: "Clarified" }] } };
    const calls: { path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input); calls.push({ path, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown });
      if (path === "/runs/run-1/requirements") return json({ ...contract("contract-a", true), revisionProposal: proposal });
      if (path.endsWith("/revise") || path.endsWith("/apply-revision")) return json(contract("contract-c", false));
      if (path.endsWith("/resume")) return json({ ...run, state: "RUNNING" });
      return json({}, 404);
    });
    const resumed = vi.fn();
    render(<FeatureView runId="run-1" run={run} artifacts={[]} onResumed={resumed} />);
    expect((await screen.findByLabelText("proposed changes")).textContent).toContain("migration · proposedDefault · Keep sessions → Keep sessions (revised)");
    fireEvent.click(screen.getByRole("button", { name: "revise draft" }));
    const editor = screen.getByLabelText("draft JSON") as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "{not json" } });
    fireEvent.click(screen.getByRole("button", { name: "submit revision" }));
    expect((await screen.findByRole("alert")).textContent).toContain("DRAFT_NOT_JSON");
    fireEvent.change(editor, { target: { value: JSON.stringify({ assumptions: [], ambiguities: [], acceptance: [], outOfScope: [] }) } });
    fireEvent.click(screen.getByRole("button", { name: "submit revision" }));
    await waitFor(() => expect(calls.some(({ path }) => path.endsWith("/revise"))).toBe(true));
    fireEvent.click(await screen.findByRole("button", { name: "apply proposal" }));
    await waitFor(() => expect(calls.find(({ path }) => path.endsWith("/apply-revision"))?.body).toEqual({ artifactId: "proposal-1" }));
    expect(resumed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "resume run" }));
    await waitFor(() => expect(resumed).toHaveBeenCalledWith(expect.objectContaining({ state: "RUNNING" })));
  });

  it("states when the selected run is not a Feature run", () => {
    render(<FeatureView runId="run-1" run={{ ...run, workflow: { id: "audit-deep", nodes: [], edges: [] } }} artifacts={[]} />);
    expect(screen.getByText("not a Feature run · workflow audit-deep")).toBeTruthy();
  });
});
