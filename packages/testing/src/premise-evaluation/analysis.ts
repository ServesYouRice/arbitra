import { scorePremiseRun, type PremiseAuditorRun, type PremiseCanonicalIssue, type PremiseGroundTruth, type PremiseReport } from "../metrics/premise.js";
import type { RecordedFinding, RecordedIssue, RecordedRun, UsageSummary } from "./collect.js";
import { matchFinding, mergeMatches, type FindingMatch } from "./matching.js";
import type { EvaluationCondition, EvaluationProtocol, FixtureSpec } from "./protocol.js";
import { pairedBootstrap, round, wilson, type PairedDifference, type Proportion } from "./statistics.js";

/** One completed run as the driver saved it. */
export interface EvaluationRecord {
  readonly key: string;
  readonly fixtureId: string;
  readonly condition: EvaluationCondition;
  readonly repetition: number;
  readonly wallClockMs: number;
  readonly record: RecordedRun;
}

/**
 * The prespecified analysis conditions (docs/qa/p06/PROTOCOL.md):
 *  A  one auditor, one run — its grounded discovery findings (A) and what its pipeline reports (A-pipeline)
 *  B  the union of repeated isolated runs of that same model (same independence group)
 *  C  the union of the heterogeneous run's three auditors' discovery (same family; different variants/endpoints)
 *  D  the heterogeneous run's full reconciliation/verification output (accepted issues)
 */
export type AnalysisCondition = "A" | "A_pipeline" | "B" | "C" | "D" | "D_not_rejected";

export interface ConditionInstance {
  readonly condition: AnalysisCondition;
  readonly fixtureId: string;
  readonly runIds: readonly string[];
  /** Defects detected (by id) — the recall numerator for this instance. */
  readonly detected: readonly string[];
  readonly reported: number;
  readonly trueReported: number;
  readonly decoyReports: number;
  readonly unlistedReports: number;
  readonly decoysHit: readonly string[];
  readonly injectionReportsExcluded: number;
  readonly severityAdequate: number;
  readonly premise: PremiseReport;
  readonly usage: UsageSummary;
  readonly wallClockMs: number;
}

export interface ConditionSummary {
  readonly condition: AnalysisCondition;
  readonly instances: number;
  readonly fixtures: readonly string[];
  /** Defect-detection units: one per (instance, ground-truth defect). */
  readonly recall: Proportion;
  readonly precision: Proportion;
  readonly falsePositives: { readonly decoyReports: number; readonly unlistedReports: number; readonly decoysHit: Proportion };
  readonly severityAdequacy: Proportion;
  readonly usage: UsageSummary & { readonly perInstanceMeanRequests: number | null; readonly perInstanceMeanKnownTokens: number | null };
  readonly wallClockMs: { readonly total: number; readonly perInstanceMean: number | null };
}

export interface AnalysisReport {
  readonly schemaVersion: 1;
  readonly protocolIdentity: string;
  readonly mode: "real_models" | "scripted";
  readonly confidence: number;
  readonly groundTruth: { readonly fixtures: number; readonly defects: number; readonly decoys: number };
  readonly completedRuns: readonly string[];
  readonly missingRuns: readonly string[];
  readonly instances: readonly ConditionInstance[];
  readonly conditions: readonly ConditionSummary[];
  readonly contribution: { readonly B: ContributionSummary | null; readonly C: ContributionSummary | null };
  readonly evidence: { readonly emitted: number; readonly rejectedOnValidation: number; readonly quoteRejected: number; readonly invalidEvidenceRate: Proportion; readonly rejectedTrueDefects: number };
  readonly verification: VerificationSummary;
  readonly plan: PlanSummary;
  readonly comparisons: readonly Comparison[];
  readonly decision: Decision;
  readonly limitations: readonly string[];
}

export interface ContributionSummary {
  /** Per auditor position (first, second, third…): defects only that auditor found, and defects new relative to earlier positions. */
  readonly byPosition: readonly { readonly position: number; readonly identities: readonly string[]; readonly uniqueTrue: number; readonly marginalTrue: number; readonly falsePositives: number }[];
  readonly premiseSignals: Readonly<Record<string, PremiseReport["result"]["premiseSignal"]>>;
}

export interface VerificationSummary {
  readonly items: number;
  readonly decisive: number;
  readonly correct: Proportion;
  readonly confirmedTrue: number; readonly confirmedFalse: number; readonly rejectedTrue: number; readonly rejectedFalse: number; readonly inconclusive: number;
  readonly byCondition: Readonly<Record<string, { readonly items: number; readonly correct: Proportion }>>;
}

export interface PlanSummary {
  readonly plans: number;
  readonly addressedIssues: number;
  readonly addressedTrue: Proportion;
  readonly trueAcceptedCovered: Proportion;
  readonly byCondition: Readonly<Record<string, { readonly plans: number; readonly addressedIssues: number; readonly addressedTrue: Proportion; readonly trueAcceptedCovered: Proportion }>>;
}

export interface Comparison { readonly name: string; readonly left: AnalysisCondition; readonly right: AnalysisCondition; readonly recallDifference: PairedDifference; readonly precisionDifference: number | null; readonly knownTokenRatio: number | null }

export interface Decision {
  readonly heterogeneousOverRepeated: "worthwhile" | "not_worthwhile" | "insufficient_evidence";
  readonly repeatedOverSingle: "worthwhile" | "not_worthwhile" | "insufficient_evidence";
  readonly pipelineOverSinglePipeline: "worthwhile" | "not_worthwhile" | "insufficient_evidence";
  readonly rule: string;
  readonly statement: string;
}

const ACCEPTED_PIPELINE_REPORT = new Set(["accepted", "single_source"]);

export function analyse(protocol: EvaluationProtocol, truths: ReadonlyMap<string, PremiseGroundTruth>, records: readonly EvaluationRecord[], mode: "real_models" | "scripted"): AnalysisReport {
  const confidence = protocol.analysis.confidence;
  const completed = new Set(records.map(({ key }) => key));
  const missingRuns = protocol.schedule.map(({ fixtureId, condition, repetition }) => `${fixtureId}/${condition}/r${repetition}`).filter((key) => !completed.has(key));
  const instances: ConditionInstance[] = [];
  const contributions: { B: PremiseReport[]; C: PremiseReport[] } = { B: [], C: [] };
  const verificationRows: { condition: string; result: string; isTrue: boolean }[] = [];
  const planRows: { condition: string; addressed: readonly string[]; truthById: Map<string, boolean>; trueAccepted: readonly string[] }[] = [];
  let emitted = 0; let rejected = 0; let quoteRejected = 0; let rejectedTrue = 0;
  for (const fixture of protocol.fixtures) {
    const truth = truths.get(fixture.id);
    if (truth === undefined) throw new Error(`P06_GROUND_TRUTH_ABSENT:${fixture.id}`);
    const of = (condition: EvaluationCondition) => records.filter((item) => item.fixtureId === fixture.id && item.condition === condition).sort((a, b) => a.repetition - b.repetition);
    const singles = of("single"); const heterogeneous = of("heterogeneous");
    for (const item of [...singles, ...heterogeneous]) for (const auditor of item.record.auditors) {
      emitted += auditor.findings.length + auditor.rejectedFindings.length + auditor.quoteRejectedCount; rejected += auditor.rejectedFindings.length; quoteRejected += auditor.quoteRejectedCount;
      rejectedTrue += auditor.rejectedFindings.filter((finding) => matchFinding(finding, fixture).classification === "true_defect").length;
    }
    for (const item of singles) {
      const auditor = item.record.auditors[0];
      if (auditor === undefined) throw new Error(`P06_SINGLE_AUDITOR_ABSENT:${item.key}`);
      instances.push(discoveryInstance("A", fixture, truth, protocol, [{ id: auditor.auditorId, run: item, findings: auditor.findings, usage: auditor.usage }], item.record.runId, item.wallClockMs));
      instances.push(pipelineInstance("A_pipeline", fixture, truth, protocol, item, (issue) => ACCEPTED_PIPELINE_REPORT.has(issue.disposition) && issue.verificationOutcome !== "REJECTED"));
      collectVerification("A_pipeline", item, fixture, verificationRows); collectPlan("A_pipeline", item, fixture, planRows);
    }
    if (singles.length >= 2) {
      const union = discoveryInstance("B", fixture, truth, protocol, singles.map((item) => ({ id: `r${item.repetition}`, run: item, findings: item.record.auditors[0]?.findings ?? [], usage: item.record.auditors[0]?.usage ?? emptyUsage() })), singles.map(({ record }) => record.runId), singles.reduce((sum, { wallClockMs }) => sum + wallClockMs, 0));
      instances.push(union); contributions.B.push(union.premise);
    }
    for (const item of heterogeneous) {
      const union = discoveryInstance("C", fixture, truth, protocol, item.record.auditors.map((auditor) => ({ id: auditor.auditorId, run: item, findings: auditor.findings, usage: auditor.usage })), item.record.runId, item.wallClockMs);
      instances.push(union); contributions.C.push(union.premise);
      instances.push(pipelineInstance("D", fixture, truth, protocol, item, (issue) => issue.disposition === "accepted"));
      instances.push(pipelineInstance("D_not_rejected", fixture, truth, protocol, item, (issue) => issue.disposition !== "rejected" && issue.verificationOutcome !== "REJECTED"));
      collectVerification("D", item, fixture, verificationRows); collectPlan("D", item, fixture, planRows);
    }
  }
  const conditions = (["A", "A_pipeline", "B", "C", "D", "D_not_rejected"] as const).map((condition) => summarise(condition, instances.filter((instance) => instance.condition === condition), truths, confidence)).filter(({ instances: count }) => count > 0);
  const comparisons = [compare("heterogeneous discovery (C) vs repeated same-model discovery (B)", "C", "B"), compare("repeated same-model discovery (B) vs one run (A)", "B", "A"), compare("heterogeneous discovery (C) vs one run (A)", "C", "A"), compare("full pipeline accepted (D) vs single-auditor pipeline (A_pipeline)", "D", "A_pipeline")]
    .flatMap((make) => make(instances, truths, protocol));
  const defects = [...truths.values()].reduce((sum, truth) => sum + truth.items.filter(({ kind }) => kind === "defect").length, 0);
  const decoys = [...truths.values()].reduce((sum, truth) => sum + truth.items.filter(({ kind }) => kind === "decoy").length, 0);
  return Object.freeze({
    schemaVersion: 1, protocolIdentity: `${protocol.protocolId}@${protocol.version}`, mode, confidence,
    groundTruth: { fixtures: truths.size, defects, decoys },
    completedRuns: [...completed].sort(), missingRuns,
    instances: Object.freeze(instances), conditions: Object.freeze(conditions),
    contribution: { B: contributionOf(contributions.B), C: contributionOf(contributions.C) },
    evidence: { emitted, rejectedOnValidation: rejected, quoteRejected, invalidEvidenceRate: wilson(rejected + quoteRejected, emitted, confidence), rejectedTrueDefects: rejectedTrue },
    verification: verificationSummary(verificationRows, confidence),
    plan: planSummary(planRows, confidence),
    comparisons: Object.freeze(comparisons),
    decision: decide(comparisons, conditions),
    limitations: Object.freeze([
      "All auditors are Gemini models (one family): condition C compares variants and endpoints of one family, so the premise about heterogeneous model families remains untested.",
      `${truths.size} small fixtures with ${defects} defects and ${decoys} decoys: intervals are wide and fixture effects dominate.`,
      "Units within a fixture are not independent (shared code, shared run); Wilson intervals treat them as independent and are optimistic.",
      "Matching is a prespecified location-and-keyword rubric; unlisted findings count as false positives even when they may describe real issues (reviewed separately in the README).",
      "Free-tier quota and provider availability bounded the number of repetitions; missing runs are listed rather than imputed.",
    ]),
  });
}

interface DiscoveryAuditor { readonly id: string; readonly run: EvaluationRecord; readonly findings: readonly RecordedFinding[]; readonly usage: UsageSummary }

function discoveryInstance(condition: AnalysisCondition, fixture: FixtureSpec, truth: PremiseGroundTruth, protocol: EvaluationProtocol, auditors: readonly DiscoveryAuditor[], runIds: string | readonly string[], wallClockMs: number): ConditionInstance {
  let reported = 0; let trueReported = 0; let decoyReports = 0; let unlisted = 0; let excluded = 0; let severity = 0; const decoysHit = new Set<string>(); const detected = new Set<string>();
  const premiseAuditors = auditors.map(({ id, run, findings, usage }): PremiseAuditorRun => {
    const scored: { findingId: string; matchedGroundTruthIds: readonly string[] }[] = [];
    for (const finding of findings) {
      const match = matchFinding(finding, fixture);
      if (isInjectionReport(finding, match)) { excluded += 1; continue; }
      tally(match); scored.push({ findingId: finding.sourceFindingId, matchedGroundTruthIds: match.matchedGroundTruthIds });
    }
    const auditor = run.record.auditors.find((item) => item.findings === findings) ?? run.record.auditors[0];
    return { auditorId: id, modelIdentity: `${auditor?.modelId ?? "unknown"}@${auditor?.transport ?? "unknown"}`, independenceGroup: auditor?.independenceGroup ?? "unknown", findings: scored,
      repairCount: auditor?.repairedCount ?? 0, invalidEvidenceCount: (auditor?.rejectedFindings.length ?? 0) + (auditor?.quoteRejectedCount ?? 0), refusalCount: 0, cost: usage.inputTokens + usage.outputTokens, latencyMs: usage.attemptDurationMs,
      harnessId: run.record.identity.harness.id };
  });
  function tally(match: FindingMatch): void {
    reported += 1;
    if (match.classification === "true_defect") { trueReported += 1; match.defects.forEach((id) => detected.add(id)); if (match.severityAdequate === true) severity += 1; }
    else if (match.classification === "decoy") { decoyReports += 1; match.decoys.forEach((id) => decoysHit.add(id)); }
    else unlisted += 1;
  }
  const first = auditors[0]?.run.record;
  const premise = scorePremiseRun({ runId: typeof runIds === "string" ? runIds : runIds.join("+"), fixtureId: fixture.id, protocolId: first?.identity.protocol.id ?? protocol.protocolId, protocolVersion: first?.identity.protocol.version ?? protocol.version, currency: "tokens", mode: "real_models", auditors: premiseAuditors, canonicalIssues: [] }, truth);
  return Object.freeze({ condition, fixtureId: fixture.id, runIds: Object.freeze(typeof runIds === "string" ? [runIds] : [...runIds]), detected: Object.freeze([...detected].sort()), reported, trueReported, decoyReports, unlistedReports: unlisted, decoysHit: Object.freeze([...decoysHit].sort()), injectionReportsExcluded: excluded, severityAdequate: severity, premise, usage: addUsage(auditors.map(({ usage }) => usage)), wallClockMs });
}

function pipelineInstance(condition: AnalysisCondition, fixture: FixtureSpec, truth: PremiseGroundTruth, protocol: EvaluationProtocol, item: EvaluationRecord, reportedBy: (issue: RecordedIssue) => boolean): ConditionInstance {
  const matches = issueMatches(item, fixture);
  let reported = 0; let trueReported = 0; let decoyReports = 0; let unlisted = 0; let excluded = 0; let severity = 0; const decoysHit = new Set<string>(); const detected = new Set<string>();
  const canonical: PremiseCanonicalIssue[] = [];
  for (const issue of item.record.issues) {
    const match = matches.get(issue.candidateId) as FindingMatch;
    const shown = reportedBy(issue);
    if (shown && isInjectionIssue(issue, item, match)) { excluded += 1; continue; }
    canonical.push({ issueId: issue.candidateId, accepted: shown, matchedGroundTruthIds: match.matchedGroundTruthIds });
    if (!shown) continue;
    reported += 1;
    if (match.classification === "true_defect") { trueReported += 1; match.defects.forEach((id) => detected.add(id)); if (match.severityAdequate === true) severity += 1; }
    else if (match.classification === "decoy") { decoyReports += 1; match.decoys.forEach((id) => decoysHit.add(id)); }
    else unlisted += 1;
  }
  const premise = scorePremiseRun({ runId: item.record.runId, fixtureId: fixture.id, protocolId: item.record.identity.protocol.id, protocolVersion: item.record.identity.protocol.version, currency: "tokens", mode: "real_models",
    auditors: item.record.auditors.map((auditor) => ({ auditorId: auditor.auditorId, modelIdentity: `${auditor.modelId}@${auditor.transport}`, independenceGroup: auditor.independenceGroup, findings: [], repairCount: auditor.repairedCount, invalidEvidenceCount: auditor.rejectedFindings.length + auditor.quoteRejectedCount, refusalCount: 0, cost: auditor.usage.inputTokens + auditor.usage.outputTokens, latencyMs: auditor.usage.attemptDurationMs, harnessId: item.record.identity.harness.id })),
    canonicalIssues: canonical }, truth);
  void protocol;
  return Object.freeze({ condition, fixtureId: fixture.id, runIds: Object.freeze([item.record.runId]), detected: Object.freeze([...detected].sort()), reported, trueReported, decoyReports, unlistedReports: unlisted, decoysHit: Object.freeze([...decoysHit].sort()), injectionReportsExcluded: excluded, severityAdequate: severity, premise, usage: item.record.usage, wallClockMs: item.wallClockMs });
}

/** A canonical issue carries the union of its source findings' rubric matches. */
export function issueMatches(item: EvaluationRecord, fixture: FixtureSpec): Map<string, FindingMatch> {
  const sources = new Map(item.record.sourceFindings.map((finding) => [finding.sourceFindingId, finding]));
  for (const auditor of item.record.auditors) for (const finding of auditor.findings) if (!sources.has(finding.sourceFindingId)) sources.set(finding.sourceFindingId, finding);
  return new Map(item.record.issues.map((issue) => {
    const members = issue.sourceFindingIds.flatMap((id) => { const finding = sources.get(id); return finding === undefined ? [] : [finding]; });
    return [issue.candidateId, mergeMatches(members.map((finding) => matchFinding(finding, fixture)), issue.severity, fixture)] as const;
  }));
}

/** The Audit protocol requires reporting prompt-injection attempts; such a report is neither a defect detection nor a false alarm unless it also matches a defect. */
function isInjectionReport(finding: RecordedFinding, match: FindingMatch): boolean { return match.classification !== "true_defect" && /prompt[_ -]?injection/iu.test(finding.category); }
function isInjectionIssue(issue: RecordedIssue, item: EvaluationRecord, match: FindingMatch): boolean {
  if (match.classification === "true_defect") return false;
  const sources = item.record.sourceFindings.filter(({ sourceFindingId }) => issue.sourceFindingIds.includes(sourceFindingId));
  return sources.length > 0 && sources.every(({ category }) => /prompt[_ -]?injection/iu.test(category));
}

function collectVerification(condition: string, item: EvaluationRecord, fixture: FixtureSpec, rows: { condition: string; result: string; isTrue: boolean }[]): void {
  const matches = issueMatches(item, fixture);
  for (const result of item.record.verification) {
    const match = matches.get(result.candidateId);
    if (match === undefined) continue;
    const issue = item.record.issues.find(({ candidateId }) => candidateId === result.candidateId);
    if (issue !== undefined && isInjectionIssue(issue, item, match)) continue;
    rows.push({ condition, result: result.result, isTrue: match.classification === "true_defect" });
  }
}

function collectPlan(condition: string, item: EvaluationRecord, fixture: FixtureSpec, rows: { condition: string; addressed: readonly string[]; truthById: Map<string, boolean>; trueAccepted: readonly string[] }[]): void {
  if (item.record.plan === null) return;
  const matches = issueMatches(item, fixture);
  const truthById = new Map([...matches].map(([id, match]) => [id, match.classification === "true_defect"]));
  rows.push({ condition, addressed: item.record.plan.addressedIssueIds.filter((id) => truthById.has(id)), truthById, trueAccepted: item.record.issues.filter(({ candidateId, disposition }) => disposition === "accepted" && truthById.get(candidateId) === true).map(({ candidateId }) => candidateId) });
}

function verificationSummary(rows: readonly { condition: string; result: string; isTrue: boolean }[], confidence: number): VerificationSummary {
  const decisive = rows.filter(({ result }) => result === "CONFIRMED" || result === "REJECTED");
  const correct = (list: typeof rows) => list.filter(({ result, isTrue }) => (result === "CONFIRMED" && isTrue) || (result === "REJECTED" && !isTrue)).length;
  const byCondition: Record<string, { items: number; correct: Proportion }> = {};
  for (const condition of [...new Set(rows.map((row) => row.condition))].sort()) {
    const list = rows.filter((row) => row.condition === condition); const settled = list.filter(({ result }) => result === "CONFIRMED" || result === "REJECTED");
    byCondition[condition] = { items: list.length, correct: wilson(correct(settled), settled.length, confidence) };
  }
  return Object.freeze({ items: rows.length, decisive: decisive.length, correct: wilson(correct(decisive), decisive.length, confidence),
    confirmedTrue: rows.filter(({ result, isTrue }) => result === "CONFIRMED" && isTrue).length, confirmedFalse: rows.filter(({ result, isTrue }) => result === "CONFIRMED" && !isTrue).length,
    rejectedTrue: rows.filter(({ result, isTrue }) => result === "REJECTED" && isTrue).length, rejectedFalse: rows.filter(({ result, isTrue }) => result === "REJECTED" && !isTrue).length,
    inconclusive: rows.length - decisive.length, byCondition: Object.freeze(byCondition) });
}

function planSummary(rows: readonly { condition: string; addressed: readonly string[]; truthById: Map<string, boolean>; trueAccepted: readonly string[] }[], confidence: number): PlanSummary {
  const of = (list: typeof rows) => {
    const addressed = list.flatMap(({ addressed: ids }) => ids); const addressedTrue = list.reduce((sum, row) => sum + row.addressed.filter((id) => row.truthById.get(id) === true).length, 0);
    const trueAccepted = list.reduce((sum, row) => sum + row.trueAccepted.length, 0); const covered = list.reduce((sum, row) => sum + row.trueAccepted.filter((id) => row.addressed.includes(id)).length, 0);
    return { plans: list.length, addressedIssues: addressed.length, addressedTrue: wilson(addressedTrue, addressed.length, confidence), trueAcceptedCovered: wilson(covered, trueAccepted, confidence) };
  };
  const byCondition: Record<string, ReturnType<typeof of>> = {};
  for (const condition of [...new Set(rows.map((row) => row.condition))].sort()) byCondition[condition] = of(rows.filter((row) => row.condition === condition));
  return Object.freeze({ ...of(rows), byCondition: Object.freeze(byCondition) });
}

function summarise(condition: AnalysisCondition, list: readonly ConditionInstance[], truths: ReadonlyMap<string, PremiseGroundTruth>, confidence: number): ConditionSummary {
  const defectsOf = (fixtureId: string) => truths.get(fixtureId)?.items.filter(({ kind }) => kind === "defect").length ?? 0;
  const decoysOf = (fixtureId: string) => truths.get(fixtureId)?.items.filter(({ kind }) => kind === "decoy").length ?? 0;
  const usage = addUsage(list.map(({ usage: value }) => value));
  const wall = list.reduce((sum, { wallClockMs }) => sum + wallClockMs, 0);
  return Object.freeze({
    condition, instances: list.length, fixtures: Object.freeze([...new Set(list.map(({ fixtureId }) => fixtureId))].sort()),
    recall: wilson(list.reduce((sum, { detected }) => sum + detected.length, 0), list.reduce((sum, { fixtureId }) => sum + defectsOf(fixtureId), 0), confidence),
    precision: wilson(list.reduce((sum, { trueReported }) => sum + trueReported, 0), list.reduce((sum, { reported }) => sum + reported, 0), confidence),
    falsePositives: { decoyReports: list.reduce((sum, { decoyReports }) => sum + decoyReports, 0), unlistedReports: list.reduce((sum, { unlistedReports }) => sum + unlistedReports, 0),
      decoysHit: wilson(list.reduce((sum, { decoysHit }) => sum + decoysHit.length, 0), list.reduce((sum, { fixtureId }) => sum + decoysOf(fixtureId), 0), confidence) },
    severityAdequacy: wilson(list.reduce((sum, { severityAdequate }) => sum + severityAdequate, 0), list.reduce((sum, { trueReported }) => sum + trueReported, 0), confidence),
    usage: { ...usage, perInstanceMeanRequests: list.length === 0 ? null : round(usage.requests / list.length), perInstanceMeanKnownTokens: list.length === 0 ? null : round((usage.inputTokens + usage.outputTokens) / list.length) },
    wallClockMs: { total: wall, perInstanceMean: list.length === 0 ? null : round(wall / list.length) },
  });
}

/**
 * Paired comparison over ground-truth defects of fixtures both conditions observed. A unit's
 * value is the fraction of that condition's instances (repetitions) that detected the defect.
 */
function compare(name: string, left: AnalysisCondition, right: AnalysisCondition) {
  return (instances: readonly ConditionInstance[], truths: ReadonlyMap<string, PremiseGroundTruth>, protocol: EvaluationProtocol): Comparison[] => {
    const leftOf = instances.filter(({ condition }) => condition === left); const rightOf = instances.filter(({ condition }) => condition === right);
    const fixtures = [...new Set(leftOf.map(({ fixtureId }) => fixtureId))].filter((id) => rightOf.some(({ fixtureId }) => fixtureId === id)).sort();
    if (fixtures.length === 0) return [];
    const rate = (list: readonly ConditionInstance[], fixtureId: string, defect: string) => { const own = list.filter((instance) => instance.fixtureId === fixtureId); return own.filter(({ detected }) => detected.includes(defect)).length / own.length; };
    const pairs = fixtures.flatMap((fixtureId) => (truths.get(fixtureId)?.items ?? []).filter(({ kind }) => kind === "defect").map(({ id }) => [rate(leftOf, fixtureId, id), rate(rightOf, fixtureId, id)] as const));
    const precision = (list: readonly ConditionInstance[]) => { const own = list.filter(({ fixtureId }) => fixtures.includes(fixtureId)); const reported = own.reduce((sum, { reported: value }) => sum + value, 0); return reported === 0 ? null : own.reduce((sum, { trueReported }) => sum + trueReported, 0) / reported; };
    const [pl, pr] = [precision(leftOf), precision(rightOf)];
    const tokens = (list: readonly ConditionInstance[]) => { const own = list.filter(({ fixtureId }) => fixtures.includes(fixtureId)); return own.length === 0 ? 0 : own.reduce((sum, { usage }) => sum + usage.inputTokens + usage.outputTokens, 0) / own.length; };
    const [tl, tr] = [tokens(leftOf), tokens(rightOf)];
    return [Object.freeze({ name, left, right, recallDifference: pairedBootstrap(pairs, protocol.analysis.bootstrapIterations, protocol.analysis.seed, protocol.analysis.confidence), precisionDifference: pl === null || pr === null ? null : round(pl - pr), knownTokenRatio: tr === 0 ? null : round(tl / tr) })];
  };
}

/** The prespecified decision rule (PROTOCOL.md §Decision). */
export const MINIMUM_DECISION_UNITS = 10;
export const DECISION_RULE = "fewer than 10 paired ground-truth defects: insufficient_evidence; otherwise worthwhile: the paired-bootstrap interval of the recall difference lies above 0 and the precision difference is at least -0.10; not_worthwhile: the interval lies below 0, or it lies within [-0.05, 0.05] entirely while the left condition spends at least 1.5x the known tokens; otherwise insufficient_evidence";

function verdict(comparison: Comparison | undefined): Decision["heterogeneousOverRepeated"] {
  if (comparison === undefined || comparison.recallDifference.interval === null || comparison.recallDifference.units < MINIMUM_DECISION_UNITS) return "insufficient_evidence";
  const [low, high] = comparison.recallDifference.interval;
  if (low > 0 && (comparison.precisionDifference ?? 0) >= -0.1) return "worthwhile";
  if (high < 0 || (low >= -0.05 && high <= 0.05 && (comparison.knownTokenRatio ?? 0) >= 1.5)) return "not_worthwhile";
  return "insufficient_evidence";
}

function decide(comparisons: readonly Comparison[], conditions: readonly ConditionSummary[]): Decision {
  const find = (left: AnalysisCondition, right: AnalysisCondition) => comparisons.find((item) => item.left === left && item.right === right);
  const heterogeneous = verdict(find("C", "B")); const repeated = verdict(find("B", "A")); const pipeline = verdict(find("D", "A_pipeline"));
  const recall = (condition: AnalysisCondition) => conditions.find((item) => item.condition === condition)?.recall.estimate ?? null;
  const statement = [
    `Heterogeneous (same-family) auditors versus repeated runs of one model: ${heterogeneous.replaceAll("_", " ")} (recall C ${String(recall("C"))} vs B ${String(recall("B"))}).`,
    `Repeated isolated runs versus one run: ${repeated.replaceAll("_", " ")} (recall B ${String(recall("B"))} vs A ${String(recall("A"))}).`,
    `Full reconciliation/verification pipeline versus the single-auditor pipeline: ${pipeline.replaceAll("_", " ")} (recall D ${String(recall("D"))} vs A_pipeline ${String(recall("A_pipeline"))}).`,
    "Heterogeneous model families were not available, so the multi-family premise itself is untested by this evaluation.",
  ].join(" ");
  return Object.freeze({ heterogeneousOverRepeated: heterogeneous, repeatedOverSingle: repeated, pipelineOverSinglePipeline: pipeline, rule: DECISION_RULE, statement });
}

function contributionOf(reports: readonly PremiseReport[]): ContributionSummary | null {
  if (reports.length === 0) return null;
  const positions = Math.max(...reports.map(({ auditors }) => auditors.length));
  return Object.freeze({
    byPosition: Array.from({ length: positions }, (_, position) => {
      const rows = reports.flatMap(({ auditors }) => auditors[position] === undefined ? [] : [auditors[position]]);
      return { position: position + 1, identities: [...new Set(rows.map(({ modelIdentity, independenceGroup }) => `${modelIdentity} [${independenceGroup}]`))].sort(), uniqueTrue: rows.reduce((sum, { uniqueTrueContribution }) => sum + uniqueTrueContribution, 0), marginalTrue: rows.reduce((sum, { marginalTrueContribution }) => sum + marginalTrueContribution, 0), falsePositives: rows.reduce((sum, { falsePositiveCount }) => sum + falsePositiveCount, 0) };
    }),
    premiseSignals: Object.freeze(Object.fromEntries(reports.map(({ fixtureId, runId, result }) => [`${fixtureId}:${runId}`, result.premiseSignal]))),
  });
}

function addUsage(list: readonly UsageSummary[]): UsageSummary {
  return list.reduce((sum, usage) => ({ requests: sum.requests + usage.requests, failedRequests: sum.failedRequests + usage.failedRequests, inputTokens: sum.inputTokens + usage.inputTokens, outputTokens: sum.outputTokens + usage.outputTokens, unknownUsageRequests: sum.unknownUsageRequests + usage.unknownUsageRequests, attemptDurationMs: sum.attemptDurationMs + usage.attemptDurationMs, repairTurns: sum.repairTurns + usage.repairTurns }), emptyUsage());
}
function emptyUsage(): UsageSummary { return { requests: 0, failedRequests: 0, inputTokens: 0, outputTokens: 0, unknownUsageRequests: 0, attemptDurationMs: 0, repairTurns: 0 }; }
