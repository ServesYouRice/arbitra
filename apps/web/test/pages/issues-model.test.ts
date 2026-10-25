import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findersOf, matches, placeRange, verdictOf, type IssueView } from "../../src/pages/run/issues.js";
import { attemptLabel, configuredChecker, listWords, modelsOfTier } from "../../src/pages/run/models.js";
import { describeSuppressionCandidate, describeUnexaminedSurface } from "../../src/views/issue-board/model.js";
import { fromPackageRoot } from "../package-root.js";
import { issueSet } from "../views/fixtures.js";

describe("the Issues tab's reading of the records", () => {
  it("decides each issue's group as the run's confirmed yield counts it, so the tab and the Summary agree", () => {
    expect(verdictOf({ disposition: "accepted", verificationOutcome: "CONFIRMED" })).toBe("confirmed");
    expect(verdictOf({ disposition: "verified_single_source", verificationOutcome: "CONFIRMED" })).toBe("confirmed");
    expect(verdictOf({ disposition: "rejected", verificationOutcome: "REJECTED" })).toBe("rejected");
    // The reviewers rejected it with no check: rejected all the same.
    expect(verdictOf({ disposition: "rejected", verificationOutcome: null })).toBe("rejected");
    expect(verdictOf({ disposition: "needs_verification", verificationOutcome: "STILL_NEEDS_VERIFICATION" })).toBe("unsettled");
    expect(verdictOf({ disposition: "non_consensus", verificationOutcome: null })).toBe("not checked");
    // Accepted by the reviewers without a check is not confirmed.
    expect(verdictOf({ disposition: "accepted", verificationOutcome: null })).toBe("not checked");
  });

  it("names the finders from their discovery reports, not from what they added in review", () => {
    expect(findersOf(["auditor-a/scope-1/x", "auditor-b/window-2/y", "auditor-a/scope-3/z"])).toEqual(["auditor-a", "auditor-b"]);
    expect(findersOf(["auditor-a/scope-1/x", "auditor-c/review-1/y"])).toEqual(["auditor-a"]);
    expect(findersOf(["auditor-c/review-1/y"])).toEqual(["auditor-c"]);
  });

  it("finds an issue by every word asked for, in its title, the finder's words or its places", () => {
    const view = { issue: issueSet.issues[0], places: [{ id: "l", path: "src/roles.ts", startLine: 40, endLine: 52 }] } as unknown as IssueView;
    expect(matches(view, "roles.ts")).toBe(true);
    expect(matches(view, "role  AUTHENTICATED")).toBe(true);
    expect(matches(view, "roles.ts billing")).toBe(false);
    expect(placeRange({ id: "l", path: "a.ts", startLine: 3, endLine: 3 })).toBe("a.ts:3");
  });

  it("names a checker by the model and effort its attempt ran at, else as the configuration assigns it by severity", () => {
    const config = { mode: "audit", models: { strong: { provider: "anthropic", modelId: "claude-opus-5-5", capabilityTier: "frontier", effort: { params: { high: { effort: "xhigh" } } } },
      medium: { provider: "anthropic", modelId: "claude-sonnet-5-5", capabilityTier: "balanced", effort: { params: { medium: { effort: "high" } } } }, flash: { provider: "google", modelId: "gemini-3.8-flash-high", capabilityTier: "fast" } },
      workflow: { modelExecution: { roles: { verifier: "strong", mediumVerifier: "medium", planner: "strong" }, stageEffort: { verification: "medium" } } } };
    expect(attemptLabel(config, "claude-opus-5-5", "high")).toBe("Opus 5.5 · xhigh");
    expect(attemptLabel(config, "claude-sonnet-5-5", "medium")).toBe("Sonnet 5.5 · high");
    expect(attemptLabel(config, "gemini-3.8-flash-high", "high")).toBe("Gemini 3.8 Flash high");
    expect(attemptLabel(null, "claude-opus-5-5", null)).toBe("Opus 5.5");
    expect(configuredChecker(config, "critical")).toBe("Opus 5.5 · medium");
    expect(configuredChecker(config, "medium")).toBe("Sonnet 5.5 · high");
    // A tier names the models the run trusted with its core roles; one that only found issues is left out.
    expect(modelsOfTier(config, "frontier")).toEqual(["Opus 5.5"]);
    expect(modelsOfTier(config, "balanced")).toEqual(["Sonnet 5.5"]);
    expect(modelsOfTier(config, "fast")).toEqual([]);
    expect(listWords(["A"])).toBe("A");
    expect(listWords(["A", "B", "C"])).toBe("A, B and C");
  });

  it("describes what the audit could not see whichever producer recorded it, and an entry of an unknown shape as recorded", () => {
    expect(describeUnexaminedSurface({ kind: "peer_review_output_rejected", round: 1, auditorId: "auditor-c", scopeId: null, reason: "operation must cite at least one evidence ID" })).toBe("peer review output rejected · round 1 · auditor-c · operation must cite at least one evidence ID");
    expect(describeUnexaminedSurface({ kind: "peer_operation_conflict", conflict: { candidateIds: ["C-1", "C-2"], reason: "contradictory_severity" } })).toBe("peer operations conflict · contradictory_severity · C-1, C-2");
    expect(describeUnexaminedSurface({ kind: "verification_check_incomplete_or_failed", candidateId: "C-3", checkId: "check-1", state: "completed", status: "exited", exitCode: 1 })).toBe("verification check not passed · C-3 · check-1 · completed · exited · exit 1");
    expect(describeUnexaminedSurface("C-4")).toBe("verification deferred · C-4");
    expect(describeUnexaminedSurface(7)).toBe("7");
    expect(describeUnexaminedSurface({ surfaceId: "billing", paths: ["src/billing"], weight: "critical", riskScore: 0.9, reasons: ["security_sensitive_category"] })).toBe("billing · critical · risk 0.9 · src/billing · security_sensitive_category");
    expect(describeSuppressionCandidate({ path: "src/auth.ts" })).toBe("src/auth.ts · instruction risk unavailable · read by no auditor · unavailable");
  });

  it("draws severity as stripe width, never hue, and outlines the selected row where colours are forced", () => {
    const css = readFileSync(fromPackageRoot("src/pages/run/issues.css"), "utf8");
    expect(css).toContain("border-inline-start: var(--stripe) solid");
    expect(css).not.toMatch(/data-severity[^{]*\{[^}]*\bcolor:/u);
    expect(css).toContain("@media (forced-colors: active)");
    expect(css).toMatch(/\.issue-row\[data-selected="true"\] \{ outline:/u);
    // A path or a title is one long word: on a phone it wraps rather than widening the page.
    expect(css).toMatch(/\.issue-row__title \{[^}]*overflow-wrap: anywhere/u);
    expect(css).toMatch(/\.issue-row__facts > span[^{]*\{[^}]*overflow-wrap: anywhere/u);
  });
});
