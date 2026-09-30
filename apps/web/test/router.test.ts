import { describe, expect, it } from "vitest";
import { artifactName, gateReasonLabel, isActive, modeOfWorkflow, runStateLabel, shortPath, shortRunId } from "../src/app/format.js";
import { parseRoute, routeHref } from "../src/app/router.js";
import { parseSelection, selectionItem } from "../src/pages/run/selection.js";
import { tabsFor } from "../src/pages/run/tabs.js";

describe("addresses", () => {
  it("round-trips every page, run tab and selection through the query string", () => {
    for (const route of [
      { page: "runs" },
      { page: "run", runId: "run-1", tab: null, item: null },
      { page: "run", runId: "run-1", tab: "issues", item: "issue:C-1" },
      { page: "new-run", from: "template:subscription-audit", graph: null },
      { page: "new-run", from: null, graph: "reviewed@abc" },
      { page: "workflows", source: "saved:reviewed:abc" },
    ] as const) expect(parseRoute(routeHref(route).slice(1))).toEqual(route);
    expect(routeHref({ page: "runs" })).toBe("/");
    expect(routeHref({ page: "run", runId: "run 1", tab: "plan", item: "trace:task:T-1" })).toBe("/?run=run+1&view=plan&item=trace%3Atask%3AT-1");
  });

  it("keeps links written for the old column-two views working", () => {
    expect(parseRoute("?run=run-1&view=graph")).toMatchObject({ tab: "activity" });
    expect(parseRoute("?run=run-1&view=traces")).toMatchObject({ tab: "activity" });
    expect(parseRoute("?run=run-1&view=feature")).toMatchObject({ tab: "requirements" });
    expect(parseRoute("?run=run-1&view=testing")).toMatchObject({ tab: "execution" });
    expect(parseRoute("?run=run-1&view=nonsense")).toMatchObject({ tab: null });
    expect(parseRoute("?view=graph")).toEqual({ page: "runs" });
  });

  it("offers each mode only the tabs that can hold something", () => {
    expect(tabsFor("audit")).toEqual(["overview", "issues", "plan", "activity", "evaluation"]);
    expect(tabsFor("feature")).toEqual(["overview", "requirements", "plan", "activity", "evaluation"]);
    expect(tabsFor("testing")).toEqual(["overview", "plan", "execution", "activity", "evaluation"]);
    expect(modeOfWorkflow("feature-simple")).toBe("feature");
    expect(modeOfWorkflow("testing-execute")).toBe("testing");
    expect(modeOfWorkflow("my-saved-graph")).toBe("audit");
  });

  it("parses only well-formed selections", () => {
    expect(parseSelection("issue:C-1")).toEqual({ kind: "issue", id: "C-1" });
    expect(parseSelection("node:execute::repair")).toEqual({ kind: "node", id: "execute::repair" });
    expect(parseSelection("trace:finding:auditor-a/f-1")).toEqual({ kind: "trace", level: "finding", id: "auditor-a/f-1" });
    for (const bad of [null, "", "issue", "issue:", "trace:task", "trace:bogus:1", "other:1"]) expect(parseSelection(bad)).toBeNull();
    expect(selectionItem({ kind: "trace", level: "task", id: "T-1" })).toBe("trace:task:T-1");
  });
});

describe("plain words beside recorded codes", () => {
  it("names every run state and says which ones still do work", () => {
    expect(runStateLabel("BLOCKED")).toEqual({ text: "waiting for your decision", tone: "attention" });
    expect(runStateLabel("FAILED")).toEqual({ text: "failed", tone: "refuted" });
    expect(runStateLabel("PEER_REVIEW_RUNNING")).toEqual({ text: "running · peer review", tone: null });
    expect(runStateLabel("SOMETHING_NEW")).toEqual({ text: "running · something new", tone: null });
    expect(runStateLabel(null)).toEqual({ text: "unreadable", tone: "degraded" });
    expect(["CREATED", "VERIFYING"].every(isActive)).toBe(true);
    expect(["COMPLETED", "FAILED", "BLOCKED", "CANCELLED", "SUSPENDED_BUDGET", "SUSPENDED_RATE_LIMIT", null].some(isActive)).toBe(false);
  });

  it("reads gate reasons, keeping parameterised subjects and unknown codes as recorded", () => {
    expect(gateReasonLabel("degraded_coverage")).toBe("coverage is incomplete");
    expect(gateReasonLabel("checkpoint_pending:approval")).toBe("checkpoint approval is still waiting for a decision");
    expect(gateReasonLabel("gate_failed:quality")).toBe("gate quality failed");
    expect(gateReasonLabel("task_attempts_exhausted:TASK-001")).toBe("task attempts exhausted:TASK-001");
  });

  it("keeps artifact kinds verbatim and shortens only their hashes", () => {
    expect(artifactName("canonical-issues")).toEqual({ name: "canonical-issues", hash: null });
    expect(artifactName(`compiled-prompt-${"7d61".repeat(16)}`)).toEqual({ name: "compiled-prompt", hash: "7d617d61" });
    expect(artifactName(`model-activity-${"ab".repeat(32)}-input`)).toEqual({ name: "model-activity-input", hash: "abababab" });
    expect(shortPath(`testing/risk/${"b9".repeat(32)}/turn-0`)).toBe("testing/risk/b9b9b9b9…/turn-0");
    expect(shortRunId("run-7d73b74b-5b6e-49ff")).toBe("7d73b74b");
  });
});
