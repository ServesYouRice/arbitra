import { createHash } from "node:crypto";
import { clustersFrom } from "./deterministic.js";
import { cluster } from "./escalate.js";
import type { SemanticClusteringRuntime } from "./escalate.js";
import type { ClusterableFinding, ClusteringResult, ClusteringStrategy, FindingCluster, StrategyResult, ValidatedClusterInput } from "./types.js";

/**
 * P18 evaluation harness (docs/qa/p18/PROTOCOL.md). Compares structural clustering, bounded escalation
 * and a pluggable local text embedder against labelled ground-truth clusters. Evaluation only: it is not
 * exported from the clustering index and no runtime path imports it. Constants mirror the protocol and
 * must change only with a new protocol version.
 */
export const P18_PROTOCOL_VERSION = "p18-protocol-v1";
export const FINDING_TEXT_TEMPLATE = "finding-text-v1";
export const P18_THRESHOLD_GRID: readonly number[] = Object.freeze(Array.from({ length: 14 }, (_, index) => Math.round((0.3 + index * 0.05) * 100) / 100));
export const P18_SETTINGS = Object.freeze({ maximumEscalatedPairs: 20, bootstrapResamples: 10_000, bootstrapSeed: 18, repeats: 5, falseMergeWeight: 2 });
export const P18_CRITERIA = Object.freeze({ minimumFixtures: 2, minimumMultiMemberClusters: 30, minimumSamePairs: 100, minimumAmbiguousPairs: 30, minimumRelativeReduction: 0.25, maximumWarmP95Ms: 750, maximumWarmRunFindings: 25, maximumColdLoadMs: 20_000, maximumModelBytes: 150_000_000, maximumRssGrowthBytes: 700_000_000, maximumDependencyBytes: 500_000_000 });

export interface TextEmbedderIdentity { readonly model: string; readonly revision: string; readonly artifact: string; readonly artifactSha256: string; readonly runtime: string; readonly dtype: string; readonly pooling: "mean"; readonly normalized: true; readonly dimensions: number }
export interface TextEmbedder { readonly identity: TextEmbedderIdentity; embed(texts: readonly string[]): Promise<readonly Float32Array[]> }

export type GroundTruthKind = "defect" | "decoy" | "noise";
export interface ClusteringCorpusFinding { readonly groundTruthId: string; readonly auditorId: string; readonly finding: ClusterableFinding }
export interface ClusteringCorpusRun { readonly runId: string; readonly fixtureId: string; readonly findings: readonly ClusteringCorpusFinding[] }
export interface ClusteringCorpusFixture { readonly fixtureId: string; readonly version: number; readonly groundTruth: string; readonly groundTruthSha256: string }
export interface ClusteringCorpus { readonly corpusId: string; readonly version: number; readonly mode: "authored" | "real_models"; readonly provenance: string; readonly sourceFixtures: readonly ClusteringCorpusFixture[]; readonly runs: readonly ClusteringCorpusRun[] }
export interface LoadedClusteringCorpus { readonly corpus: ClusteringCorpus; readonly corpusSha256: string; readonly kinds: ReadonlyMap<string, GroundTruthKind> }

/** Parses and validates a corpus. `groundTruthFiles` maps each declared `groundTruth` path to that file's text; hashes must match. */
export function loadClusteringCorpus(corpusText: string, groundTruthFiles: ReadonlyMap<string, string>): LoadedClusteringCorpus {
  let corpus: ClusteringCorpus; try { corpus = JSON.parse(corpusText) as ClusteringCorpus; } catch { throw new Error("CLUSTERING_CORPUS_INVALID_JSON"); }
  if (typeof corpus.corpusId !== "string" || corpus.corpusId.trim() === "" || !Number.isSafeInteger(corpus.version) || !["authored", "real_models"].includes(corpus.mode) || !Array.isArray(corpus.sourceFixtures) || !Array.isArray(corpus.runs)) throw new Error("CLUSTERING_CORPUS_INVALID_IDENTITY");
  const fixtureKinds = new Map<string, Map<string, "defect" | "decoy">>();
  for (const fixture of corpus.sourceFixtures) {
    const text = groundTruthFiles.get(fixture.groundTruth); if (text === undefined) throw new Error(`CLUSTERING_CORPUS_GROUND_TRUTH_MISSING:${fixture.fixtureId}`);
    if (sha256(text) !== fixture.groundTruthSha256) throw new Error(`CLUSTERING_CORPUS_GROUND_TRUTH_HASH_MISMATCH:${fixture.fixtureId}`);
    const truth = JSON.parse(text) as { readonly fixtureId?: unknown; readonly version?: unknown; readonly items?: readonly { readonly id: string; readonly kind: "defect" | "decoy" }[] };
    if (truth.fixtureId !== fixture.fixtureId || truth.version !== fixture.version || !Array.isArray(truth.items) || fixtureKinds.has(fixture.fixtureId)) throw new Error(`CLUSTERING_CORPUS_FIXTURE_IDENTITY_MISMATCH:${fixture.fixtureId}`);
    fixtureKinds.set(fixture.fixtureId, new Map(truth.items.map(({ id, kind }) => [id, kind])));
  }
  const kinds = new Map<string, GroundTruthKind>(); const runIds = new Set<string>();
  for (const run of corpus.runs) {
    const truth = fixtureKinds.get(run.fixtureId); if (truth === undefined) throw new Error(`CLUSTERING_CORPUS_UNKNOWN_FIXTURE:${run.runId}:${run.fixtureId}`);
    if (run.runId.trim() === "" || runIds.has(run.runId)) throw new Error(`CLUSTERING_CORPUS_DUPLICATE_RUN:${run.runId}`); runIds.add(run.runId);
    const ids = new Set<string>();
    for (const { groundTruthId, auditorId, finding } of run.findings) {
      if (ids.has(finding.sourceFindingId)) throw new Error(`CLUSTERING_CORPUS_DUPLICATE_FINDING:${run.runId}:${finding.sourceFindingId}`); ids.add(finding.sourceFindingId);
      if (auditorId.trim() === "" || [finding.title, finding.problem, finding.recommendedFix].some((value) => typeof value !== "string" || value.trim() === "") || finding.locations.length === 0) throw new Error(`CLUSTERING_CORPUS_INVALID_FINDING:${run.runId}:${finding.sourceFindingId}`);
      const kind: GroundTruthKind | undefined = groundTruthId.startsWith("NOISE:") && groundTruthId.length > 6 ? "noise" : truth.get(groundTruthId);
      if (kind === undefined) throw new Error(`CLUSTERING_CORPUS_UNKNOWN_LABEL:${run.runId}:${groundTruthId}`);
      kinds.set(unitKey(run.runId, groundTruthId), kind);
    }
  }
  return Object.freeze({ corpus, corpusSha256: sha256(corpusText), kinds });
}

export function findingText(finding: ClusterableFinding): string { return `${finding.title}\n${finding.problem}\n${finding.recommendedFix}`; }
export function cosine(left: Float32Array, right: Float32Array): number { if (left.length !== right.length) throw new Error("EMBEDDING_DIMENSION_MISMATCH"); let dot = 0; let a = 0; let b = 0; for (let index = 0; index < left.length; index += 1) { const x = left[index] ?? 0; const y = right[index] ?? 0; dot += x * y; a += x * x; b += y * y; } return a === 0 || b === 0 ? 0 : dot / Math.sqrt(a * b); }

/** Embeds every finding once; refuses malformed embedder output rather than clustering on it. */
export async function embedFindings(embedder: TextEmbedder, inputs: readonly ValidatedClusterInput[]): Promise<ReadonlyMap<string, Float32Array>> {
  const vectors = await embedder.embed(inputs.map(({ finding }) => findingText(finding)));
  if (vectors.length !== inputs.length || vectors.some((vector) => vector.length !== embedder.identity.dimensions || vector.some((value) => !Number.isFinite(value)))) throw new Error("EMBEDDER_OUTPUT_INVALID");
  return new Map(inputs.map(({ finding }, index) => [finding.sourceFindingId, vectors[index] as Float32Array]));
}

/** `E1`: resolves escalated ambiguous pairs locally by cosine threshold, through the existing escalation seam. Zero tokens, zero cost. */
export function embeddingPairResolver(vectors: ReadonlyMap<string, Float32Array>, threshold: number): SemanticClusteringRuntime {
  if (!(threshold >= -1 && threshold <= 1)) throw new Error("INVALID_EMBEDDING_THRESHOLD");
  return Object.freeze({ capability: "fast" as const, async classify({ left, right }: { readonly left: ValidatedClusterInput; readonly right: ValidatedClusterInput }) { return Object.freeze({ relationship: similarity(vectors, left.finding.sourceFindingId, right.finding.sourceFindingId) >= threshold ? "same_root_cause" as const : "unrelated" as const, inputTokens: 0, outputTokens: 0, cost: 0 }); } });
}

/** `E2`: single-linkage over every pair with cosine ≥ threshold, ignoring structure. Descriptive only. */
export function embeddingThresholdStrategy(vectors: ReadonlyMap<string, Float32Array>, threshold: number): ClusteringStrategy {
  return Object.freeze({ id: `embedding-threshold-${threshold}`, cluster(inputs: readonly ValidatedClusterInput[]): StrategyResult {
    const findings = [...inputs].sort((a, b) => a.finding.sourceFindingId.localeCompare(b.finding.sourceFindingId)); const ids = findings.map(({ finding }) => finding.sourceFindingId);
    const parent = new Map(ids.map((id) => [id, id])); const operations: { readonly type: "merge"; readonly sourceFindingIds: readonly string[]; readonly reason: "semantic" }[] = [];
    for (let left = 0; left < ids.length; left += 1) for (let right = left + 1; right < ids.length; right += 1) { const a = ids[left] as string; const b = ids[right] as string; if (similarity(vectors, a, b) >= threshold) { link(parent, a, b); operations.push(Object.freeze({ type: "merge", sourceFindingIds: Object.freeze([a, b]), reason: "semantic" })); } }
    return Object.freeze({ findings: Object.freeze(findings), clusters: clustersFrom(parent), ambiguousPairs: Object.freeze([]), operations: Object.freeze(operations), deterministicPairsResolved: 0 });
  } });
}

export interface ClusterScore { readonly findings: number; readonly samePairs: number; readonly differentPairs: number; readonly falseMerges: number; readonly falseSplits: number; readonly weightedErrors: number; readonly defectLossMerges: number; readonly pairPrecision: number | null; readonly pairRecall: number | null; readonly candidates: number; readonly contaminatedCandidates: number; readonly redundantCandidates: number }
interface RunScore { readonly score: ClusterScore; readonly units: ReadonlyMap<string, number> }

/** Pairwise scoring of one run. Units are ground-truth clusters: each carries its false splits plus half of every weighted false merge it takes part in. */
export function scoreClusters(run: ClusteringCorpusRun, clusters: readonly FindingCluster[], kinds: ReadonlyMap<string, GroundTruthKind>, falseMergeWeight = P18_SETTINGS.falseMergeWeight): RunScore {
  const label = new Map(run.findings.map(({ groundTruthId, finding }) => [finding.sourceFindingId, groundTruthId])); const predicted = new Map<string, string>();
  for (const { clusterId, sourceFindingIds } of clusters) for (const id of sourceFindingIds) { if (!label.has(id) || predicted.has(id)) throw new Error(`CLUSTERING_SCORE_MEMBERSHIP_INVALID:${run.runId}:${id}`); predicted.set(id, clusterId); }
  if (predicted.size !== label.size) throw new Error(`CLUSTERING_SCORE_MEMBERSHIP_INCOMPLETE:${run.runId}`);
  const units = new Map<string, number>([...new Set(label.values())].map((value) => [unitKey(run.runId, value), 0])); const ids = [...label.keys()].sort();
  let samePairs = 0; let differentPairs = 0; let falseMerges = 0; let falseSplits = 0; let defectLossMerges = 0; let truePairs = 0;
  for (let left = 0; left < ids.length; left += 1) for (let right = left + 1; right < ids.length; right += 1) {
    const a = ids[left] as string; const b = ids[right] as string; const la = label.get(a) as string; const lb = label.get(b) as string; const together = predicted.get(a) === predicted.get(b);
    if (la === lb) { samePairs += 1; if (together) truePairs += 1; else { falseSplits += 1; bump(units, unitKey(run.runId, la), 1); } }
    else { differentPairs += 1; if (together) { falseMerges += 1; bump(units, unitKey(run.runId, la), falseMergeWeight / 2); bump(units, unitKey(run.runId, lb), falseMergeWeight / 2); if (kinds.get(unitKey(run.runId, la)) === "defect" && kinds.get(unitKey(run.runId, lb)) === "defect") defectLossMerges += 1; } }
  }
  const labelsPerCandidate = clusters.map(({ sourceFindingIds }) => new Set(sourceFindingIds.map((id) => label.get(id))));
  const candidatesPerLabel = new Map<string, number>(); for (const labels of labelsPerCandidate) for (const value of labels) if (value !== undefined) candidatesPerLabel.set(value, (candidatesPerLabel.get(value) ?? 0) + 1);
  const predictedPairs = truePairs + falseMerges;
  return Object.freeze({ score: Object.freeze({ findings: ids.length, samePairs, differentPairs, falseMerges, falseSplits, weightedErrors: falseMergeWeight * falseMerges + falseSplits, defectLossMerges, pairPrecision: predictedPairs === 0 ? null : round(truePairs / predictedPairs), pairRecall: samePairs === 0 ? null : round(truePairs / samePairs), candidates: clusters.length, contaminatedCandidates: labelsPerCandidate.filter((labels) => labels.size > 1).length, redundantCandidates: [...candidatesPerLabel.values()].reduce((sum, count) => sum + count - 1, 0) }), units });
}

export interface BootstrapInterval { readonly difference: number; readonly lower: number; readonly upper: number; readonly units: number; readonly resamples: number; readonly seed: number }
/** Paired percentile bootstrap of `candidate − baseline` over shared units (ground-truth clusters). */
export function pairedBootstrap(baseline: ReadonlyMap<string, number>, candidate: ReadonlyMap<string, number>, resamples: number = P18_SETTINGS.bootstrapResamples, seed: number = P18_SETTINGS.bootstrapSeed): BootstrapInterval {
  const keys = [...baseline.keys()].sort(); if (keys.length === 0 || keys.length !== candidate.size || keys.some((key) => !candidate.has(key))) throw new Error("BOOTSTRAP_UNITS_MISMATCH");
  if (!Number.isSafeInteger(resamples) || resamples < 100) throw new Error("INVALID_BOOTSTRAP_RESAMPLES");
  const deltas = keys.map((key) => (candidate.get(key) ?? 0) - (baseline.get(key) ?? 0)); const random = mulberry32(seed); const totals: number[] = [];
  for (let sample = 0; sample < resamples; sample += 1) { let total = 0; for (let draw = 0; draw < deltas.length; draw += 1) total += deltas[Math.floor(random() * deltas.length)] ?? 0; totals.push(total); }
  totals.sort((a, b) => a - b);
  return Object.freeze({ difference: round(deltas.reduce((sum, value) => sum + value, 0)), lower: round(totals[Math.floor(0.025 * (resamples - 1))] ?? 0), upper: round(totals[Math.ceil(0.975 * (resamples - 1))] ?? 0), units: keys.length, resamples, seed });
}

export interface AmbiguousPairDetail { readonly runId: string; readonly leftId: string; readonly rightId: string; readonly signals: readonly string[]; readonly structuralScore: number; readonly cosine: number; readonly sameLabel: boolean; readonly escalated: boolean; readonly e1Merged: boolean }
export interface LatencySummary { readonly samples: number; readonly medianMs: number; readonly p95Ms: number; readonly maxMs: number }
export interface ConfigurationResult { readonly score: ClusterScore; readonly perRun: readonly { readonly runId: string; readonly fixtureId: string; readonly score: ClusterScore }[]; readonly versusDeterministic: BootstrapInterval }
export interface EmbeddingClusteringReport {
  readonly schemaVersion: 1; readonly protocolVersion: string; readonly corpus: { readonly corpusId: string; readonly version: number; readonly mode: ClusteringCorpus["mode"]; readonly sha256: string; readonly fixtures: readonly ClusteringCorpusFixture[] };
  readonly embedder: TextEmbedderIdentity; readonly settings: { readonly textTemplate: string; readonly thresholdGrid: readonly number[]; readonly maximumEscalatedPairs: number; readonly bootstrapResamples: number; readonly bootstrapSeed: number; readonly repeats: number; readonly falseMergeWeight: number };
  readonly evidence: { readonly fixtures: number; readonly runs: number; readonly findings: number; readonly groundTruthClusters: number; readonly multiMemberClusters: number; readonly samePairs: number; readonly differentPairs: number; readonly ambiguousPairs: number; readonly escalatedPairs: number };
  readonly thresholds: { readonly e1: Readonly<Record<string, number>>; readonly e2: Readonly<Record<string, number>> };
  /** Descriptive, in-sample: pooled weighted errors at every grid threshold. Never used for selection or the decision. */
  readonly thresholdSweep: readonly { readonly threshold: number; readonly e1WeightedErrors: number; readonly e2WeightedErrors: number }[];
  readonly configurations: { readonly deterministic: ConfigurationResult; readonly embeddingEscalation: ConfigurationResult; readonly embeddingOnly: ConfigurationResult; readonly oracleEscalation: ConfigurationResult };
  readonly latency: { readonly deterministic: LatencySummary; readonly embeddingEscalation: LatencySummary; readonly maximumRunFindings: number };
  readonly reproducible: boolean; readonly semanticCalls: { readonly e1: number; readonly oracle: number }; readonly ambiguousPairs: readonly AmbiguousPairDetail[];
}
export interface EvaluationOptions { readonly embedder: TextEmbedder; readonly clock: () => number; readonly repeats?: number; readonly bootstrapResamples?: number }

export async function evaluateEmbeddingClustering(loaded: LoadedClusteringCorpus, options: EvaluationOptions): Promise<EmbeddingClusteringReport> {
  const { corpus, kinds } = loaded; const repeats = options.repeats ?? P18_SETTINGS.repeats; const resamples = options.bootstrapResamples ?? P18_SETTINGS.bootstrapResamples; const maximum = P18_SETTINGS.maximumEscalatedPairs;
  if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error("INVALID_EVALUATION_REPEATS");
  const fixtures = [...new Set(corpus.runs.map(({ fixtureId }) => fixtureId))].sort(); if (fixtures.length < 2) throw new Error("CLUSTERING_EVALUATION_REQUIRES_TWO_FIXTURES");
  const runs = corpus.runs.map((run) => ({ run, inputs: run.findings.map(({ auditorId, finding }): ValidatedClusterInput => ({ validation: "accepted", auditorId, finding })) }));
  const vectors = new Map<string, ReadonlyMap<string, Float32Array>>(); for (const { run, inputs } of runs) vectors.set(run.runId, await embedFindings(options.embedder, inputs));
  const vectorsOf = (runId: string) => { const value = vectors.get(runId); if (value === undefined) throw new Error(`EMBEDDING_RUN_MISSING:${runId}`); return value; };
  const deterministic = new Map<string, ClusteringResult>(); for (const { run, inputs } of runs) deterministic.set(run.runId, await cluster(inputs, { maximumEscalatedPairs: 0 }));
  const deterministicOf = (runId: string) => { const value = deterministic.get(runId); if (value === undefined) throw new Error(`DETERMINISTIC_RUN_MISSING:${runId}`); return value; };
  const e1 = (runId: string, inputs: readonly ValidatedClusterInput[], threshold: number) => cluster(inputs, { semantic: embeddingPairResolver(vectorsOf(runId), threshold), maximumEscalatedPairs: maximum });
  const e2 = (runId: string, inputs: readonly ValidatedClusterInput[], threshold: number) => cluster(inputs, { strategy: embeddingThresholdStrategy(vectorsOf(runId), threshold) });
  const sweep = async (method: typeof e1): Promise<ReadonlyMap<number, ReadonlyMap<string, number>>> => { const table = new Map<number, Map<string, number>>(); for (const threshold of P18_THRESHOLD_GRID) { const perRun = new Map<string, number>(); for (const { run, inputs } of runs) perRun.set(run.runId, scoreClusters(run, (await method(run.runId, inputs, threshold)).clusters, kinds).score.weightedErrors); table.set(threshold, perRun); } return table; };
  const calibrate = (table: ReadonlyMap<number, ReadonlyMap<string, number>>): Record<string, number> => {
    const selected: Record<string, number> = {};
    for (const fixture of fixtures) {
      let best: { threshold: number; errors: number } | null = null;
      for (const [threshold, perRun] of table) { const errors = runs.filter(({ run }) => run.fixtureId !== fixture).reduce((sum, { run }) => sum + (perRun.get(run.runId) ?? 0), 0); if (best === null || errors <= best.errors) best = { threshold, errors }; }
      if (best === null) throw new Error("EMPTY_THRESHOLD_GRID"); selected[fixture] = best.threshold;
    }
    return Object.freeze(selected);
  };
  const sweeps = { e1: await sweep(e1), e2: await sweep(e2) }; const thresholds = { e1: calibrate(sweeps.e1), e2: calibrate(sweeps.e2) };
  const pooled = (table: ReadonlyMap<string, number> | undefined) => [...(table?.values() ?? [])].reduce((sum, value) => sum + value, 0);
  const thresholdSweep = Object.freeze(P18_THRESHOLD_GRID.map((threshold) => Object.freeze({ threshold, e1WeightedErrors: pooled(sweeps.e1.get(threshold)), e2WeightedErrors: pooled(sweeps.e2.get(threshold)) }))); const thresholdOf = (table: Record<string, number>, fixtureId: string) => { const value = table[fixtureId]; if (value === undefined) throw new Error(`THRESHOLD_MISSING:${fixtureId}`); return value; };
  const oracle = (run: ClusteringCorpusRun): SemanticClusteringRuntime => { const label = new Map(run.findings.map(({ groundTruthId, finding }) => [finding.sourceFindingId, groundTruthId])); return { capability: "fast", async classify({ left, right }) { return { relationship: label.get(left.finding.sourceFindingId) === label.get(right.finding.sourceFindingId) ? "same_root_cause" : "unrelated", inputTokens: null, outputTokens: null, cost: null }; } }; };
  const results = { deterministic: new Map<string, ClusteringResult>(), embeddingEscalation: new Map<string, ClusteringResult>(), embeddingOnly: new Map<string, ClusteringResult>(), oracleEscalation: new Map<string, ClusteringResult>() };
  for (const { run, inputs } of runs) {
    results.deterministic.set(run.runId, deterministicOf(run.runId)); results.embeddingEscalation.set(run.runId, await e1(run.runId, inputs, thresholdOf(thresholds.e1, run.fixtureId)));
    results.embeddingOnly.set(run.runId, await e2(run.runId, inputs, thresholdOf(thresholds.e2, run.fixtureId))); results.oracleEscalation.set(run.runId, await cluster(inputs, { semantic: oracle(run), maximumEscalatedPairs: maximum }));
  }
  const deterministicLatency: number[] = []; const embeddingLatency: number[] = []; let reproducible = true;
  for (let repeat = 0; repeat < repeats; repeat += 1) for (const { run, inputs } of runs) {
    let start = options.clock(); await cluster(inputs, { maximumEscalatedPairs: 0 }); deterministicLatency.push(options.clock() - start);
    start = options.clock(); const fresh = await embedFindings(options.embedder, inputs); const repeated = await cluster(inputs, { semantic: embeddingPairResolver(fresh, thresholdOf(thresholds.e1, run.fixtureId)), maximumEscalatedPairs: maximum }); embeddingLatency.push(options.clock() - start);
    if (JSON.stringify(repeated.clusters) !== JSON.stringify(results.embeddingEscalation.get(run.runId)?.clusters)) reproducible = false;
  }
  const configuration = (map: ReadonlyMap<string, ClusteringResult>): { score: ClusterScore; perRun: { runId: string; fixtureId: string; score: ClusterScore }[]; units: Map<string, number> } => {
    const perRun = runs.map(({ run }) => { const result = map.get(run.runId); if (result === undefined) throw new Error(`CONFIGURATION_RUN_MISSING:${run.runId}`); return { run, scored: scoreClusters(run, result.clusters, kinds) }; });
    const units = new Map<string, number>(); for (const { scored } of perRun) for (const [key, value] of scored.units) units.set(key, value);
    return { score: sumScores(perRun.map(({ scored }) => scored.score)), perRun: perRun.map(({ run, scored }) => Object.freeze({ runId: run.runId, fixtureId: run.fixtureId, score: scored.score })), units };
  };
  const base = configuration(results.deterministic); const finish = (value: ReturnType<typeof configuration>): ConfigurationResult => Object.freeze({ score: value.score, perRun: Object.freeze(value.perRun), versusDeterministic: pairedBootstrap(base.units, value.units, resamples) });
  const ambiguousPairs: AmbiguousPairDetail[] = []; let e1Calls = 0; let oracleCalls = 0;
  for (const { run } of runs) {
    const label = new Map(run.findings.map(({ groundTruthId, finding }) => [finding.sourceFindingId, groundTruthId])); const embedded = results.embeddingEscalation.get(run.runId);
    e1Calls += embedded?.metrics.semanticClusteringCalls ?? 0; oracleCalls += results.oracleEscalation.get(run.runId)?.metrics.semanticClusteringCalls ?? 0;
    for (const [index, pair] of deterministicOf(run.runId).ambiguousPairs.entries()) ambiguousPairs.push(Object.freeze({ runId: run.runId, leftId: pair.leftId, rightId: pair.rightId, signals: pair.signals, structuralScore: pair.score, cosine: round(similarity(vectorsOf(run.runId), pair.leftId, pair.rightId)), sameLabel: label.get(pair.leftId) === label.get(pair.rightId), escalated: index < maximum, e1Merged: embedded?.ambiguousPairs.find(({ leftId, rightId }) => leftId === pair.leftId && rightId === pair.rightId)?.relationship === "same_root_cause" }));
  }
  const labelCounts = runs.flatMap(({ run }) => { const counts = new Map<string, number>(); for (const { groundTruthId } of run.findings) counts.set(groundTruthId, (counts.get(groundTruthId) ?? 0) + 1); return [...counts.values()]; });
  return Object.freeze({
    schemaVersion: 1, protocolVersion: P18_PROTOCOL_VERSION, corpus: Object.freeze({ corpusId: corpus.corpusId, version: corpus.version, mode: corpus.mode, sha256: loaded.corpusSha256, fixtures: corpus.sourceFixtures }),
    embedder: options.embedder.identity, settings: Object.freeze({ textTemplate: FINDING_TEXT_TEMPLATE, thresholdGrid: P18_THRESHOLD_GRID, maximumEscalatedPairs: maximum, bootstrapResamples: resamples, bootstrapSeed: P18_SETTINGS.bootstrapSeed, repeats, falseMergeWeight: P18_SETTINGS.falseMergeWeight }),
    evidence: Object.freeze({ fixtures: fixtures.length, runs: runs.length, findings: base.score.findings, groundTruthClusters: labelCounts.length, multiMemberClusters: labelCounts.filter((count) => count > 1).length, samePairs: base.score.samePairs, differentPairs: base.score.differentPairs, ambiguousPairs: ambiguousPairs.length, escalatedPairs: ambiguousPairs.filter(({ escalated }) => escalated).length }),
    thresholds: Object.freeze(thresholds), thresholdSweep,
    configurations: Object.freeze({ deterministic: finish(base), embeddingEscalation: finish(configuration(results.embeddingEscalation)), embeddingOnly: finish(configuration(results.embeddingOnly)), oracleEscalation: finish(configuration(results.oracleEscalation)) }),
    latency: Object.freeze({ deterministic: summarize(deterministicLatency), embeddingEscalation: summarize(embeddingLatency), maximumRunFindings: Math.max(...runs.map(({ inputs }) => inputs.length)) }),
    reproducible, semanticCalls: Object.freeze({ e1: e1Calls, oracle: oracleCalls }), ambiguousPairs: Object.freeze(ambiguousPairs),
  });
}

export interface EmbedderResources { readonly coldLoadMs: number; readonly modelBytes: number; readonly rssGrowthBytes: number; readonly dependencyBytes: number; readonly networkRequests: number; readonly marginalCostUsd: number }
export type AdoptionOutcome = "ADOPT" | "REJECT" | "INSUFFICIENT_EVIDENCE";
export interface AdoptionCriterion { readonly id: string; readonly passed: boolean; readonly detail: string }
export interface AdoptionDecision { readonly outcome: AdoptionOutcome; readonly criteria: readonly AdoptionCriterion[]; readonly reasons: readonly string[] }

/** Applies the prespecified P18 decision rules; see PROTOCOL.md "Decision rules". */
export function decideAdoption(report: EmbeddingClusteringReport, resources: EmbedderResources): AdoptionDecision {
  const c = P18_CRITERIA; const d = report.configurations.deterministic.score; const e = report.configurations.embeddingEscalation; const interval = e.versusDeterministic; const evidence = report.evidence;
  const relative = d.weightedErrors === 0 ? 0 : (d.weightedErrors - e.score.weightedErrors) / d.weightedErrors; const redundantRemoved = Math.max(0, d.redundantCandidates - e.score.redundantCandidates);
  const criteria: AdoptionCriterion[] = [
    { id: "1-evidence", passed: report.corpus.mode === "real_models" && evidence.fixtures >= c.minimumFixtures && evidence.multiMemberClusters >= c.minimumMultiMemberClusters && evidence.samePairs >= c.minimumSamePairs && evidence.ambiguousPairs >= c.minimumAmbiguousPairs, detail: `mode=${report.corpus.mode} fixtures=${evidence.fixtures}/${c.minimumFixtures} multiMemberClusters=${evidence.multiMemberClusters}/${c.minimumMultiMemberClusters} samePairs=${evidence.samePairs}/${c.minimumSamePairs} ambiguousPairs=${evidence.ambiguousPairs}/${c.minimumAmbiguousPairs}` },
    { id: "2-benefit", passed: relative >= c.minimumRelativeReduction && interval.upper < 0, detail: `W(D)=${d.weightedErrors} W(E1)=${e.score.weightedErrors} reduction=${round(relative)} diff=${interval.difference} 95%CI=[${interval.lower}, ${interval.upper}]` },
    { id: "3-no-defect-loss", passed: e.score.defectLossMerges <= d.defectLossMerges, detail: `defectLossMerges D=${d.defectLossMerges} E1=${e.score.defectLossMerges}` },
    { id: "4-downstream", passed: e.score.contaminatedCandidates <= d.contaminatedCandidates + redundantRemoved, detail: `contaminated D=${d.contaminatedCandidates} E1=${e.score.contaminatedCandidates} redundantRemoved=${redundantRemoved}` },
    { id: "5-latency", passed: report.latency.maximumRunFindings <= c.maximumWarmRunFindings && report.latency.embeddingEscalation.p95Ms <= c.maximumWarmP95Ms && resources.coldLoadMs <= c.maximumColdLoadMs, detail: `warmP95=${report.latency.embeddingEscalation.p95Ms}ms/${c.maximumWarmP95Ms} maxRunFindings=${report.latency.maximumRunFindings}/${c.maximumWarmRunFindings} coldLoad=${Math.round(resources.coldLoadMs)}ms/${c.maximumColdLoadMs}` },
    { id: "6-resources", passed: resources.modelBytes <= c.maximumModelBytes && resources.rssGrowthBytes <= c.maximumRssGrowthBytes && resources.dependencyBytes <= c.maximumDependencyBytes, detail: `model=${resources.modelBytes}/${c.maximumModelBytes} rssGrowth=${resources.rssGrowthBytes}/${c.maximumRssGrowthBytes} dependencies=${resources.dependencyBytes}/${c.maximumDependencyBytes}` },
    { id: "7-cost-locality", passed: resources.networkRequests === 0 && resources.marginalCostUsd === 0, detail: `networkRequests=${resources.networkRequests} marginalCostUsd=${resources.marginalCostUsd}` },
    { id: "8-reproducible", passed: report.reproducible, detail: `repeats=${report.settings.repeats} identicalAssignments=${report.reproducible}` },
  ];
  const failed = (id: string) => criteria.find((criterion) => criterion.id === id)?.passed === false; const reasons: string[] = [];
  for (const id of ["5-latency", "6-resources", "7-cost-locality", "8-reproducible"]) if (failed(id)) reasons.push(`criterion ${id} failed`);
  if (e.score.weightedErrors >= d.weightedErrors) reasons.push("no weighted-error reduction over deterministic clustering");
  if (failed("3-no-defect-loss")) reasons.push("embedding escalation merged distinct ground-truth defects");
  if (!failed("1-evidence") && (failed("2-benefit") || failed("4-downstream"))) reasons.push("sufficient evidence without the required benefit");
  if (reasons.length > 0) return Object.freeze({ outcome: "REJECT", criteria: Object.freeze(criteria), reasons: Object.freeze(reasons) });
  if (failed("1-evidence") || failed("2-benefit")) return Object.freeze({ outcome: "INSUFFICIENT_EVIDENCE", criteria: Object.freeze(criteria), reasons: Object.freeze([failed("1-evidence") ? "evidence sufficiency minimums not met" : "benefit interval includes zero or reduction below threshold"]) });
  return Object.freeze({ outcome: "ADOPT", criteria: Object.freeze(criteria), reasons: Object.freeze([]) });
}

function similarity(vectors: ReadonlyMap<string, Float32Array>, left: string, right: string): number { const a = vectors.get(left); const b = vectors.get(right); if (a === undefined || b === undefined) throw new Error(`EMBEDDING_VECTOR_MISSING:${a === undefined ? left : right}`); return cosine(a, b); }
function link(parent: Map<string, string>, left: string, right: string): void { const a = root(parent, left); const b = root(parent, right); if (a !== b) parent.set(a < b ? b : a, a < b ? a : b); }
function root(parent: Map<string, string>, id: string): string { const value = parent.get(id); if (value === undefined) throw new Error(`UNKNOWN_CLUSTER_FINDING:${id}`); return value === id ? id : root(parent, value); }
function unitKey(runId: string, label: string): string { return `${runId}/${label}`; }
function bump(units: Map<string, number>, key: string, value: number): void { units.set(key, (units.get(key) ?? 0) + value); }
function sumScores(scores: readonly ClusterScore[]): ClusterScore {
  const total = (field: keyof ClusterScore) => scores.reduce((sum, score) => sum + (score[field] ?? 0), 0); const samePairs = total("samePairs"); const falseMerges = total("falseMerges"); const falseSplits = total("falseSplits"); const truePairs = samePairs - falseSplits;
  return Object.freeze({ findings: total("findings"), samePairs, differentPairs: total("differentPairs"), falseMerges, falseSplits, weightedErrors: total("weightedErrors"), defectLossMerges: total("defectLossMerges"), pairPrecision: truePairs + falseMerges === 0 ? null : round(truePairs / (truePairs + falseMerges)), pairRecall: samePairs === 0 ? null : round(truePairs / samePairs), candidates: total("candidates"), contaminatedCandidates: total("contaminatedCandidates"), redundantCandidates: total("redundantCandidates") });
}
function summarize(values: readonly number[]): LatencySummary { const sorted = [...values].sort((a, b) => a - b); const at = (q: number) => round(sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0); return Object.freeze({ samples: sorted.length, medianMs: at(0.5), p95Ms: at(0.95), maxMs: round(sorted[sorted.length - 1] ?? 0) }); }
function mulberry32(seed: number): () => number { let state = seed >>> 0; return () => { state = (state + 0x6d2b79f5) >>> 0; let value = state; value = Math.imul(value ^ (value >>> 15), value | 1); value ^= value + Math.imul(value ^ (value >>> 7), value | 61); return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296; }; }
function round(value: number): number { return Math.round(value * 10_000) / 10_000; }
function sha256(text: string): string { return createHash("sha256").update(text).digest("hex"); }
