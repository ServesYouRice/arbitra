import { SEVERITY_ORDER, type FixtureSpec, type RubricSeverity } from "./protocol.js";

/** The parts of an Audit finding the rubric reads. Evidence quotes are code, so they never satisfy a keyword. */
export interface MatchableFinding {
  readonly title: string;
  readonly problem: string;
  readonly recommendedFix: string;
  readonly severity: string;
  readonly locations: readonly { readonly path: string; readonly startLine: number; readonly endLine: number }[];
}

export interface FindingMatch {
  /** Defects whose span the finding cites and whose keywords its prose states. */
  readonly defects: readonly string[];
  /** Decoys whose span the finding cites. Counted only when no defect matched. */
  readonly decoys: readonly string[];
  /** The ids passed to the premise scorer: matched defects, else cited decoys, else none (unlisted). */
  readonly matchedGroundTruthIds: readonly string[];
  readonly classification: "true_defect" | "decoy" | "unlisted";
  /** For a true finding: whether the reported severity meets every matched defect's rubric minimum. */
  readonly severityAdequate: boolean | null;
}

/**
 * The prespecified deterministic rule (docs/qa/p06/PROTOCOL.md): a finding matches a defect when one
 * of its locations overlaps the defect's rubric span and its prose matches the defect's keywords;
 * it matches a decoy when one of its locations overlaps the decoy's span.
 */
export function matchFinding(finding: MatchableFinding, fixture: FixtureSpec): FindingMatch {
  const prose = `${finding.title}\n${finding.problem}\n${finding.recommendedFix}`;
  const defects: string[] = []; const decoys: string[] = [];
  for (const [id, entry] of Object.entries(fixture.rubric).sort(([a], [b]) => a.localeCompare(b))) {
    const cited = finding.locations.some(({ path, startLine, endLine }) => normalise(path) === normalise(entry.path) && startLine <= entry.endLine && endLine >= entry.startLine);
    if (!cited) continue;
    if (entry.keywords === null) decoys.push(id);
    else if (new RegExp(entry.keywords, "iu").test(prose)) defects.push(id);
  }
  const classification = defects.length > 0 ? "true_defect" : decoys.length > 0 ? "decoy" : "unlisted";
  const severityAdequate = defects.length === 0 ? null : defects.every((id) => meets(finding.severity, fixture.rubric[id]?.minimumSeverity ?? null));
  return Object.freeze({ defects: Object.freeze(defects), decoys: Object.freeze(decoys), matchedGroundTruthIds: Object.freeze(defects.length > 0 ? defects : decoys), classification, severityAdequate });
}

/** A canonical issue carries the union of its source findings' matches. */
export function mergeMatches(matches: readonly FindingMatch[], severity: string, fixture: FixtureSpec): FindingMatch {
  const defects = [...new Set(matches.flatMap((match) => match.defects))].sort(); const decoys = [...new Set(matches.flatMap((match) => match.decoys))].sort();
  const classification = defects.length > 0 ? "true_defect" : decoys.length > 0 ? "decoy" : "unlisted";
  const severityAdequate = defects.length === 0 ? null : defects.every((id) => meets(severity, fixture.rubric[id]?.minimumSeverity ?? null));
  return Object.freeze({ defects: Object.freeze(defects), decoys: Object.freeze(decoys), matchedGroundTruthIds: Object.freeze(defects.length > 0 ? defects : decoys), classification, severityAdequate });
}

function meets(severity: string, minimum: RubricSeverity | null): boolean {
  if (minimum === null) return true;
  const rank = SEVERITY_ORDER.indexOf(severity as RubricSeverity);
  return rank >= SEVERITY_ORDER.indexOf(minimum);
}

function normalise(path: string): string { return path.replaceAll("\\", "/").replace(/^\.\//u, ""); }
