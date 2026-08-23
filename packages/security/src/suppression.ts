export type SuppressionRiskLevel = "high" | "medium" | "low";
export interface SuppressionScan { readonly path: string; readonly instructionRisk: { readonly level: SuppressionRiskLevel | null; readonly affectedRanges: readonly { readonly ruleId: string; readonly byteStart: number; readonly byteEnd: number }[] } }
export interface SuppressionScope { readonly paths: readonly string[] }
export interface SuppressionExposure { readonly auditorId: string; readonly ranges: readonly { readonly path?: string; readonly start: number; readonly end: number }[] }
export interface SuppressionFindingCitation { readonly sourceFindingId: string; readonly citations: readonly { readonly path: string; readonly start: number; readonly end: number }[] }
export interface SuppressionCandidate { readonly path: string; readonly scannerHits: readonly string[]; readonly instructionRisk: SuppressionRiskLevel; readonly affectedRanges: readonly { readonly start: number; readonly end: number }[]; readonly readBy: readonly string[]; readonly findingsCiting: readonly string[]; readonly note: string }

export const SUPPRESSION_CANDIDATE_NOTE = "Instruction-shaped repository content was exposed to an auditor, but no source finding cited this surface. This is not proof of a defect or an attack; it is an unresolved audit uncertainty.";

export function suppressionCandidates(scan: readonly SuppressionScan[], scope: SuppressionScope, exposure: readonly SuppressionExposure[], findings: readonly SuppressionFindingCitation[]): readonly SuppressionCandidate[] {
  const paths = new Set(scope.paths.map(normalize)); const candidates: SuppressionCandidate[] = [];
  for (const result of [...scan].sort((a, b) => normalize(a.path).localeCompare(normalize(b.path)))) {
    const path = normalize(result.path); const level = result.instructionRisk.level; if (level === null || !paths.has(path) || result.instructionRisk.affectedRanges.length === 0) continue;
    const affected = result.instructionRisk.affectedRanges.map(({ byteStart, byteEnd }) => ({ start: byteStart, end: byteEnd }));
    const readBy = exposure.filter((footprint) => footprint.ranges.some((range) => range.path !== undefined && normalize(range.path) === path && affected.some((risk) => overlaps(risk, range)))).map(({ auditorId }) => auditorId).sort(); if (readBy.length === 0) continue;
    const findingsCiting = findings.filter((finding) => finding.citations.some((citation) => normalize(citation.path) === path && affected.some((risk) => overlaps(risk, citation)))).map(({ sourceFindingId }) => sourceFindingId).sort();
    if (findingsCiting.length === 0) candidates.push(Object.freeze({ path, scannerHits: Object.freeze([...new Set(result.instructionRisk.affectedRanges.map(({ ruleId }) => ruleId))].sort()), instructionRisk: level, affectedRanges: Object.freeze(affected.map((range) => Object.freeze(range))), readBy: Object.freeze([...new Set(readBy)]), findingsCiting: Object.freeze([]), note: SUPPRESSION_CANDIDATE_NOTE }));
  }
  return Object.freeze(candidates);
}
function overlaps(a: { readonly start: number; readonly end: number }, b: { readonly start: number; readonly end: number }): boolean { return a.start < b.end && b.start < a.end; }
function normalize(path: string): string { return path.replaceAll("\\", "/").replace(/^\.\//u, ""); }
