export interface FindingLocation { readonly id: string; readonly path: string; readonly startLine: number; readonly endLine: number }
export interface FindingEvidence { readonly id: string; readonly text: string; readonly locationIds: readonly string[] }
export interface ValidatableFinding {
  readonly sourceFindingId: string; readonly severity: "critical" | "high" | "medium" | "low" | "informational";
  readonly productionBlocker: boolean; readonly locations: readonly FindingLocation[]; readonly evidence: readonly FindingEvidence[];
}
export interface FindingSubmission { readonly auditorId: string; readonly finding: ValidatableFinding; readonly repairCount: 0 | 1 }
export interface SnapshotFact { readonly lineCount: number; readonly lineStartBytes: readonly number[]; readonly byteLength: number }
export interface ValidationSnapshot { readonly files: Readonly<Record<string, SnapshotFact>> }
export interface ExposureRange { readonly path?: string; readonly start: number; readonly end: number }
export interface AuditorFootprint { readonly nodeId: string; readonly ranges: readonly ExposureRange[] }
export type ValidationReasonCode = "invalid_repository_path" | "path_not_in_snapshot" | "invalid_line_range" | "line_out_of_range" | "duplicate_location_id" | "duplicate_evidence_id" | "unknown_location_id" | "invalid_blocker_severity" | "evidence_outside_exposure" | "auditor_namespace_mismatch";
export interface ValidationReason { readonly code: ValidationReasonCode; readonly pointer: string; readonly message: string }
export interface ValidatedFinding { readonly validation: "accepted"; readonly finding: ValidatableFinding; readonly auditorId: string; readonly repaired: boolean }
export interface RejectedFinding { readonly validation: "rejected"; readonly finding: ValidatableFinding; readonly auditorId: string; readonly reasons: readonly ValidationReason[]; readonly rejectionRef: string }
export interface RepairRecord { readonly sourceFindingId: string; readonly attempted: true; readonly outcome: "accepted" | "rejected" | "unavailable" }
export interface AuditorValidationSummary { readonly auditorId: string; readonly total: number; readonly accepted: number; readonly rejected: number; readonly repaired: number; readonly invalidLocationCount: number; readonly invalidLocationRate: number; readonly invalidEvidenceCount: number; readonly invalidEvidenceRate: number }
export interface ValidationResult { readonly accepted: readonly ValidatedFinding[]; readonly rejected: readonly RejectedFinding[]; readonly repairs: readonly RepairRecord[]; readonly summaries: readonly AuditorValidationSummary[] }
export interface RejectionStore { persistRejection(rejection: Omit<RejectedFinding, "rejectionRef">): Promise<string> }
export interface FindingRepair { repair(submission: FindingSubmission, reasons: readonly ValidationReason[]): Promise<ValidatableFinding | null> }

export async function validateFindings(findings: readonly FindingSubmission[], snapshot: ValidationSnapshot, footprints: Readonly<Record<string, AuditorFootprint>>, dependencies: { readonly rejectionStore: RejectionStore; readonly repair?: FindingRepair }): Promise<ValidationResult> {
  const accepted: ValidatedFinding[] = []; const rejected: RejectedFinding[] = []; const repairs: RepairRecord[] = [];
  const quality = new Map<string, { total: number; accepted: number; rejected: number; repaired: number; invalidLocations: number; invalidEvidence: number }>();
  for (const submission of findings) {
    const metric = quality.get(submission.auditorId) ?? { total: 0, accepted: 0, rejected: 0, repaired: 0, invalidLocations: 0, invalidEvidence: 0 }; metric.total += 1; quality.set(submission.auditorId, metric);
    let candidate = submission.finding; let reasons = validateOne(submission.auditorId, candidate, snapshot, footprints[submission.auditorId]); let repaired = false;
    if (reasons.length > 0 && submission.repairCount === 0 && dependencies.repair !== undefined) {
      const replacement = await dependencies.repair.repair(submission, reasons);
      if (replacement !== null) { candidate = replacement; reasons = validateOne(submission.auditorId, candidate, snapshot, footprints[submission.auditorId]); repaired = reasons.length === 0; }
      repairs.push(Object.freeze({ sourceFindingId: submission.finding.sourceFindingId, attempted: true as const, outcome: replacement === null ? "unavailable" as const : repaired ? "accepted" as const : "rejected" as const }));
    }
    if (reasons.length === 0) {
      accepted.push(Object.freeze({ validation: "accepted", finding: candidate, auditorId: submission.auditorId, repaired })); metric.accepted += 1; if (repaired) metric.repaired += 1;
    } else {
      if (hasLocationFailure(reasons)) metric.invalidLocations += 1; if (hasEvidenceFailure(reasons)) metric.invalidEvidence += 1; metric.rejected += 1;
      const withoutRef = Object.freeze({ validation: "rejected" as const, finding: candidate, auditorId: submission.auditorId, reasons: Object.freeze(reasons) });
      const rejectionRef = await dependencies.rejectionStore.persistRejection(withoutRef);
      rejected.push(Object.freeze({ ...withoutRef, rejectionRef }));
    }
  }
  const summaries = [...quality].sort(([a], [b]) => a.localeCompare(b)).map(([auditorId, value]) => Object.freeze({ auditorId, total: value.total, accepted: value.accepted, rejected: value.rejected, repaired: value.repaired, invalidLocationCount: value.invalidLocations, invalidLocationRate: rate(value.invalidLocations, value.total), invalidEvidenceCount: value.invalidEvidence, invalidEvidenceRate: rate(value.invalidEvidence, value.total) }));
  return Object.freeze({ accepted: Object.freeze(accepted), rejected: Object.freeze(rejected), repairs: Object.freeze(repairs), summaries: Object.freeze(summaries) });
}

function validateOne(auditorId: string, finding: ValidatableFinding, snapshot: ValidationSnapshot, footprint: AuditorFootprint | undefined): ValidationReason[] {
  const reasons: ValidationReason[] = []; const ids = new Set<string>(); const locations = new Map<string, FindingLocation>();
  if (!finding.sourceFindingId.startsWith(`${auditorId}/`)) reasons.push(reason("auditor_namespace_mismatch", "/sourceFindingId", "source finding id is not namespaced to its auditor"));
  for (const [index, location] of finding.locations.entries()) {
    const pointer = `/locations/${index}`;
    if (ids.has(location.id)) reasons.push(reason("duplicate_location_id", `${pointer}/id`, `location id ${location.id} is duplicated`)); ids.add(location.id); locations.set(location.id, location);
    if (!relativePath(location.path)) { reasons.push(reason("invalid_repository_path", `${pointer}/path`, "path is not normalized and repository-relative")); continue; }
    const file = snapshot.files[location.path];
    if (file === undefined) reasons.push(reason("path_not_in_snapshot", `${pointer}/path`, `${location.path} is absent from the snapshot`));
    else if (location.endLine > file.lineCount) reasons.push(reason("line_out_of_range", `${pointer}/endLine`, `line ${location.endLine} exceeds ${file.lineCount}`));
    if (location.startLine < 1 || location.endLine < 1 || location.startLine > location.endLine) reasons.push(reason("invalid_line_range", pointer, "location line range is invalid"));
  }
  if (finding.productionBlocker && finding.severity !== "critical" && finding.severity !== "high") reasons.push(reason("invalid_blocker_severity", "/productionBlocker", `${finding.severity} cannot be a production blocker`));
  const evidenceIds = new Set<string>();
  for (const [evidenceIndex, evidence] of finding.evidence.entries()) {
    if (evidenceIds.has(evidence.id)) reasons.push(reason("duplicate_evidence_id", `/evidence/${evidenceIndex}/id`, `evidence id ${evidence.id} is duplicated`)); evidenceIds.add(evidence.id);
    for (const [referenceIndex, locationId] of evidence.locationIds.entries()) {
      const pointer = `/evidence/${evidenceIndex}/locationIds/${referenceIndex}`; const location = locations.get(locationId);
      if (location === undefined) { reasons.push(reason("unknown_location_id", pointer, `location id ${locationId} does not resolve`)); continue; }
      const file = snapshot.files[location.path];
      if (file !== undefined && validLineRange(location, file) && !covered(location, file, footprint?.ranges ?? [])) reasons.push(reason("evidence_outside_exposure", pointer, `location ${locationId} lies outside ${auditorId}'s exposure footprint`));
    }
  }
  return reasons;
}
function reason(code: ValidationReasonCode, pointer: string, message: string): ValidationReason { return Object.freeze({ code, pointer, message }); }
function relativePath(path: string): boolean { return !path.startsWith("/") && !path.startsWith("\\") && !/^[A-Za-z]:/u.test(path) && !path.includes("\\") && path.split("/").every((part) => part !== "" && part !== "." && part !== ".."); }
function validLineRange(location: FindingLocation, file: SnapshotFact): boolean { return location.startLine >= 1 && location.endLine >= location.startLine && location.endLine <= file.lineCount; }
function covered(location: FindingLocation, file: SnapshotFact, ranges: readonly ExposureRange[]): boolean {
  const start = file.lineStartBytes[location.startLine - 1]; const end = location.endLine < file.lineCount ? file.lineStartBytes[location.endLine] : file.byteLength; if (start === undefined || end === undefined) return false;
  let cursor = start; for (const range of ranges.filter((item) => item.path === location.path).sort((a, b) => a.start - b.start)) { if (range.end <= cursor || range.start > cursor) continue; cursor = Math.max(cursor, range.end); if (cursor >= end) return true; } return false;
}
const LOCATION_CODES = new Set<ValidationReasonCode>(["invalid_repository_path", "path_not_in_snapshot", "invalid_line_range", "line_out_of_range", "duplicate_location_id"]);
const EVIDENCE_CODES = new Set<ValidationReasonCode>(["duplicate_evidence_id", "unknown_location_id", "evidence_outside_exposure"]);
function hasLocationFailure(reasons: readonly ValidationReason[]): boolean { return reasons.some(({ code }) => LOCATION_CODES.has(code)); }
function hasEvidenceFailure(reasons: readonly ValidationReason[]): boolean { return reasons.some(({ code }) => EVIDENCE_CODES.has(code)); }
function rate(count: number, total: number): number { return total === 0 ? 0 : Math.round(count / total * 10_000) / 10_000; }
