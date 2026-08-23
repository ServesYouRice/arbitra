import type { SourceFinding } from "../finding.js";

export interface SnapshotFileFact {
  readonly lineCount: number;
  readonly lineStartBytes?: readonly number[];
  readonly byteLength?: number;
}

export interface SemanticExposureRange { readonly path?: string; readonly start: number; readonly end: number }

export interface SemanticContext {
  readonly files: Readonly<Record<string, SnapshotFileFact>>;
  readonly exposureRanges?: readonly SemanticExposureRange[];
}

export interface SemanticDiagnostic {
  readonly code:
    | "invalid_repository_path"
    | "path_not_in_snapshot"
    | "invalid_line_range"
    | "line_out_of_range"
    | "duplicate_location_id"
    | "duplicate_evidence_id"
    | "unknown_location_id"
    | "invalid_blocker_severity"
    | "evidence_outside_exposure";
  readonly pointer: string;
  readonly message: string;
}

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function isRepositoryRelative(path: string): boolean {
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)) return false;
  if (path.includes("\\")) return false;
  const segments = path.split("/");
  return segments.length > 0 && segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function validateSemantics(
  value: SourceFinding,
  context: SemanticContext,
): readonly SemanticDiagnostic[] {
  const diagnostics: SemanticDiagnostic[] = [];
  const locationIds = new Set<string>();
  const locationsById = new Map<string, SourceFinding["locations"][number]>();

  for (const [index, location] of value.locations.entries()) {
    const pointer = `/locations/${index}`;
    if (locationIds.has(location.id)) {
      diagnostics.push({
        code: "duplicate_location_id",
        pointer: `${pointer}/id`,
        message: `location id ${location.id} is duplicated`,
      });
    }
    locationIds.add(location.id);
    locationsById.set(location.id, location);

    if (!isRepositoryRelative(location.path)) {
      diagnostics.push({
        code: "invalid_repository_path",
        pointer: `${pointer}/path`,
        message: `${location.path} is not a normalized repository-relative path`,
      });
      continue;
    }

    const file = context.files[location.path];
    if (file === undefined) {
      diagnostics.push({
        code: "path_not_in_snapshot",
        pointer: `${pointer}/path`,
        message: `${location.path} is absent from the repository snapshot`,
      });
    } else if (location.endLine > file.lineCount) {
      diagnostics.push({
        code: "line_out_of_range",
        pointer: `${pointer}/endLine`,
        message: `line ${location.endLine} exceeds ${location.path}'s ${file.lineCount} lines`,
      });
    }
    if (location.startLine > location.endLine) {
      diagnostics.push({
        code: "invalid_line_range",
        pointer,
        message: `start line ${location.startLine} follows end line ${location.endLine}`,
      });
    }
  }

  if (value.productionBlocker && value.severity !== "critical" && value.severity !== "high") {
    diagnostics.push({ code: "invalid_blocker_severity", pointer: "/productionBlocker", message: `a ${value.severity} finding cannot be a production blocker` });
  }

  const evidenceIds = new Set<string>();
  for (const [evidenceIndex, evidence] of value.evidence.entries()) {
    if (evidenceIds.has(evidence.id)) {
      diagnostics.push({
        code: "duplicate_evidence_id",
        pointer: `/evidence/${evidenceIndex}/id`,
        message: `evidence id ${evidence.id} is duplicated`,
      });
    }
    evidenceIds.add(evidence.id);
    for (const [referenceIndex, locationId] of evidence.locationIds.entries()) {
      if (!locationIds.has(locationId)) {
        diagnostics.push({
          code: "unknown_location_id",
          pointer: `/evidence/${evidenceIndex}/locationIds/${referenceIndex}`,
          message: `location id ${pointerSegment(locationId)} does not resolve`,
        });
      } else if (context.exposureRanges !== undefined) {
        const location = locationsById.get(locationId)!;
        const file = context.files[location.path];
        if (file !== undefined && file.lineStartBytes !== undefined && file.byteLength !== undefined) {
          const start = file.lineStartBytes[location.startLine - 1];
          const end = location.endLine < file.lineCount ? file.lineStartBytes[location.endLine] : file.byteLength;
          if (start !== undefined && end !== undefined && !rangeCovered(location.path, start, end, context.exposureRanges)) {
            diagnostics.push({ code: "evidence_outside_exposure", pointer: `/evidence/${evidenceIndex}/locationIds/${referenceIndex}`, message: `location ${locationId} was not delivered in the auditor exposure footprint` });
          }
        }
      }
    }
  }

  return diagnostics;
}

function rangeCovered(path: string, start: number, end: number, ranges: readonly SemanticExposureRange[]): boolean {
  let covered = start;
  for (const range of ranges.filter((item) => item.path === path).sort((a, b) => a.start - b.start)) {
    if (range.end <= covered || range.start > covered) continue;
    covered = Math.max(covered, range.end);
    if (covered >= end) return true;
  }
  return false;
}
