import type { SourceFile, RepositorySnapshot } from "./repository.js";
import type { FindingEvidence, FindingLocation, ValidatableFinding } from "@arbitra/workflow/nodes/validate-findings.js";
import type { ClusterableFinding } from "@arbitra/workflow/clustering/types.js";

export type Severity = "critical" | "high" | "medium" | "low" | "informational";

/** Carries both the validation shape and the clustering shape for one finding. */
export interface AuditFinding extends ValidatableFinding, ClusterableFinding {
  readonly sourceFindingId: string;
  readonly category: string;
  readonly title: string;
  readonly severity: Severity;
  readonly problem: string;
  readonly recommendedFix: string;
  readonly locations: readonly FindingLocation[];
  readonly evidence: readonly FindingEvidence[];
  readonly productionBlocker: boolean;
}

interface Detector {
  readonly ruleId: string;
  readonly category: string;
  readonly title: string;
  readonly severity: Severity;
  readonly problem: string;
  readonly recommendedFix: string;
  readonly pattern: RegExp;
}

/**
 * The detector catalogue.
 *
 * These are deterministic static checks, not model auditors. The premise this system
 * exists to measure — that independent models find defects a single model misses — is not
 * exercised by them, and every run they produce is reported as `scripted_auditors`. They
 * exist so the pipeline has real, evidence-grounded findings to cluster, review, verify
 * and plan over without a provider key. Configure model profiles for a real audit.
 */
const DETECTORS: readonly Detector[] = Object.freeze([
  Object.freeze({ ruleId: "non-null-assertion", category: "type_safety", title: "Non-null assertion discards a checked failure mode", severity: "medium" as const, problem: "A non-null assertion tells the compiler a value cannot be absent without any runtime check, so an absent value becomes a TypeError at the use site rather than a handled case.", recommendedFix: "Narrow the value with an explicit check and handle the absent case.", pattern: /[A-Za-z0-9_\]) ]!\s*[.[]/u }),
  Object.freeze({ ruleId: "any-escape-hatch", category: "type_safety", title: "any annotation removes checking from this expression", severity: "medium" as const, problem: "An any annotation opts the expression out of type checking, so a downstream shape change is not reported at this call site.", recommendedFix: "Replace any with the narrowest type the value can hold, or unknown plus a parse.", pattern: /(?:\bas\s+any\b|:\s*any\b)/u }),
  Object.freeze({ ruleId: "unbounded-cast", category: "type_safety", title: "Double cast through unknown bypasses declared types", severity: "low" as const, problem: "A cast through unknown asserts a shape the compiler cannot confirm, so a mismatch surfaces only at runtime.", recommendedFix: "Validate the value against a schema and derive the type from that.", pattern: /\bas\s+unknown\s+as\b/u }),
  Object.freeze({ ruleId: "work-marker", category: "maintainability", title: "Unresolved work marker left in source", severity: "low" as const, problem: "A TODO, FIXME or HACK marker records known incomplete work that no other artifact tracks.", recommendedFix: "Convert the marker into a tracked task, or resolve it.", pattern: /\b(?:TODO|FIXME|HACK|XXX)\b/u }),
  Object.freeze({ ruleId: "empty-catch", category: "error_handling", title: "Catch block swallows the error", severity: "high" as const, problem: "A catch block with no body discards the error, so the failure it hides has no signal at all.", recommendedFix: "Handle the error, rethrow it, or record why it is safe to ignore.", pattern: /catch\s*(?:\([^)]*\))?\s*\{\s*\}/u }),
  Object.freeze({ ruleId: "non-literal-timeout", category: "reliability", title: "Timer scheduled without a recorded bound", severity: "low" as const, problem: "A timer scheduled with a computed delay has no reviewable upper bound at this call site.", recommendedFix: "Name the bound as a constant so the delay is reviewable.", pattern: /set(?:Timeout|Interval)\s*\(\s*[^,)]+,\s*[A-Za-z_$]/u }),
]);

export interface AuditorProfile {
  readonly auditorId: string;
  readonly independenceGroup: string;
  readonly ruleIds: readonly string[];
}

/**
 * Three auditors with deliberately overlapping rule sets.
 *
 * The overlap is what makes clustering and consensus meaningful: a rule two auditors share
 * produces findings that cluster and reach quorum, while a rule only one holds produces a
 * single-source candidate the consensus policy has to dispose of on its own.
 */
export const DEFAULT_AUDITORS: readonly AuditorProfile[] = Object.freeze([
  Object.freeze({ auditorId: "auditor-a", independenceGroup: "group-a", ruleIds: Object.freeze(["empty-catch", "non-null-assertion", "work-marker", "unbounded-cast"]) }),
  Object.freeze({ auditorId: "auditor-b", independenceGroup: "group-b", ruleIds: Object.freeze(["empty-catch", "non-null-assertion", "any-escape-hatch"]) }),
  Object.freeze({ auditorId: "auditor-c", independenceGroup: "group-c", ruleIds: Object.freeze(["empty-catch", "work-marker", "any-escape-hatch", "non-literal-timeout"]) }),
]);

export const AUDITOR_KIND = "scripted_auditors" as const;

/** Run one auditor's rule set over the snapshot. Pure: same snapshot, same findings. */
export function runAuditor(profile: AuditorProfile, snapshot: RepositorySnapshot, maximumFindings = 40): readonly AuditFinding[] {
  const detectors = DETECTORS.filter(({ ruleId }) => profile.ruleIds.includes(ruleId));
  const findings: AuditFinding[] = [];
  for (const file of snapshot.files) {
    for (const detector of detectors) {
      for (const line of matchingLines(file, detector.pattern)) {
        if (findings.length >= maximumFindings) return Object.freeze(findings);
        findings.push(buildFinding(profile, detector, file, line));
      }
    }
  }
  return Object.freeze(findings);
}

function matchingLines(file: SourceFile, pattern: RegExp): readonly number[] {
  const lines: number[] = [];
  for (const [index, text] of file.lines.entries()) if (pattern.test(text)) lines.push(index + 1);
  return lines;
}

function buildFinding(profile: AuditorProfile, detector: Detector, file: SourceFile, line: number): AuditFinding {
  const locationId = `L-${detector.ruleId}-${line}`;
  const snippet = (file.lines[line - 1] ?? "").trim().slice(0, 200);
  return Object.freeze({
    // The id is namespaced to its auditor because finding validation rejects any that is not.
    sourceFindingId: `${profile.auditorId}/${detector.ruleId}/${file.path}#${line}`,
    category: detector.category,
    title: detector.title,
    severity: detector.severity,
    problem: detector.problem,
    recommendedFix: detector.recommendedFix,
    productionBlocker: false,
    locations: Object.freeze([Object.freeze({ id: locationId, path: file.path, startLine: line, endLine: line })]),
    evidence: Object.freeze([Object.freeze({ id: `E-${detector.ruleId}-${line}`, text: snippet, locationIds: Object.freeze([locationId]) })]),
  });
}
