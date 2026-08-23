import type { PersistedFinding, PersistedIssue, PersistedIssueOp, PersistedIssueSet, PersistedVerification } from "../../src/views/issue-board/model.js";
import type { PersistedCritique, PersistedPlan } from "../../src/views/plan/traceability.js";

export const findings: readonly PersistedFinding[] = Object.freeze([
  { sourceFindingId: "reviewer-a/f-1", category: "SECURITY", title: "Role check missing on update", severity: "critical", status: "confirmed", productionBlocker: true, locations: [{ id: "loc-1", path: "src/roles.ts", startLine: 40, endLine: 52 }], evidence: [{ id: "ev-1", text: "updateRole runs before the authorization guard", locationIds: ["loc-1"] }] },
  { sourceFindingId: "reviewer-b/f-2", category: "RELIABILITY", title: "Retry loop is unbounded", severity: "medium", status: "likely", productionBlocker: false, locations: [{ id: "loc-2", path: "src/retry.ts", startLine: 8, endLine: 20 }], evidence: [{ id: "ev-2", text: "no maximum attempt count is enforced", locationIds: ["loc-2"] }] },
]);

const issues: readonly PersistedIssue[] = Object.freeze([
  { candidateId: "issue-1", claim: { trust: "untrusted_data", title: "Role check missing on update", description: "Any authenticated user can change another user's role." }, severity: "critical", blocker: true, disposition: "accepted", consensusClaim: "upheld", supportCount: 2, reviewDenominator: 3, dissent: [{ authorId: "reviewer-c", disposition: "reject", citedEvidenceIds: ["ev-1"], reason: "the guard runs in middleware" }], counterEvidence: [{ id: "ce-1", text: "middleware asserts the role earlier", locationIds: ["loc-1"] }], sourceFindingIds: ["reviewer-a/f-1"], verificationOutcome: "CONFIRMED", coverage: { reviewedBy: ["reviewer-a", "reviewer-b", "reviewer-c"], missingReviewers: [] }, singleSource: false },
  { candidateId: "issue-2", claim: { trust: "untrusted_data", title: "Retry loop is unbounded", description: "A failing dependency retries forever." }, severity: "medium", blocker: false, disposition: "single_source", consensusClaim: null, supportCount: 1, reviewDenominator: 3, dissent: [], counterEvidence: [], sourceFindingIds: ["reviewer-b/f-2"], verificationOutcome: null, coverage: { reviewedBy: ["reviewer-b"], missingReviewers: ["reviewer-a", "reviewer-c"] }, singleSource: true },
]);
export const issueSet: PersistedIssueSet = Object.freeze({
  schemaVersion: 1,
  issues,
  minorityFindingIds: Object.freeze(["reviewer-c/f-9"]),
  coverage: Object.freeze({
    complete: false,
    securityCoverage: { degraded: true, reason: "one security auditor unavailable" },
    suppressionCandidates: Object.freeze([{ path: "docs/notes.md", instructionRisk: "high", readBy: ["reviewer-a"], note: "Instruction-shaped repository content was exposed to an auditor, but no source finding cited this surface." }]),
    unexaminedSurfaces: Object.freeze([{ surfaceId: "billing", paths: ["src/billing"], weight: "critical", riskScore: 0.9, reasons: ["security_sensitive_category"] }]),
  }),
  limitations: Object.freeze(["Third auditor produced no parsable findings."]),
  summary: Object.freeze({ auditorCount: 3, sourceFindingCount: 31, acceptedCount: 2, rejectedCount: 26, unresolvedCount: 2, singleSourceCount: 1 }),
});

export const operations: readonly PersistedIssueOp[] = Object.freeze([
  { operationId: "op-1", candidateId: "issue-1", actorId: "reviewer-a", round: 1, kind: "cast_vote", payload: { vote: "accept", reason: "cited lines" } },
  { operationId: "op-2", candidateId: "issue-1", actorId: "reviewer-c", round: 1, kind: "add_objection", payload: { citesLocation: true, evidenceType: "repository", resolvedBy: null, reason: "middleware guard" } },
  { operationId: "op-3", candidateId: "issue-1", actorId: "reviewer-b", round: 1, kind: "add_supplement", payload: { reason: "same path is used by the invite flow" } },
  { operationId: "op-4", candidateId: "issue-1", actorId: "verification", round: 2, kind: "set_status", payload: { status: "accepted" } },
  { operationId: "op-5", candidateId: "issue-2", actorId: "reviewer-b", round: 1, kind: "set_status", payload: { status: "open" } },
]);

export const verifications: readonly PersistedVerification[] = Object.freeze([
  { candidateId: "issue-1", result: "CONFIRMED", method: "cited_lines" },
]);

export const plan: PersistedPlan = Object.freeze({
  id: "plan-1", title: "Authorization repair", mode: "audit", acceptedIssueIds: Object.freeze(["issue-1"]),
  validationContract: Object.freeze({ validation: Object.freeze([{ id: "VAL-001", assertion: "Unauthorized users cannot change another user's role.", evidence: Object.freeze(["authorization regression test"]) }]) }),
  tasks: Object.freeze([{ id: "TASK-001", title: "Enforce the role guard", addresses: { issues: ["issue-1"], validation: ["VAL-001"], requirements: ["ACC-001"] }, routing: { capability: "frontier", effort: "high", reason: ["security critical"] }, dependencies: { dependsOn: [], blocks: [], conflictsWith: [] } }]),
  taskGraph: Object.freeze([{ from: "TASK-001", to: "TASK-002" }]),
  traceability: Object.freeze({ issueToValidation: Object.freeze([{ issueId: "issue-1", validationIds: Object.freeze(["VAL-001"]) }]), requirementLinks: Object.freeze({ links: Object.freeze([{ requirementId: "ACC-001", validationIds: Object.freeze(["VAL-001"]), taskIds: Object.freeze(["TASK-001"]) }]) }) }),
  routingRecommendations: Object.freeze([{ taskId: "TASK-001", capability: "frontier", effort: "high", reason: Object.freeze(["security critical"]) }]),
  unresolvedQuestions: Object.freeze([{ id: "Q-1", question: "Is the invite flow in scope?", blocking: true, blastRadius: "high" }]),
  premiseReport: Object.freeze({ status: "null", interpretation: "smoke_test_only_not_proof", limitations: Object.freeze(["one repository, one run"]) }),
});

export const critique: PersistedCritique = Object.freeze({
  summary: "One blocking gap in validation coverage.",
  items: Object.freeze([{ id: "C-1", category: "validation_gap", blocking: true, summary: "No assertion covers the invite flow.", taskIds: Object.freeze(["TASK-001"]), issueIds: Object.freeze(["issue-1"]) }]),
});

export const ARTIFACT_CONTENT: Readonly<Record<string, unknown>> = Object.freeze({
  "canonical-issues": issueSet,
  "source-findings": findings,
  "issue-operations": operations,
  "verification-results": verifications,
  "plan-ir": plan,
  "critic-feedback": critique,
});
