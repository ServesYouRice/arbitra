export type Severity = "critical" | "high" | "medium" | "low" | "informational";
export type Disposition = "accepted" | "rejected" | "needs_verification" | "non_consensus" | "single_source" | "verified_single_source";
export type VerificationOutcome = "CONFIRMED" | "REJECTED" | "STILL_NEEDS_VERIFICATION";
export interface PersistedEvidence { readonly id: string; readonly text: string; readonly locationIds: readonly string[] }
export interface PersistedVote { readonly authorId: string; readonly disposition: "accept" | "reject" | "needs_verification"; readonly citedEvidenceIds: readonly string[]; readonly reason: string }
export interface PersistedIssue { readonly candidateId: string; readonly claim: { readonly trust: "untrusted_data"; readonly title: string; readonly description: string }; readonly severity: Severity; readonly blocker: boolean; readonly disposition: Disposition; readonly consensusClaim: string | null; readonly supportCount: number; readonly reviewDenominator: number; readonly dissent: readonly PersistedVote[]; readonly counterEvidence: readonly PersistedEvidence[]; readonly sourceFindingIds: readonly string[]; readonly verificationOutcome: VerificationOutcome | null; readonly verificationReason?: string; readonly coverage: { readonly reviewedBy: readonly string[]; readonly missingReviewers: readonly string[] }; readonly singleSource: boolean }
/** The schema leaves coverage entries open: scripted runs record weighted surfaces, model runs record gaps of several kinds and bare deferred item ids. */
export type PersistedCoverageEntry = unknown;
export interface PersistedIssueSet { readonly schemaVersion: number; readonly issues: readonly PersistedIssue[]; readonly minorityFindingIds: readonly string[]; readonly coverage: { readonly complete: boolean; readonly securityCoverage: { readonly degraded: boolean; readonly reason: string | null }; readonly suppressionCandidates: readonly PersistedCoverageEntry[]; readonly unexaminedSurfaces: readonly PersistedCoverageEntry[] }; readonly limitations: readonly string[]; readonly summary: { readonly auditorCount: number; readonly sourceFindingCount: number; readonly acceptedCount: number; readonly rejectedCount: number; readonly unresolvedCount: number; readonly singleSourceCount: number } }
export interface PersistedLocation { readonly id: string; readonly path: string; readonly startLine: number; readonly endLine: number }
export interface PersistedFinding { readonly sourceFindingId: string; readonly category: string; readonly title: string; readonly severity: Severity; readonly status: string; readonly productionBlocker: boolean; readonly locations: readonly PersistedLocation[]; readonly evidence: readonly PersistedEvidence[] }
export interface PersistedIssueOp { readonly operationId: string; readonly candidateId: string; readonly actorId: string; readonly round: number; readonly kind: string; readonly payload: Readonly<Record<string, unknown>> }
export interface PersistedVerification { readonly candidateId: string; readonly result: VerificationOutcome; readonly method: string }
export interface IssueBoardArtifacts { readonly issueSet: PersistedIssueSet; readonly findings: readonly PersistedFinding[]; readonly operations: readonly PersistedIssueOp[]; readonly verifications: readonly PersistedVerification[] }
export interface IssueRow { readonly candidateId: string; readonly title: string; readonly description: string; readonly severity: Severity; readonly blocker: boolean; readonly status: string; readonly consensusState: Disposition; readonly supportCount: number; readonly reviewDenominator: number; readonly auditors: readonly string[]; readonly missingReviewers: readonly string[]; readonly categories: readonly string[]; readonly evidence: readonly PersistedEvidence[]; readonly counterEvidence: readonly PersistedEvidence[]; readonly dissent: readonly PersistedVote[]; readonly votes: readonly PersistedIssueOp[]; readonly objections: readonly PersistedIssueOp[]; readonly supplements: readonly PersistedIssueOp[]; readonly locations: readonly PersistedLocation[]; readonly sourceFindingIds: readonly string[]; readonly verificationOutcome: VerificationOutcome | null; readonly verificationMethod: string | null; readonly verificationReason: string | null; readonly singleSource: boolean }
export interface IssueFilters { readonly severity: Severity | null; readonly status: string | null; readonly auditor: string | null; readonly category: string | null; readonly consensusState: Disposition | null; readonly blocker: boolean | null; readonly verificationOutcome: VerificationOutcome | null }
export const EMPTY_FILTERS: IssueFilters = Object.freeze({ severity: null, status: null, auditor: null, category: null, consensusState: null, blocker: null, verificationOutcome: null });
export function issueRows({ issueSet, findings, operations, verifications }: IssueBoardArtifacts): readonly IssueRow[] {
  const byFinding = new Map(findings.map((finding) => [finding.sourceFindingId, finding]));
  return Object.freeze(issueSet.issues.map((issue) => {
    const linked = issue.sourceFindingIds.map((id) => byFinding.get(id)).filter((value): value is PersistedFinding => value !== undefined);
    const ops = operations.filter(({ candidateId }) => candidateId === issue.candidateId);
    const verification = verifications.find(({ candidateId }) => candidateId === issue.candidateId) ?? null;
    return Object.freeze({
      candidateId: issue.candidateId, title: issue.claim.title, description: issue.claim.description, severity: issue.severity, blocker: issue.blocker,
      status: lastStatus(ops), consensusState: issue.disposition, supportCount: issue.supportCount, reviewDenominator: issue.reviewDenominator,
      auditors: Object.freeze([...issue.coverage.reviewedBy]), missingReviewers: Object.freeze([...issue.coverage.missingReviewers]),
      categories: Object.freeze([...new Set(linked.map(({ category }) => category))].sort()),
      evidence: Object.freeze(linked.flatMap(({ evidence }) => evidence)), counterEvidence: Object.freeze([...issue.counterEvidence]), dissent: Object.freeze([...issue.dissent]),
      votes: Object.freeze(ops.filter(({ kind }) => kind === "cast_vote")), objections: Object.freeze(ops.filter(({ kind }) => kind === "add_objection")), supplements: Object.freeze(ops.filter(({ kind }) => kind === "add_supplement")),
      locations: Object.freeze(linked.flatMap(({ locations }) => locations)), sourceFindingIds: Object.freeze([...issue.sourceFindingIds]),
      // Issue sets saved before the verifier gave a reason have none.
      verificationOutcome: issue.verificationOutcome, verificationMethod: verification?.method ?? null, verificationReason: issue.verificationReason ?? null, singleSource: issue.singleSource,
    });
  }));
}
export function filterIssues(rows: readonly IssueRow[], filters: IssueFilters): readonly IssueRow[] { return Object.freeze(rows.filter((row) => (filters.severity === null || row.severity === filters.severity) && (filters.status === null || row.status === filters.status) && (filters.auditor === null || row.auditors.includes(filters.auditor)) && (filters.category === null || row.categories.includes(filters.category)) && (filters.consensusState === null || row.consensusState === filters.consensusState) && (filters.blocker === null || row.blocker === filters.blocker) && (filters.verificationOutcome === null || row.verificationOutcome === filters.verificationOutcome))); }
/** A chosen value the rows no longer offer (a status changed, another run) filters nothing, as its select shows "any". */
export function offeredFilters(filters: IssueFilters, options: ReturnType<typeof filterOptions>): IssueFilters {
  const offered = (field: keyof typeof options) => { const value = filters[field]; return value !== null && !options[field].includes(value) ? null : value; };
  return Object.freeze({ ...filters, severity: offered("severity") as IssueFilters["severity"], status: offered("status"), auditor: offered("auditor"), category: offered("category"), consensusState: offered("consensusState") as IssueFilters["consensusState"], verificationOutcome: offered("verificationOutcome") as IssueFilters["verificationOutcome"] });
}
export function filterOptions(rows: readonly IssueRow[]): Readonly<Record<"severity" | "status" | "auditor" | "category" | "consensusState" | "verificationOutcome", readonly string[]>> { return Object.freeze({ severity: unique(rows.map(({ severity }) => severity)), status: unique(rows.map(({ status }) => status)), auditor: unique(rows.flatMap(({ auditors }) => auditors)), category: unique(rows.flatMap(({ categories }) => categories)), consensusState: unique(rows.map(({ consensusState }) => consensusState)), verificationOutcome: unique(rows.map(({ verificationOutcome }) => verificationOutcome).filter((value): value is VerificationOutcome => value !== null)) }); }
/** One line for an unexamined surface, whichever producer wrote it; an entry of an unknown shape is shown as recorded. */
/**
 * Unresolved issues verification never looked at, such as those below the plan's minimum severity. Observed live
 * (October 21, 2026): 81 of a run's 95 unresolved issues were low or informational and skipped by design, which read
 * as 95 open questions.
 */
export function unverifiedUnresolved(rows: readonly IssueRow[]): number {
  return rows.filter(({ consensusState, verificationOutcome }) => (consensusState === "needs_verification" || consensusState === "non_consensus") && verificationOutcome === null).length;
}

export const UNVERIFIED_NOTE = "Not verified: unresolved issues verification did not check, such as those below the plan's minimum severity. They stay on the board but are not planned.";

export function describeUnexaminedSurface(entry: PersistedCoverageEntry): string {
  if (typeof entry === "string") return `verification deferred · ${entry}`;
  const fields = record(entry);
  if (fields === null) return recorded(entry);
  const conflict = record(fields["conflict"]);
  switch (fields["kind"]) {
    case "verification_check_deferred": return `verification check deferred · ${text(fields["candidateId"])} · ${text(fields["checkId"])}`;
    case "verification_check_incomplete_or_failed": return [`verification check not passed · ${text(fields["candidateId"])} · ${text(fields["checkId"])} · ${text(fields["state"])}`, ...(fields["status"] == null ? [] : [text(fields["status"])]), ...(fields["exitCode"] == null ? [] : [`exit ${text(fields["exitCode"])}`])].join(" · ");
    case "peer_operation_conflict": return conflict === null ? recorded(entry) : `peer operations conflict · ${text(conflict["reason"])} · ${strings(conflict["candidateIds"]).join(", ")}`;
    case "peer_review_output_rejected": return [`peer review output rejected · round ${text(fields["round"])} · ${text(fields["auditorId"])}`, ...(fields["scopeId"] == null ? [] : [text(fields["scopeId"])]), text(fields["reason"])].join(" · ");
    default: break;
  }
  if (typeof fields["surfaceId"] === "string") return `${fields["surfaceId"]} · ${text(fields["weight"])} · risk ${text(fields["riskScore"])} · ${strings(fields["paths"]).join(", ")} · ${strings(fields["reasons"]).join(", ")}`;
  if (typeof fields["surface"] === "string") return `${fields["surface"]} · not examined by ${text(fields["auditorId"])} within its budget`;
  return recorded(entry);
}
/** One line for a suppression candidate; missing fields read as unavailable rather than failing the view. */
export function describeSuppressionCandidate(entry: PersistedCoverageEntry): string {
  const fields = record(entry);
  if (fields === null || typeof fields["path"] !== "string") return recorded(entry);
  return `${fields["path"]} · instruction risk ${text(fields["instructionRisk"])} · read by ${strings(fields["readBy"]).join(", ") || "no auditor"} · ${text(fields["note"])}`;
}
function record(value: unknown): Readonly<Record<string, unknown>> | null { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null; }
function text(value: unknown): string { return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "unavailable"; }
function strings(value: unknown): readonly string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function recorded(value: unknown): string { return JSON.stringify(value) ?? String(value); }
function lastStatus(ops: readonly PersistedIssueOp[]): string { const latest = ops.filter(({ kind }) => kind === "set_status").at(-1); const value = latest?.payload["status"]; return typeof value === "string" ? value : "unavailable"; }
function unique(values: readonly string[]): readonly string[] { return Object.freeze([...new Set(values)].sort()); }
