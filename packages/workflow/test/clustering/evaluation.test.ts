import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cluster } from "../../src/clustering/index.js";
import { decideAdoption, embedFindings, embeddingPairResolver, evaluateEmbeddingClustering, loadClusteringCorpus, pairedBootstrap, scoreClusters, type ClusteringCorpus, type EmbedderResources, type EmbeddingClusteringReport, type TextEmbedder } from "../../src/clustering/evaluation.js";

const corpora = new URL("../../../testing/corpora/clustering/", import.meta.url);
const corpusText = readFileSync(new URL("authored-v1.json", corpora), "utf8");
const groundTruth = new Map((JSON.parse(corpusText) as ClusteringCorpus).sourceFixtures.map(({ groundTruth: path }) => [path, readFileSync(new URL(path, corpora), "utf8")]));

/** Deterministic hashed bag-of-words stand-in. Test-only: it has no semantics and is never a candidate. */
function standInEmbedder(dimensions = 64): TextEmbedder & { calls: number } {
  const state = { calls: 0 };
  return { identity: { model: "test/hashed-bag-of-words", revision: "test", artifact: "none", artifactSha256: "none", runtime: "vitest", dtype: "fp32", pooling: "mean", normalized: true, dimensions }, get calls() { return state.calls; }, async embed(texts) {
    state.calls += 1;
    return texts.map((text) => { const vector = new Float32Array(dimensions); for (const word of text.toLocaleLowerCase("en-US").match(/[a-z0-9]+/gu) ?? []) { let hash = 2_166_136_261; for (const char of word) hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 16_777_619) >>> 0; vector[hash % dimensions] = (vector[hash % dimensions] ?? 0) + 1; } const norm = Math.hypot(...vector); return norm === 0 ? vector : vector.map((value) => value / norm); });
  } };
}
const clock = (() => { let now = 0; return () => (now += 1); })();

describe("P18 clustering corpus", () => {
  it("loads the authored corpus with pinned fixture ground truth and labelled findings", () => {
    const loaded = loadClusteringCorpus(corpusText, groundTruth);
    expect(loaded.corpus).toMatchObject({ corpusId: "clustering-authored-v1", version: 1, mode: "authored" });
    expect(loaded.corpus.runs.map(({ findings }) => findings.length)).toEqual([21, 17, 12, 8]);
    expect(loaded.corpusSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(loaded.kinds.get("premise-authored-1/DEF-RACE")).toBe("defect"); expect(loaded.kinds.get("premise-authored-1/DECOY-TIMING-SAFE")).toBe("decoy"); expect(loaded.kinds.get("premise-authored-1/NOISE:SELECT-STAR")).toBe("noise");
  });

  it("refuses altered ground truth, unknown labels and duplicate findings", () => {
    const [path, text] = [...groundTruth][0] ?? ["", ""];
    expect(() => loadClusteringCorpus(corpusText, new Map([...groundTruth, [path, `${text} `]]))).toThrow("CLUSTERING_CORPUS_GROUND_TRUTH_HASH_MISMATCH:premise-v1");
    expect(() => loadClusteringCorpus(corpusText.replace("\"DEF-RACE\"", "\"DEF-UNKNOWN\""), groundTruth)).toThrow("CLUSTERING_CORPUS_UNKNOWN_LABEL:premise-authored-1:DEF-UNKNOWN");
    expect(() => loadClusteringCorpus(corpusText.replace("auditor-b/F-1", "auditor-a/F-1"), groundTruth)).toThrow("CLUSTERING_CORPUS_DUPLICATE_FINDING:premise-authored-1:auditor-a/F-1");
    expect(() => loadClusteringCorpus("{", groundTruth)).toThrow("CLUSTERING_CORPUS_INVALID_JSON");
  });
});

describe("P18 scoring", () => {
  const run = { runId: "r", fixtureId: "f", findings: [["a", "DEF-1"], ["b", "DEF-1"], ["c", "DEF-2"], ["d", "DECOY-1"]].map(([id, groundTruthId]) => ({ groundTruthId: groundTruthId as string, auditorId: "x", finding: { sourceFindingId: id as string, category: "c", title: "t", problem: "p", recommendedFix: "r", locations: [{ path: "p", startLine: 1, endLine: 1 }] } })) };
  const kinds = new Map([["r/DEF-1", "defect"], ["r/DEF-2", "defect"], ["r/DECOY-1", "decoy"]] as const);

  it("counts false merges, false splits, defect loss and downstream candidate quality", () => {
    const { score, units } = scoreClusters(run, [{ clusterId: "1", sourceFindingIds: ["a", "c"] }, { clusterId: "2", sourceFindingIds: ["b"] }, { clusterId: "3", sourceFindingIds: ["d"] }], kinds);
    expect(score).toMatchObject({ samePairs: 1, differentPairs: 5, falseMerges: 1, falseSplits: 1, weightedErrors: 3, defectLossMerges: 1, pairPrecision: 0, pairRecall: 0, candidates: 3, contaminatedCandidates: 1, redundantCandidates: 1 });
    expect([...units.values()].reduce((sum, value) => sum + value, 0)).toBe(score.weightedErrors);
    expect(() => scoreClusters(run, [{ clusterId: "1", sourceFindingIds: ["a", "b", "c"] }], kinds)).toThrow("CLUSTERING_SCORE_MEMBERSHIP_INCOMPLETE:r");
  });

  it("bootstraps paired differences reproducibly from a fixed seed", () => {
    const baseline = new Map([["u1", 2], ["u2", 1], ["u3", 0]]); const candidate = new Map([["u1", 0], ["u2", 1], ["u3", 0]]);
    const first = pairedBootstrap(baseline, candidate, 1000, 18);
    expect(first).toEqual(pairedBootstrap(baseline, candidate, 1000, 18)); expect(first.difference).toBe(-2); expect(first.lower).toBeLessThanOrEqual(first.upper);
    expect(pairedBootstrap(baseline, baseline, 1000, 18)).toMatchObject({ difference: 0, lower: 0, upper: 0 });
    expect(() => pairedBootstrap(baseline, new Map([["u1", 0]]), 1000, 18)).toThrow("BOOTSTRAP_UNITS_MISMATCH");
  });
});

describe("P18 embedding harness", () => {
  it("refuses malformed embedder output instead of clustering on it", async () => {
    const inputs = loadClusteringCorpus(corpusText, groundTruth).corpus.runs[0]?.findings.map(({ auditorId, finding }) => ({ validation: "accepted" as const, auditorId, finding })) ?? [];
    const broken: TextEmbedder = { identity: standInEmbedder().identity, async embed(texts) { return texts.map(() => new Float32Array(64).fill(Number.NaN)); } };
    await expect(embedFindings(broken, inputs)).rejects.toThrow("EMBEDDER_OUTPUT_INVALID");
    const short: TextEmbedder = { identity: standInEmbedder().identity, async embed() { return []; } };
    await expect(embedFindings(short, inputs)).rejects.toThrow("EMBEDDER_OUTPUT_INVALID");
  });

  it("resolves only escalated ambiguous pairs, never overriding structural merges, at zero cost", async () => {
    const inputs = loadClusteringCorpus(corpusText, groundTruth).corpus.runs[0]?.findings.map(({ auditorId, finding }) => ({ validation: "accepted" as const, auditorId, finding })) ?? [];
    const vectors = await embedFindings(standInEmbedder(), inputs); const structural = await cluster(inputs);
    const mergeAll = await cluster(inputs, { semantic: embeddingPairResolver(vectors, -1), maximumEscalatedPairs: 20 }); const mergeNone = await cluster(inputs, { semantic: embeddingPairResolver(vectors, 1), maximumEscalatedPairs: 0 });
    expect(mergeNone.clusters).toEqual(structural.clusters); expect(mergeAll.clusters.length).toBeLessThanOrEqual(structural.clusters.length);
    expect(mergeAll.metrics).toMatchObject({ escalatedPairs: Math.min(20, structural.ambiguousPairs.length), semanticClusteringTokens: 0, semanticClusteringCost: 0 });
    expect(() => embeddingPairResolver(vectors, 2)).toThrow("INVALID_EMBEDDING_THRESHOLD");
  });

  it("evaluates all configurations reproducibly with identities, leave-one-fixture-out thresholds and a non-adopting decision on an authored corpus", async () => {
    const embedder = standInEmbedder(); const loaded = loadClusteringCorpus(corpusText, groundTruth);
    const report = await evaluateEmbeddingClustering(loaded, { embedder, clock, repeats: 2, bootstrapResamples: 500 });
    expect(report).toMatchObject({ protocolVersion: "p18-protocol-v1", corpus: { corpusId: "clustering-authored-v1", sha256: loaded.corpusSha256 }, embedder: { model: "test/hashed-bag-of-words" }, settings: { textTemplate: "finding-text-v1", maximumEscalatedPairs: 20, bootstrapSeed: 18, repeats: 2 }, reproducible: true });
    expect(report.evidence).toMatchObject({ fixtures: 2, runs: 4, findings: 58, multiMemberClusters: 15, samePairs: 47 });
    expect(Object.keys(report.thresholds.e1).sort()).toEqual(["expanded-evaluation-v1", "premise-v1"]);
    const { deterministic, embeddingEscalation, oracleEscalation } = report.configurations;
    expect(embeddingEscalation.score.falseSplits).toBeLessThanOrEqual(deterministic.score.falseSplits); expect(embeddingEscalation.score.falseMerges).toBeGreaterThanOrEqual(deterministic.score.falseMerges);
    expect(oracleEscalation.score.weightedErrors).toBeLessThanOrEqual(deterministic.score.weightedErrors); expect(deterministic.versusDeterministic).toMatchObject({ difference: 0, lower: 0, upper: 0 });
    expect(report.ambiguousPairs).toHaveLength(report.evidence.ambiguousPairs); expect(embedder.calls).toBe(4 + 4 * 2);
    expect(decideAdoption(report, resources()).outcome).not.toBe("ADOPT");
  });
});

describe("P18 decision rules", () => {
  it("adopts only a sufficient real-model corpus meeting every criterion and rejects on any ceiling failure", () => {
    const passing = syntheticReport();
    expect(decideAdoption(passing, resources())).toMatchObject({ outcome: "ADOPT", reasons: [] });
    expect(decideAdoption(passing, resources({ modelBytes: 200_000_000 })).outcome).toBe("REJECT");
    expect(decideAdoption(passing, resources({ networkRequests: 1 })).outcome).toBe("REJECT");
    expect(decideAdoption({ ...passing, reproducible: false }, resources()).outcome).toBe("REJECT");
    expect(decideAdoption({ ...passing, corpus: { ...passing.corpus, mode: "authored" } }, resources())).toMatchObject({ outcome: "INSUFFICIENT_EVIDENCE", reasons: ["evidence sufficiency minimums not met"] });
    const noBenefit = { ...passing, configurations: { ...passing.configurations, embeddingEscalation: { ...passing.configurations.embeddingEscalation, score: passing.configurations.deterministic.score } } };
    expect(decideAdoption(noBenefit, resources()).reasons).toContain("no weighted-error reduction over deterministic clustering");
  });
});

function resources(changes: Partial<EmbedderResources> = {}): EmbedderResources { return { coldLoadMs: 1000, modelBytes: 90_000_000, rssGrowthBytes: 300_000_000, dependencyBytes: 200_000_000, networkRequests: 0, marginalCostUsd: 0, ...changes }; }
function syntheticReport(): EmbeddingClusteringReport {
  const score = (weightedErrors: number) => ({ findings: 200, samePairs: 150, differentPairs: 1000, falseMerges: 0, falseSplits: weightedErrors, weightedErrors, defectLossMerges: 0, pairPrecision: 1, pairRecall: 0.8, candidates: 60, contaminatedCandidates: 0, redundantCandidates: weightedErrors });
  const interval = (difference: number) => ({ difference, lower: difference - 5, upper: Math.min(-1, difference + 5), units: 40, resamples: 10_000, seed: 18 });
  const configuration = (weightedErrors: number, difference: number) => ({ score: score(weightedErrors), perRun: [], versusDeterministic: interval(difference) });
  return { schemaVersion: 1, protocolVersion: "p18-protocol-v1", corpus: { corpusId: "p06", version: 1, mode: "real_models", sha256: "0", fixtures: [] }, embedder: standInEmbedder().identity, settings: { textTemplate: "finding-text-v1", thresholdGrid: [], maximumEscalatedPairs: 20, bootstrapResamples: 10_000, bootstrapSeed: 18, repeats: 5, falseMergeWeight: 2 },
    evidence: { fixtures: 3, runs: 10, findings: 200, groundTruthClusters: 60, multiMemberClusters: 40, samePairs: 150, differentPairs: 1000, ambiguousPairs: 50, escalatedPairs: 50 }, thresholds: { e1: {}, e2: {} },
    configurations: { deterministic: configuration(30, 0), embeddingEscalation: configuration(10, -20), embeddingOnly: configuration(40, 10), oracleEscalation: configuration(5, -25) },
    latency: { deterministic: { samples: 50, medianMs: 1, p95Ms: 2, maxMs: 3 }, embeddingEscalation: { samples: 50, medianMs: 100, p95Ms: 200, maxMs: 300 }, maximumRunFindings: 25 }, reproducible: true, semanticCalls: { e1: 50, oracle: 50 }, ambiguousPairs: [] };
}
