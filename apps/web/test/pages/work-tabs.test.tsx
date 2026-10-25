// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/app/App.js";
import { address, stubBrowser, stubControlPlane, visit } from "../support.js";
import { artifactRoutes, BALANCED_WORKFLOW, EMPTY_TRACES, metrics, modelOverview, resource } from "./fixtures.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); visit(""); });

const main = (): HTMLElement => document.querySelector("main") as HTMLElement;
/** The open tab, without the header and its links. */
const tab = (): HTMLElement => document.querySelector(".run-main") as HTMLElement;

const profile = (provider: string, modelId: string, word: "effort" | "reasoning_effort") => ({ provider, modelId, family: provider, transport: `${provider}-cli`, capabilityTier: "frontier", independenceGroup: provider,
  effort: { params: { medium: { [word]: "high" }, high: { [word]: "xhigh" } } } });
/** A balanced audit: Opus and Sol find, Opus checks the critical and high issues and Sonnet the medium ones. */
const CONFIGURATION = Object.freeze({
  mode: "audit", auditDepth: "deep",
  models: { "auditor-a": profile("anthropic", "claude-opus-5-5", "effort"), "auditor-b": profile("openai", "gpt-6.1-sol", "reasoning_effort"), "checker-medium": { ...profile("anthropic", "claude-sonnet-5-5", "effort"), capabilityTier: "balanced" } },
  workflow: { modelExecution: { roles: { planner: "auditor-a", verifier: "auditor-a", mediumVerifier: "checker-medium", critic: "auditor-b" }, stageEffort: { verification: "medium", planner: "medium", critic: "medium" } } },
});
const OVERVIEW = modelOverview({ configuration: CONFIGURATION, repository: "/work/rokbot" });

const LONG_PATH = "frontend/src/components/teaching/advanced-editor/StructuredFieldsAndAdvancedJsonSynchronisation.tsx";
const finding = (id: string, title: string, severity: string, path: string, line: number, evidence: string) => ({ sourceFindingId: id, category: "CORRECTNESS", title, severity, status: "confirmed", productionBlocker: false,
  locations: [{ id: `${id}/L1`, path, startLine: line, endLine: line + 10 }], evidence: [{ id: `${id}/E1`, text: evidence, locationIds: [`${id}/L1`] }] });
const FINDINGS = [
  finding("auditor-a/scope-1/role-check", "Role check missing on update", "critical", "src/roles.ts", 40, "updateRole runs before the authorization guard"),
  finding("auditor-b/scope-2/role-guard", "Role guard runs late", "critical", "src/roles.ts", 41, "the guard is registered after the route"),
  finding("auditor-b/scope-3/retry", "Retry loop never gives up", "medium", "src/retry.ts", 8, "while (true) { await attempt(); }"),
  finding("auditor-a/scope-4/token-log", "Session token may leak in logs", "high", "src/log.ts", 12, "log.info(request.headers)"),
  finding("auditor-a/scope-5/role-reject", "Admin route lacks a role check", "high", "src/admin.ts", 3, "router.post('/admin', handler)"),
  finding("auditor-a/scope-6/typo", "A comment misspells receive", "low", "src/util.ts", 1, "// recieve"),
  finding("auditor-a/scope-7/json", "Advanced JSON edits are overwritten", "medium", LONG_PATH, 242, "setFields(parse(json))"),
];
const issue = (candidateId: string, title: string, severity: string, disposition: string, verificationOutcome: string | null, sourceFindingIds: string[], extra: Record<string, unknown> = {}) => ({
  candidateId, claim: { trust: "untrusted_data", title, description: `${title}: what goes wrong, in the finder's words.` }, severity, blocker: false, disposition, consensusClaim: null, supportCount: 0, reviewDenominator: 2,
  dissent: [], counterEvidence: [], sourceFindingIds, verificationOutcome, coverage: { reviewedBy: [], missingReviewers: [] }, singleSource: false, ...extra });
const ISSUES = [
  issue("C-med", "Retry loop never gives up", "medium", "accepted", "CONFIRMED", ["auditor-b/scope-3/retry"], { dissent: [{ authorId: "auditor-a", disposition: "reject", citedEvidenceIds: [], reason: "The caller stops it after a minute." }] }),
  issue("C-crit", "Role check missing on update", "critical", "accepted", "CONFIRMED", ["auditor-a/scope-1/role-check", "auditor-b/scope-2/role-guard"], { verificationReason: "updateRole runs before the guard registered at line 44." }),
  issue("C-uns", "Session token may leak in logs", "high", "needs_verification", "STILL_NEEDS_VERIFICATION", ["auditor-a/scope-4/token-log"], { verificationReason: "It depends on the log level set in production." }),
  issue("C-rej", "Admin route lacks a role check", "high", "rejected", "REJECTED", ["auditor-a/scope-5/role-reject"], { verificationReason: "The admin router asserts the role in its middleware first." }),
  issue("C-low", "A comment misspells receive", "low", "non_consensus", null, ["auditor-a/scope-6/typo"]),
  issue("C-var", "Advanced JSON edits are overwritten", "medium", "accepted", "CONFIRMED", ["auditor-a/scope-7/json"], { variantOf: "C-crit" }),
];
const ISSUE_SET = { schemaVersion: 1, issues: ISSUES, minorityFindingIds: [], limitations: ["A unit stopped at its output ceiling."],
  coverage: { complete: false, securityCoverage: { degraded: true, reason: "source_snapshot_only_no_runtime_or_deployment_security_evidence" }, suppressionCandidates: [], unexaminedSurfaces: [{ auditorId: "auditor-a", surface: "module_joint_context:src" }] },
  summary: { auditorCount: 2, sourceFindingCount: 7, acceptedCount: 3, rejectedCount: 1, unresolvedCount: 2, singleSourceCount: 0 } };
const operation = (candidateId: string, result: string) => ({ authorId: "verification", candidateId, operationId: `verification:0:${candidateId}`, round: 0, type: "accept", reason: "Verification ran.",
  verification: { activityId: `verification/${candidateId}/question`, method: "single_model_question", result, evidenceIds: [], artifactRefs: [], toolCallIds: [] } });
const PLAN = {
  id: "plan-1", title: "Authorization; Retries", mode: "audit", acceptedIssueIds: ["C-crit", "C-med", "C-var"], validationContract: { validation: [] }, taskGraph: [], routingRecommendations: [],
  traceability: { issueToValidation: [], requirementLinks: { links: [] } }, premiseReport: { status: "null", interpretation: "smoke_test_only_not_proof", limitations: [] },
  unresolvedQuestions: [{ id: "section-abc/Q-001", question: "Which deployment decides which forwarded headers to trust?", blocking: true, blastRadius: "high" }, { id: "section-abc/Q-002", question: "Which colour for the warning?", blocking: false, blastRadius: "low" }],
  tasks: [
    { id: "TASK-001", title: "Enforce the role guard", goal: { objective: "Only an admin can change a role.", doneWhen: ["A test that changes a role as a member fails before and passes after."] }, addresses: { issues: ["C-crit"], validation: [], requirements: [] },
      routing: { capability: "frontier", effort: "high", reason: ["security critical"] }, dependencies: { dependsOn: [], blocks: [], conflictsWith: [] }, scope: { likelyFiles: ["src/roles.ts"] }, acceptanceCriteria: ["Members get 403."] },
    { id: "TASK-002", title: "Bound the retry loop", goal: { objective: "Retries stop after five attempts.", doneWhen: ["The retry test passes."] }, addresses: { issues: ["C-med", "C-var"], validation: [], requirements: [] },
      routing: { capability: "balanced", effort: "medium", reason: [] }, dependencies: { dependsOn: ["TASK-001"], blocks: [], conflictsWith: [] }, scope: { likelyFiles: ["src/retry.ts"] }, acceptanceCriteria: [] },
    { id: "TASK-003", title: "Rename the log field", goal: { objective: "The field reads as its name.", doneWhen: [] }, addresses: { issues: [], validation: [], requirements: [] },
      routing: { capability: "fast", effort: "low", reason: [] }, dependencies: { dependsOn: ["TASK-002"], blocks: [], conflictsWith: [] }, scope: { likelyFiles: ["src/retry.ts"] }, acceptanceCriteria: [] },
  ],
};
const CONTENT = {
  "canonical-issues": ISSUE_SET, "source-findings": FINDINGS, "issue-operations": [], "plan-ir": PLAN,
  "verification-results": ISSUES.filter(({ verificationOutcome }) => verificationOutcome !== null).map(({ candidateId, verificationOutcome }) => ({ candidateId, method: "single_model_question", result: verificationOutcome })),
  "verification-operations": ISSUES.filter(({ verificationOutcome }) => verificationOutcome !== null).map(({ candidateId, verificationOutcome }) => operation(candidateId, verificationOutcome ?? "")),
  "verification-below-plan-scope": { candidateIds: ["C-low"] },
  "verification-second-opinion-C-rej": { candidateId: "C-rej", modelProfileId: "auditor-b", first: { activityId: "verification/C-rej/question", confidence: 0.7, outcome: "REJECTED" }, second: { activityId: "verification/C-rej/second-opinion", confidence: 0.9, outcome: "REJECTED" } },
  "critic-feedback": { summary: "Two objections.", items: [{ id: "PC-1", category: "invariant_violations", blocking: true, summary: "TASK-001 logs and continues when the lock fails.", taskIds: ["TASK-001"], issueIds: ["C-crit"] }], revision: { notRevisedCritiqueItemIds: [] } },
};
/** Who checked each issue, as the run's model attempts recorded it: Opus the severe ones, Sonnet the medium ones. */
const trace = (activityId: string, modelId: string) => ({ traceId: activityId, trace: { runId: "run-1", nodeId: "verification", activityId: `${activityId}/turn-0`, attempt: 1, modelId, effortResolved: "medium", effortRequested: "medium", outcome: "success", durationMs: 1000 } });
const TRACES = { entries: [trace("verification/C-crit/question", "claude-opus-5-5"), trace("verification/C-med/question", "claude-sonnet-5-5"), trace("verification/C-var/question", "claude-sonnet-5-5"),
  trace("verification/C-uns/question", "claude-opus-5-5"), trace("verification/C-rej/question", "claude-opus-5-5"), trace("verification/C-rej/second-opinion", "gpt-6.1-sol")], total: 6, offset: 0, nextOffset: null, facets: { nodeIds: ["verification"], modelIds: [], protocolIds: [] } };
const OUTLINE = {
  questions: PLAN.unresolvedQuestions.map(({ id, question, blocking }) => ({ id, question, blocking })),
  tasks: [{ id: "TASK-001", title: "Enforce the role guard", tier: "frontier", folder: "1-strong-model", after: [], sameFilesAs: [], issues: ["C-crit"] },
    { id: "TASK-002", title: "Bound the retry loop", tier: "balanced", folder: "2-balanced-model", after: ["TASK-001"], sameFilesAs: [], issues: ["C-med", "C-var"] },
    { id: "TASK-003", title: "Rename the log field", tier: "fast", folder: "3-fast-model", after: [], sameFilesAs: ["TASK-002"], issues: [] }],
  checks: [{ candidateId: "C-uns", title: "Session token may leak in logs", severity: "high" }], checksFolder: "4-unsure", alsoFound: 0, unverified: 1,
};

function routes(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { "GET /runs/run-1": resource({ workflow: BALANCED_WORKFLOW }), "GET /runs/run-1/overview": OVERVIEW, "GET /runs/run-1/metrics": metrics(), "GET /runs/run-1/traces*": TRACES,
    "GET /handoff/runs/run-1": { saved: [] }, "GET /handoff/runs/run-1/outline": OUTLINE, "GET /handoff/runs/run-1/results": { results: null }, ...artifactRoutes("run-1", CONTENT), ...extra };
}
const row = (title: string): HTMLElement => screen.getByRole("button", { name: title }).closest("li") as HTMLElement;

describe("the Issues tab", () => {
  it("groups the issues by what the check decided, most severe first, each with its place, who found it and who checked it, by model and effort", async () => {
    stubBrowser();
    stubControlPlane(routes());
    visit("?run=run-1&view=issues");
    render(<App />);
    expect(await screen.findByText("6 issues · 3 confirmed · 1 unsettled · 1 rejected · 1 not checked")).toBeTruthy();
    const verdicts = screen.getByRole("tablist", { name: "verdict" });
    expect(within(verdicts).getAllByRole("tab").map((tab) => [tab.textContent, tab.getAttribute("aria-selected")])).toEqual([["Confirmed · 3", "true"], ["Unsettled · 1", "false"], ["Rejected · 1", "false"], ["Not checked · 1", "false"]]);
    const confirmed = screen.getByRole("tabpanel", { name: "confirmed issues" });
    expect(within(confirmed).getByText("1 critical · 2 medium · all in the plan")).toBeTruthy();
    // Most severe first; within a severity, as the run recorded them.
    expect([...confirmed.querySelectorAll(".issue-row__title")].map((title) => title.textContent)).toEqual(["Role check missing on update", "Retry loop never gives up", "Advanced JSON edits are overwritten"]);
    const critical = row("Role check missing on update");
    expect(critical.dataset.severity).toBe("critical");
    expect(within(critical).getByText("src/roles.ts:40 · and 1 more place")).toBeTruthy();
    expect(within(critical).getByText("found by Opus 5.5 · xhigh and GPT-6.1 Sol · xhigh")).toBeTruthy();
    // The checker each issue had, from the run's records: Opus for the critical one, Sonnet for the medium ones.
    expect(await within(critical).findByText("checked by Opus 5.5 · high")).toBeTruthy();
    expect(within(row("Retry loop never gives up")).getByText("checked by Sonnet 5.5 · high")).toBeTruthy();
    // Where models disagreed, the row says so (R5).
    expect(within(row("Retry loop never gives up")).getByText("disputed · Opus 5.5 · xhigh rejected it: The caller stops it after a minute.").dataset.state).toBe("dissent");
    fireEvent.click(within(row("Advanced JSON edits are overwritten")).getByRole("link", { name: "C-crit" }));
    await waitFor(() => expect(address().get("item")).toBe("issue:C-crit"));
    expect(row("Advanced JSON edits are overwritten").textContent).toContain("variant of C-crit");
    // An issue without a variant says nothing of one.
    expect(critical.textContent).not.toContain("variant");

    fireEvent.click(within(verdicts).getByRole("tab", { name: "Rejected · 1" }));
    const rejected = screen.getByRole("tabpanel", { name: "rejected issues" });
    expect(within(rejected).getByText("The admin router asserts the role in its middleware first.")).toBeTruthy();
    fireEvent.click(within(verdicts).getByRole("tab", { name: "Unsettled · 1" }));
    expect(within(screen.getByRole("tabpanel", { name: "unsettled issues" })).getByText(/The plan checks them after its tasks/u)).toBeTruthy();
    fireEvent.click(within(verdicts).getByRole("tab", { name: "Not checked · 1" }));
    expect(within(row("A comment misspells receive")).getByText("not checked: below the plan's bar")).toBeTruthy();
    // Words on the main line, codes in the details.
    expect(tab().textContent).not.toMatch(/CONFIRMED|REJECTED|STILL_NEEDS_VERIFICATION|needs_verification|non_consensus|single_model_question|canonical|auditor-a|source_snapshot/u);
  });

  it("finds issues by file or words, and shows the rest of a long group on request", async () => {
    stubBrowser();
    const many = Array.from({ length: 30 }, (_, index) => issue(`C-l${index}`, `Low issue number ${index}`, "low", "non_consensus", null, ["auditor-a/scope-6/typo"]));
    stubControlPlane(routes(artifactRoutes("run-1", { ...CONTENT, "canonical-issues": { ...ISSUE_SET, issues: [...ISSUES, ...many] } })));
    visit("?run=run-1&view=issues");
    render(<App />);
    const find = await screen.findByRole("searchbox", { name: "Find" });
    fireEvent.change(find, { target: { value: "retry.ts" } });
    const confirmed = screen.getByRole("tabpanel", { name: "confirmed issues" });
    expect([...confirmed.querySelectorAll(".issue-row__title")].map((title) => title.textContent)).toEqual(["Retry loop never gives up"]);
    expect(within(confirmed).getByText("1 of 3 match")).toBeTruthy();
    fireEvent.change(find, { target: { value: "" } });
    fireEvent.click(screen.getByRole("tab", { name: "Not checked · 31" }));
    const unchecked = screen.getByRole("tabpanel", { name: "not checked issues" });
    expect(unchecked.querySelectorAll(".issue-row")).toHaveLength(25);
    fireEvent.click(within(unchecked).getByRole("button", { name: "Show 6 more" }));
    expect(unchecked.querySelectorAll(".issue-row")).toHaveLength(31);
  });

  it("opens an issue one click down: what was disputed, the finder's words, the evidence, who checked it and why, and the task that fixes it", async () => {
    stubBrowser();
    stubControlPlane(routes());
    visit("?run=run-1&view=issues&item=issue:C-crit");
    render(<App />);
    const details = await screen.findByRole("complementary", { name: "details · issue C-crit" });
    expect(await within(details).findByRole("heading", { name: "Role check missing on update" })).toBeTruthy();
    expect(within(details).getByText("critical · confirmed · src/roles.ts:40–50")).toBeTruthy();
    expect(within(details).getByText("Role check missing on update: what goes wrong, in the finder's words.").dataset.state).toBe("tainted");
    expect(within(details).getByText("updateRole runs before the authorization guard")).toBeTruthy();
    expect(await within(details).findByText("Checked by Opus 5.5 · high against the code: confirmed.")).toBeTruthy();
    expect(within(details).getByText("updateRole runs before the guard registered at line 44.")).toBeTruthy();
    const fixedBy = within(details).getByRole("link", { name: "TASK-001 Enforce the role guard" });
    expect(new URL(fixedBy.getAttribute("href") ?? "", "http://localhost").searchParams.get("view")).toBe("plan");
    const codes = within(details).getByText("Recorded codes").closest("details") as HTMLDetailsElement;
    expect(within(codes).getByText(/CONFIRMED/u)).toBeTruthy();
    // A disputed issue says so before its conclusion; a rejected one shows the second model asked before rejecting it.
    fireEvent.click(within(row("Retry loop never gives up")).getByRole("button", { name: "Retry loop never gives up" }));
    const disputed = await screen.findByRole("complementary", { name: "details · issue C-med" });
    const sections = [...disputed.querySelectorAll("section")].map((section) => section.getAttribute("aria-label"));
    expect(sections.indexOf("disputed")).toBeLessThan(sections.indexOf("the check"));
    fireEvent.click(screen.getByRole("tab", { name: "Rejected · 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Admin route lacks a role check" }));
    const rejected = await screen.findByRole("complementary", { name: "details · issue C-rej" });
    expect(await within(rejected).findByText("Asked a second model before rejecting it: GPT-6.1 Sol · high also rejected it.")).toBeTruthy();
  });

  it("says once, not on every row, that a run from before the check gave reasons has none", async () => {
    stubBrowser();
    // The artifact is JSON, so an undefined reason is no reason at all.
    const unreasoned = ISSUES.map((entry) => ({ ...entry, verificationReason: undefined }));
    stubControlPlane(routes(artifactRoutes("run-1", { ...CONTENT, "canonical-issues": { ...ISSUE_SET, issues: unreasoned } })));
    visit("?run=run-1&view=issues");
    render(<App />);
    fireEvent.click(await screen.findByRole("tab", { name: "Rejected · 1" }));
    const rejected = screen.getByRole("tabpanel", { name: "rejected issues" });
    expect(within(rejected).getByText("The check found these are not problems. This run's check gave no reasons: runs before October 25, 2026 did not ask it for one.")).toBeTruthy();
    expect(row("Admin route lacks a role check").querySelector(".issue-row__reason")).toBeNull();
  });

  it("folds what the audit could not see below the issues, in words", async () => {
    stubBrowser();
    stubControlPlane(routes());
    visit("?run=run-1&view=issues");
    render(<App />);
    const unseen = (await screen.findByText("What the audit could not see")).closest("details") as HTMLDetailsElement;
    expect(unseen.open).toBe(false);
    expect(within(unseen).getByText(/It read the source only, not how the project runs or is deployed/u)).toBeTruthy();
  });
});

describe("the Plan tab", () => {
  it("shows the plan as its saved folder has it: the questions first, the tasks in order with their model and what they wait for, then the issues to check after them", async () => {
    stubBrowser();
    stubControlPlane(routes());
    visit("?run=run-1&view=plan");
    render(<App />);
    const card = await screen.findByRole("region", { name: "The plan is ready · 3 tasks for 3 issues" });
    expect(within(card).getByRole("button", { name: "Save the plan into the project" })).toBeTruthy();
    // On the Plan tab the card does not send the person to the Plan tab.
    expect(within(card).queryByRole("link", { name: "Read it first" })).toBeNull();
    const questions = await screen.findByRole("region", { name: "1 · Answer first · 1 question" });
    expect(within(questions).getByText("Which deployment decides which forwarded headers to trust?")).toBeTruthy();
    expect(within(questions).getByText("1 more question the plan went ahead on with a default")).toBeTruthy();
    const tasks = screen.getByRole("region", { name: "2 · Fix, in this order · 3 tasks" });
    // Each tier names the lineup's own models of that strength where it has some.
    expect([...tasks.querySelectorAll(".tier")].map((tier) => tier.textContent)).toEqual(["Strongest model · 1such as Opus 5.5 or GPT-6.1 Sol · prompts/1-strong-model", "Mid model · 1such as Sonnet 5.5 · prompts/2-balanced-model", "Light model · 1such as Claude Haiku · prompts/3-fast-model"]);
    expect([...tasks.querySelectorAll(".plan-task")].map((task) => task.textContent)).toEqual(["1TASK-001Enforce the role guardstrongest", "2TASK-002Bound the retry loopmid · after TASK-001", "3TASK-003Rename the log fieldlight · same files as TASK-002"]);
    const checks = screen.getByRole("region", { name: "3 · Check after the tasks · 1 issue" });
    expect(within(checks).getByRole("link", { name: "Session token may leak in logs" })).toBeTruthy();
    expect(within(checks).getByText(/most such issues do not hold/u)).toBeTruthy();
    const review = (screen.getByText("Review of the plan · 1 objection · 1 answered by the revised plan")).closest("details") as HTMLDetailsElement;
    expect(within(review).getByText("TASK-001 logs and continues when the lock fails.")).toBeTruthy();
    expect(document.querySelectorAll("main .button--primary")).toHaveLength(1);
    // The folders keep their names (2-balanced-model); the plan's own codes stay in the records.
    expect(tab().textContent).not.toMatch(/section-abc|frontier|capability|smoke_test_only/u);
  });

  it("saves from the Plan tab once, then gives the folder, the next step and what the premise check did not find", async () => {
    stubBrowser();
    const saved: unknown[] = [];
    const calls = stubControlPlane(routes({ "GET /handoff/runs/run-1": () => ({ saved }),
      "POST /handoff/runs/run-1": () => { saved.push({ directory: "/work/rokbot/.arbitra/plans/2026-10-25-run1", relative: ".arbitra/plans/2026-10-25-run1", savedAt: "2026-10-25T09:30:00.000Z", premises: { named: 120, notFound: 7, prompts: 3 } });
        return { directory: "/work/rokbot/.arbitra/plans/2026-10-25-run1", files: ["README.md"], premises: { named: 120, notFound: 7, prompts: 3 } }; } }));
    visit("?run=run-1&view=plan");
    render(<App />);
    const card = await screen.findByRole("region", { name: "The plan is ready · 3 tasks for 3 issues" });
    fireEvent.click(await within(card).findByRole("button", { name: "Save the plan into the project" }));
    expect(await within(card).findByText(".arbitra/plans/2026-10-25-run1")).toBeTruthy();
    expect(within(card).getByText(/^Next: open the project in Claude Code or Codex/u)).toBeTruthy();
    expect(within(card).getByText("7 of the 120 things the prompts name were not found in the code, in 3 prompts. Each of those prompts lists them, and the agent finds the real code or reports the premise false.")).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Save the plan into the project" })).toBeNull();
    expect(calls.filter((call) => call === "POST /handoff/runs/run-1")).toHaveLength(1);
  });

  it("opens a task one click down: what it fixes, how to tell it is done, its files and what it waits for", async () => {
    stubBrowser();
    stubControlPlane(routes());
    visit("?run=run-1&view=plan");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Bound the retry loop" }));
    const details = await screen.findByRole("complementary", { name: "details · task TASK-002" });
    expect(within(details).getByText("Retries stop after five attempts.")).toBeTruthy();
    expect(within(details).getByRole("link", { name: "Retry loop never gives up" })).toBeTruthy();
    expect(within(details).getByRole("link", { name: "Advanced JSON edits are overwritten" })).toBeTruthy();
    expect(within(details).getByText("The retry test passes.")).toBeTruthy();
    expect(within(details).getByText("src/retry.ts")).toBeTruthy();
    expect(within(details).getByText("mid model · after TASK-001")).toBeTruthy();
  });
});

describe("the Results tab", () => {
  it("says plainly when the plan has not been carried out, and reads the results again on request", async () => {
    stubBrowser();
    let record: unknown = null;
    const calls = stubControlPlane(routes({ "GET /handoff/runs/run-1/results": () => ({ results: record }) }));
    visit("?run=run-1&view=results");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Not carried out yet" })).toBeTruthy();
    expect(screen.getByText(/it records each issue's result in/u).textContent).toContain("results.json");
    record = { directory: "/work/rokbot/.arbitra/plans/2026-10-25-run1", relative: ".arbitra/plans/2026-10-25-run1", modifiedAt: "2026-10-25T12:00:00.000Z",
      summary: { directory: "", issues: 1, reported: 1, results: { fixed: 1, not_reproducible: 0, no_change_needed: 0, blocked: 0 }, provenByFailingTest: 1, notProvenByTest: 0, checkedEndToEnd: 0, foundWhileFixing: { reported: 0, provenByFailingTest: 0 } },
      issues: [{ issue: "C-crit", title: "Role check missing on update", severity: "critical", task: "TASK-001", result: "fixed", failedBefore: true, test: "test/roles.test.ts", proof: "expected 403, got 200", checkedEndToEnd: false }], foundWhileFixing: [] };
    fireEvent.click(screen.getByRole("button", { name: "Read results again" }));
    expect(await screen.findByRole("heading", { name: "Results · 1 issue reported of 1" })).toBeTruthy();
    expect(calls.filter((call) => call === "GET /handoff/runs/run-1/results")).toHaveLength(2);
  });

  it("shows what came of each issue, whether a failing test proved it and whether it was checked end to end, and the defects found while fixing", async () => {
    stubBrowser();
    const entry = (issueId: string, title: string, severity: string, task: string, result: string | null, failedBefore: boolean | null, checkedEndToEnd: boolean | null = null) =>
      ({ issue: issueId, title, severity, task, result, failedBefore, test: failedBefore === true ? "test/a.test.ts" : null, proof: `${title}: the proof.`, checkedEndToEnd });
    stubControlPlane(routes({ "GET /handoff/runs/run-1/results": { results: { directory: "/work/rokbot/.arbitra/plans/2026-10-25-run1", relative: ".arbitra/plans/2026-10-25-run1", modifiedAt: "2026-10-25T12:00:00.000Z",
      summary: { directory: "", issues: 6, reported: 5, results: { fixed: 2, not_reproducible: 1, no_change_needed: 1, blocked: 1 }, provenByFailingTest: 1, notProvenByTest: 2, checkedEndToEnd: 1, foundWhileFixing: { reported: 1, provenByFailingTest: 1 } },
      issues: [entry("C-crit", "Role check missing on update", "critical", "TASK-001", "fixed", true, true), entry("C-med", "Retry loop never gives up", "medium", "TASK-002", "fixed", false),
        entry("C-var", "Advanced JSON edits are overwritten", "medium", "TASK-002", "fixed by TASK-001", null), entry("C-uns", "Session token may leak in logs", "high", "check 01", "no_change_needed", false),
        entry("C-x", "A flaky clock", "medium", "TASK-003", "not_reproducible", null), entry("C-y", "A port that cannot be freed", "medium", "TASK-003", "blocked", null)],
      foundWhileFixing: [{ title: "The port search runs past 65535", severity: "low", where: "src/ports.ts findPort", result: "fixed", failedBefore: true, test: "test/ports.test.ts", proof: "RangeError" }] } } }));
    visit("?run=run-1&view=results");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Results · 5 issues reported of 6" })).toBeTruthy();
    expect([...document.querySelectorAll(".verdict")].map((cell) => cell.textContent)).toEqual(["2fixed, of 6", "1proven by a test that failed first", "1no change needed", "1more defects found while fixing"]);
    // The tasks' issues and the issues checked after them, apart: most unsettled issues do not hold.
    expect(screen.getByText("The tasks' 5 issues: 2 fixed, 1 could not be reproduced, 1 blocked, 1 recorded in the agent's own words.")).toBeTruthy();
    expect(screen.getByText("1 issue checked after the tasks: 1 did not hold.")).toBeTruthy();
    const fixed = screen.getByRole("region", { name: "Fixed · 2" });
    expect(within(fixed).getByText("Role check missing on update").closest("li")?.textContent).toContain("a test failed first · checked end to end");
    expect(within(fixed).getByText("Retry loop never gives up").closest("li")?.textContent).toContain("no test could show it");
    expect(screen.getByRole("region", { name: "No change needed · 1" }).textContent).toContain("Session token may leak in logs");
    expect(screen.getByRole("region", { name: "Not reproducible · 1" }).textContent).toContain("A flaky clock");
    expect(screen.getByRole("region", { name: "Blocked · 1" }).textContent).toContain("A port that cannot be freed");
    expect(screen.getByRole("region", { name: "As the agent wrote it · 1" }).textContent).toContain("fixed by TASK-001");
    const found = screen.getByRole("region", { name: "Found while fixing · 1" });
    expect(within(found).getByText("The port search runs past 65535").closest("li")?.textContent).toContain("src/ports.ts findPort");
    // The proof is one click down.
    const proof = within(fixed).getAllByText("Proof")[0]?.closest("details") as HTMLDetailsElement;
    expect(proof.open).toBe(false);
    expect(within(proof).getByText("Role check missing on update: the proof.")).toBeTruthy();
  });
});

describe("the records and the report", () => {
  it("names a whole-project audit's steps in words in its records, with no Diff scope and no Disagreement loop", async () => {
    stubBrowser();
    stubControlPlane(routes({ "GET /runs/run-1/traces*": EMPTY_TRACES }));
    visit("?run=run-1&view=activity&item=node:consensus");
    render(<App />);
    expect(await screen.findByRole("complementary", { name: "details · Merge duplicates" })).toBeTruthy();
    expect(main().textContent).not.toMatch(/Diff scope|Disagreement/u);
  });

  it("says who checked the issues when the severe ones and the rest have different checkers", async () => {
    stubBrowser();
    stubControlPlane(routes({ "GET /runs/run-1/progress": () => new Response("{}", { status: 404 }) }));
    visit("?run=run-1&view=how-it-ran");
    render(<App />);
    const facts = await screen.findByRole("region", { name: "Time, tokens and models" });
    expect(within(facts).getByText("checked them", { selector: "dt" }).nextElementSibling?.textContent).toBe("Opus 5.5 · high for critical and high issues, Sonnet 5.5 · high for the rest");
  });

  it("names the report's copy button for the report, not for the run's ID", async () => {
    stubBrowser();
    stubControlPlane(routes({ "GET /diagnostics/runs/run-1": () => new Response("arbitra run report", { status: 200, headers: { "content-type": "text/plain" } }) }));
    visit("?run=run-1&view=how-it-ran");
    render(<App />);
    const report = (await screen.findByText("Read the report to send")).closest("details") as HTMLDetailsElement;
    report.open = true;
    fireEvent(report, new Event("toggle"));
    expect(await within(report).findByRole("button", { name: "Copy the report" })).toBeTruthy();
    expect(within(report).queryByRole("button", { name: /run.?s? id/iu })).toBeNull();
  });
});
