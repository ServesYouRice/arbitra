export type Severity = "critical" | "high" | "medium" | "low" | "informational";
export type Disposition = "accepted" | "rejected" | "needs_verification" | "non_consensus" | "single_source" | "verified_single_source";
export type VerificationOutcome = "CONFIRMED" | "REJECTED" | "STILL_NEEDS_VERIFICATION";
export interface PersistedEvidence { readonly id: string; readonly text: string; readonly locationIds: readonly string[] }
export interface PersistedVote { readonly authorId: string; readonly disposition: "accept" | "reject" | "needs_verification"; readonly citedEvidenceIds: readonly string[]; readonly reason: string }
export interface PersistedIssue { readonly candidateId: string; readonly claim: { readonly trust: "untrusted_data"; readonly title: string; readonly description: string }; readonly severity: Severity; readonly blocker: boolean; readonly disposition: Disposition; readonly consensusClaim: string | null; readonly supportCount: number; readonly reviewDenominator: number; readonly dissent: readonly PersistedVote[]; readonly counterEvidence: readonly PersistedEvidence[]; readonly sourceFindingIds: readonly string[]; readonly verificationOutcome: VerificationOutcome | null; readonly verificationReason?: string; readonly coverage: { readonly reviewedBy: readonly string[]; readonly missingReviewers: readonly string[] }; readonly singleSource: boolean;
  /** The issue a variant search found this one from; absent on issues no variant search found. */
  readonly variantOf?: string }
/** The schema leaves coverage entries open: scripted runs record weighted surfaces, model runs record gaps of several kinds and bare deferred item ids. */
export type PersistedCoverageEntry = unknown;
export interface PersistedIssueSet { readonly schemaVersion: number; readonly issues: readonly PersistedIssue[]; readonly minorityFindingIds: readonly string[]; readonly coverage: { readonly complete: boolean; readonly securityCoverage: { readonly degraded: boolean; readonly reason: string | null }; readonly suppressionCandidates: readonly PersistedCoverageEntry[]; readonly unexaminedSurfaces: readonly PersistedCoverageEntry[] }; readonly limitations: readonly string[]; readonly summary: { readonly auditorCount: number; readonly sourceFindingCount: number; readonly acceptedCount: number; readonly rejectedCount: number; readonly unresolvedCount: number; readonly singleSourceCount: number } }
export interface PersistedLocation { readonly id: string; readonly path: string; readonly startLine: number; readonly endLine: number }
export interface PersistedFinding { readonly sourceFindingId: string; readonly category: string; readonly title: string; readonly severity: Severity; readonly status: string; readonly productionBlocker: boolean; readonly locations: readonly PersistedLocation[]; readonly evidence: readonly PersistedEvidence[] }
export interface PersistedIssueOp { readonly operationId: string; readonly candidateId: string; readonly actorId: string; readonly round: number; readonly kind: string; readonly payload: Readonly<Record<string, unknown>> }
export interface PersistedVerification { readonly candidateId: string; readonly result: VerificationOutcome; readonly method: string }
/** One line for an unexamined surface, whichever producer wrote it; an entry of an unknown shape is shown as recorded. */
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
