import { EvaluationCorpusStore, type CorpusExportResult, type EvaluationCorpusImport } from "@arbitra/persistence/evaluation-corpus/store.js";
import type { CorpusRedactor } from "@arbitra/persistence/evaluation-corpus/report.js";
import type { CorpusAdjudication, CorpusObservation, EvaluationRunProvenance, GroundTruthVersion } from "@arbitra/schemas/evaluation-corpus.js";
import { REDACTION_PATTERN_VERSION, redactSecrets } from "@arbitra/security/redaction";

import type { PremiseGroundTruth } from "../metrics/premise.js";
import { issueMatches, type EvaluationRecord } from "./analysis.js";
import { matchFinding } from "./matching.js";
import type { EvaluationProtocol, FixtureSpec } from "./protocol.js";

/** The production redactor, adapted at the composition boundary persistence cannot import. */
export const CORPUS_REDACTOR: CorpusRedactor = {
  version: `security-redaction@${REDACTION_PATTERN_VERSION}`,
  redact(text) { const result = redactSecrets(text); return { text: result.text, redactionCount: result.redactions.length }; },
};

/**
 * Persist every completed run into the P05 durable corpus, idempotently:
 *  - each fixture's ground truth as an immutable version;
 *  - each run's provenance (snapshot, protocol, harness and per-auditor model identity from its traces);
 *  - per canonical issue, the pipeline's own decision as observation version 0 — an independence
 *    observation for multi-auditor runs (who found it in isolated discovery, and whether consensus
 *    accepted it) and a real-world-outcome observation for every run — followed by the ground-truth
 *    ruling as adjudication version 1, so disagreement with ground truth is explicit history;
 *  - per fixture, the repeated single-model runs as one independence set whose auditors are the
 *    repetitions of one model (one independence group), observed per ground-truth item.
 */
export function corpusImport(protocol: EvaluationProtocol, truths: ReadonlyMap<string, PremiseGroundTruth>, records: readonly EvaluationRecord[], mode: "real_models" | "scripted", adjudicatedAt: string): EvaluationCorpusImport {
  const adjudicator = `${protocol.protocolId}-rubric@${protocol.version}`;
  const groundTruth: GroundTruthVersion[] = [...truths.values()].map((truth) => ({ groundTruthId: truth.fixtureId, version: truth.version, items: truth.items.map((item) => ({ ...item })) }));
  const runs: EvaluationRunProvenance[] = []; const observations: CorpusObservation[] = []; const adjudications: CorpusAdjudication[] = [];
  for (const item of records) {
    const fixture = fixtureOf(protocol, item.fixtureId); const truth = truths.get(item.fixtureId);
    if (truth === undefined) throw new Error(`P06_GROUND_TRUTH_ABSENT:${item.fixtureId}`);
    const { record } = item;
    runs.push({ runId: record.runId, mode, snapshot: { repository: `fixture:${item.fixtureId}`, sourceDigest: `sha256:${record.snapshot.repositoryDigest}`, commit: record.snapshot.gitHead },
      protocol: { ...record.identity.protocol }, harness: { ...record.identity.harness }, models: record.identity.models.map((model) => ({ ...model })), groundTruth: { groundTruthId: truth.fixtureId, version: truth.version } });
    const matches = issueMatches(item, fixture);
    const auditorIds = record.auditors.map(({ auditorId }) => auditorId);
    for (const issue of record.issues) {
      const match = matches.get(issue.candidateId);
      if (match === undefined) continue;
      const isTrue = match.classification === "true_defect";
      const cited = match.matchedGroundTruthIds[0];
      const rationale = `${match.classification}${match.matchedGroundTruthIds.length === 0 ? "" : `:${match.matchedGroundTruthIds.join(",")}`} by the prespecified location-and-keyword rubric`;
      const groundTruthItem = cited === undefined ? null : { groundTruthId: truth.fixtureId, version: truth.version, itemId: cited };
      const pipelineOutcome = issue.verificationOutcome === "REJECTED" || issue.disposition === "rejected" ? "rejected" : issue.verificationOutcome === "CONFIRMED" || issue.disposition === "accepted" ? "verified" : "ignored";
      observations.push({ corpus: "real_world_outcomes", runId: record.runId, findingId: issue.candidateId, outcome: pipelineOutcome, costUsd: null, latencyMs: null });
      adjudications.push({ runId: record.runId, findingId: issue.candidateId, version: 1, judgment: { corpus: "real_world_outcomes", outcome: isTrue ? "verified" : "rejected" }, adjudicator, rationale, adjudicatedAt, groundTruthItem });
      if (auditorIds.length >= 2) {
        const foundBy = auditorIds.filter((auditorId) => record.auditors.find((auditor) => auditor.auditorId === auditorId)?.findings.some(({ sourceFindingId }) => issue.sourceFindingIds.includes(sourceFindingId)) === true);
        observations.push({ corpus: "independence", runId: record.runId, findingId: issue.candidateId, auditorIds, independentlyFoundBy: foundBy, accepted: issue.disposition === "accepted" });
        adjudications.push({ runId: record.runId, findingId: issue.candidateId, version: 1, judgment: { corpus: "independence", accepted: isTrue }, adjudicator, rationale, adjudicatedAt, groundTruthItem });
      }
    }
  }
  for (const fixture of protocol.fixtures) {
    const singles = records.filter((item) => item.fixtureId === fixture.id && item.condition === "single").sort((a, b) => a.repetition - b.repetition);
    const truth = truths.get(fixture.id);
    if (singles.length < 2 || truth === undefined) continue;
    const first = singles[0]?.record;
    if (first === undefined || singles.some(({ record }) => record.snapshot.repositoryDigest !== first.snapshot.repositoryDigest || record.identity.protocol.hash !== first.identity.protocol.hash || record.identity.harness.policyHash !== first.identity.harness.policyHash)) throw new Error(`P06_REPETITION_IDENTITY_MISMATCH:${fixture.id}`);
    const runId = `${protocol.protocolId}-${protocol.version}-${fixture.id}-single-repetitions-${singles.map(({ repetition }) => repetition).join("-")}`;
    const auditorIds = singles.map(({ repetition }) => `repetition-${repetition}`);
    runs.push({ runId, mode, snapshot: { repository: `fixture:${fixture.id}`, sourceDigest: `sha256:${first.snapshot.repositoryDigest}`, commit: first.snapshot.gitHead }, protocol: { ...first.identity.protocol }, harness: { ...first.identity.harness },
      models: singles.map(({ repetition, record }) => { const model = record.identity.models[0]; if (model === undefined) throw new Error(`P06_MODEL_IDENTITY_ABSENT:${record.runId}`); return { ...model, auditorId: `repetition-${repetition}` }; }),
      groundTruth: { groundTruthId: truth.fixtureId, version: truth.version } });
    for (const item of truth.items) {
      const foundBy = singles.filter(({ record }) => record.auditors[0]?.findings.some((finding) => matchFinding(finding, fixture).matchedGroundTruthIds.includes(item.id)) === true).map(({ repetition }) => `repetition-${repetition}`);
      if (foundBy.length === 0) continue;
      // No consensus runs across separate repetitions: `accepted` records the ground-truth kind.
      observations.push({ corpus: "independence", runId, findingId: item.id, auditorIds, independentlyFoundBy: foundBy, accepted: item.kind === "defect" });
    }
  }
  return { groundTruth, runs, observations, adjudications };
}

export interface PersistedCorpus { readonly appended: number; readonly unchanged: number; readonly independenceReport: CorpusExportResult; readonly outcomeReport: CorpusExportResult }

export async function persistCorpus(directory: string, bundle: EvaluationCorpusImport, now: () => number): Promise<PersistedCorpus> {
  const store = new EvaluationCorpusStore(directory, { clock: { now } });
  await store.open();
  // Observations (version 0) must exist before their adjudications; both imports are idempotent.
  const base = await store.import({ ...(bundle.groundTruth === undefined ? {} : { groundTruth: bundle.groundTruth }), ...(bundle.runs === undefined ? {} : { runs: bundle.runs }), ...(bundle.observations === undefined ? {} : { observations: bundle.observations }) });
  const rulings = await store.import({ ...(bundle.adjudications === undefined ? {} : { adjudications: bundle.adjudications }) });
  const independenceReport = await store.exportReport({ corpus: "independence", groupBy: ["model", "harness", "protocol", "groundTruth", "mode"] }, CORPUS_REDACTOR);
  const outcomeReport = await store.exportReport({ corpus: "real_world_outcomes", groupBy: ["model", "harness", "protocol", "groundTruth", "mode"] }, CORPUS_REDACTOR);
  for (const exported of [independenceReport, outcomeReport]) await store.reconstructReport(exported.ref, CORPUS_REDACTOR);
  return { appended: base.appended + rulings.appended, unchanged: base.unchanged + rulings.unchanged, independenceReport, outcomeReport };
}

function fixtureOf(protocol: EvaluationProtocol, fixtureId: string): FixtureSpec {
  const fixture = protocol.fixtures.find(({ id }) => id === fixtureId);
  if (fixture === undefined) throw new Error(`P06_FIXTURE_ABSENT:${fixtureId}`);
  return fixture;
}
