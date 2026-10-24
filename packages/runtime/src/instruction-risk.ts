import { INJECTION_SCANNER_VERSION, scan } from "@arbitra/security/scanner/index";
import { suppressionCandidates, type SuppressionCandidate } from "@arbitra/security/suppression";
import type { AuditFinding } from "./auditors.js";
import type { RepositorySnapshot } from "./repository.js";

export const INSTRUCTION_RISK_KIND = "instruction-risk-scan";

/** A file the scanner flagged, with its matches as line ranges. */
export interface FlaggedFile {
  readonly path: string;
  readonly level: "high" | "medium" | "low";
  readonly matches: readonly { readonly ruleId: string; readonly level: string; readonly reason: string; readonly startLine: number; readonly endLine: number }[];
}

/** A suppression candidate with the lines it covers, so a person can open them. */
export type InstructionRiskCandidate = SuppressionCandidate & { readonly lines: readonly { readonly startLine: number; readonly endLine: number }[] };

/**
 * Text in the audited files that reads like instructions to a model (hidden Unicode and tag characters, encoded
 * payloads, "do not report" wording, text that closes a prompt's wrapper), found without a model call, and the
 * flagged places an auditor read but no finding cites. Repository text is framed as untrusted and the models report
 * instruction-shaped text themselves; this is the deterministic check beside them. A candidate is a warning, not an
 * issue: it is listed for a person and changes no verdict.
 *
 * An auditor read every file of its scope except the surfaces its discovery recorded as unexamined, which name the
 * file paths they left out.
 */
export function instructionRisk(snapshot: RepositorySnapshot, auditors: readonly { readonly auditorId: string; readonly unexamined: readonly string[] }[], findings: readonly AuditFinding[]): { readonly report: { readonly scannerVersion: string; readonly filesScanned: number; readonly flagged: readonly FlaggedFile[] }; readonly candidates: readonly InstructionRiskCandidate[] } {
  const lineStarts = new Map<string, readonly number[]>();
  const flagged: FlaggedFile[] = [];
  const scans: Parameters<typeof suppressionCandidates>[0][number][] = [];
  for (const file of snapshot.files) {
    const starts: number[] = [];
    let offset = 0;
    for (const line of file.lines) { starts.push(offset); offset += Buffer.byteLength(line) + 1; }
    starts.push(offset);
    lineStarts.set(file.path, starts);
    const result = scan(file.lines.join("\n"), file.path);
    if (result.instructionRisk.level === null) continue;
    scans.push({ path: file.path, instructionRisk: result.instructionRisk });
    flagged.push({ path: file.path, level: result.instructionRisk.level, matches: result.instructionRisk.affectedRanges.map(({ ruleId, level, reason, byteStart, byteEnd }) => ({ ruleId, level, reason, ...lineRange(starts, byteStart, byteEnd) })) });
  }
  const paths = snapshot.files.map(({ path }) => path);
  const exposure = auditors.map(({ auditorId, unexamined }) => ({ auditorId, ranges: paths.filter((path) => !unexamined.some((surface) => surface.includes(path)))
    .map((path) => ({ path, start: 0, end: lineStarts.get(path)?.at(-1) ?? 0 })) }));
  const citations = findings.map(({ sourceFindingId, locations }) => ({ sourceFindingId, citations: locations.flatMap(({ path, startLine, endLine }) => {
    const starts = lineStarts.get(path);
    return starts === undefined ? [] : [{ path, start: starts[startLine - 1] ?? 0, end: starts[endLine] ?? starts.at(-1) ?? 0 }];
  }) }));
  const candidates = suppressionCandidates(scans, { paths }, exposure, citations).map((candidate) => {
    const starts = lineStarts.get(candidate.path) ?? [0];
    return Object.freeze({ ...candidate, lines: Object.freeze(candidate.affectedRanges.map(({ start, end }) => lineRange(starts, start, end))) });
  });
  return { report: Object.freeze({ scannerVersion: INJECTION_SCANNER_VERSION, filesScanned: snapshot.files.length, flagged: Object.freeze(flagged) }), candidates: Object.freeze(candidates) };
}

/** The 1-based lines a byte range covers. */
function lineRange(starts: readonly number[], byteStart: number, byteEnd: number): { readonly startLine: number; readonly endLine: number } {
  const lineOf = (byte: number) => { let line = 0; while (line + 1 < starts.length - 1 && (starts[line + 1] ?? Infinity) <= byte) line += 1; return line + 1; };
  return { startLine: lineOf(byteStart), endLine: lineOf(Math.max(byteStart, byteEnd - 1)) };
}
