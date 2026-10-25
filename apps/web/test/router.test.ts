import { describe, expect, it } from "vitest";
import { artifactName, gateReasonLabel, isActive, modeOfWorkflow, runStateLabel, shortPath, shortRunId } from "../src/app/format.js";
import { parseRoute, routeHref } from "../src/app/router.js";
import { parseSelection, selectionItem } from "../src/pages/run/selection.js";
import { placesFor, tabsFor } from "../src/pages/run/tabs.js";

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

  it("keeps links written for the old column-two views and the Overview tab working", () => {
    expect(parseRoute("?run=run-1&view=overview")).toMatchObject({ tab: "summary" });
    expect(parseRoute("?run=run-1&view=how-it-ran")).toMatchObject({ tab: "how-it-ran" });
    expect(parseRoute("?run=run-1&view=graph")).toMatchObject({ tab: "activity" });
    expect(parseRoute("?run=run-1&view=traces")).toMatchObject({ tab: "activity" });
    expect(parseRoute("?run=run-1&view=feature")).toMatchObject({ tab: "requirements" });
    expect(parseRoute("?run=run-1&view=testing")).toMatchObject({ tab: "execution" });
    expect(parseRoute("?run=run-1&view=nonsense")).toMatchObject({ tab: null });
    expect(parseRoute("?view=graph")).toEqual({ page: "runs" });
  });

  it("offers each mode only the tabs that can hold something, with the records one click down", () => {
    expect(tabsFor("audit")).toEqual(["summary", "issues", "plan", "results", "how-it-ran"]);
    expect(tabsFor("feature")).toEqual(["summary", "requirements", "plan", "how-it-ran"]);
    expect(tabsFor("testing")).toEqual(["summary", "plan", "execution", "how-it-ran"]);
    expect(placesFor("audit")).toEqual([...tabsFor("audit"), "activity", "evaluation"]);
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

describe("plain words for recorded codes", () => {
  it("names every run state in one word per idea and says which ones still do work", () => {
    expect(runStateLabel("BLOCKED")).toEqual({ text: "needs you", tone: "attention" });
    expect(runStateLabel("FAILED")).toEqual({ text: "failed", tone: "refuted" });
    expect(runStateLabel("COMPLETED")).toEqual({ text: "done", tone: null });
    expect(runStateLabel("SUSPENDED_RATE_LIMIT")).toEqual({ text: "paused for usage", tone: "degraded" });
    expect(runStateLabel("SUSPENDED_BUDGET")).toEqual({ text: "paused at its token limit", tone: "degraded" });
    // Which step a working run is in is the watch line's to say; the state word is the same for all.
    for (const state of ["CREATED", "DISCOVERY_RUNNING", "PEER_REVIEW_RUNNING", "SOMETHING_NEW"]) expect(runStateLabel(state)).toEqual({ text: "running", tone: null });
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
