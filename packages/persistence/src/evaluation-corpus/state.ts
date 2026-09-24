import { createHash } from "node:crypto";

import type {
  CorpusAdjudication,
  CorpusIdentityDimension,
  CorpusKind,
  CorpusObservation,
  EvaluationRunProvenance,
  GroundTruthVersion,
} from "@arbitra/schemas/evaluation-corpus.js";

import type { ArtifactRef } from "../artifact-store.js";
import { canonicalJson } from "../canonical-json.js";

/** A normalized report query; persisted with each export so the report can be rebuilt. */
export interface CorpusReportQuery {
  readonly corpus: CorpusKind;
  readonly runIds: readonly string[] | null;
  readonly groupBy: readonly CorpusIdentityDimension[];
}

/** One line of the corpus journal. Data records become visible only with their batch's commit. */
export type CorpusRecord =
  | { readonly v: 1; readonly t: "ground_truth"; readonly batch: number; readonly groundTruthId: string; readonly version: number; readonly artifact: ArtifactRef; readonly digest: string }
  | { readonly v: 1; readonly t: "run"; readonly batch: number; readonly provenance: EvaluationRunProvenance; readonly digest: string }
  | { readonly v: 1; readonly t: "observation"; readonly batch: number; readonly observation: CorpusObservation; readonly digest: string }
  | { readonly v: 1; readonly t: "adjudication"; readonly batch: number; readonly adjudication: CorpusAdjudication; readonly recordedAt: number; readonly digest: string }
  | { readonly v: 1; readonly t: "export"; readonly batch: number; readonly report: ArtifactRef; readonly asOfBatch: number; readonly query: CorpusReportQuery }
  | { readonly v: 1; readonly t: "commit"; readonly batch: number; readonly count: number };

export type ApplyStatus = "appended" | "unchanged";

export interface GroundTruthEntry { readonly value: GroundTruthVersion; readonly artifact: ArtifactRef; readonly digest: string; readonly batch: number }
export interface RunEntry { readonly provenance: EvaluationRunProvenance; readonly digest: string; readonly batch: number }
export interface ObservationEntry { readonly observation: CorpusObservation; readonly digest: string; readonly batch: number }
export interface AdjudicationEntry { readonly adjudication: CorpusAdjudication; readonly digest: string; readonly batch: number; readonly recordedAt: number }
export interface ExportEntry { readonly report: ArtifactRef; readonly asOfBatch: number; readonly query: CorpusReportQuery; readonly batch: number }

/** Raised when a record's natural key already exists with different content. Nothing is written. */
export class CorpusIdentityConflictError extends Error {
  constructor(readonly kind: string, readonly key: string, detail: string) {
    super(`CORPUS_IDENTITY_CONFLICT:${kind}:${key}: ${detail}`);
    this.name = "CorpusIdentityConflictError";
  }
}

export function digestOf(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function observationKey(corpus: CorpusKind, runId: string, findingId: string): string {
  return canonicalJson([corpus, runId, findingId]);
}

export function groundTruthKey(groundTruthId: string, version: number): string {
  return `${groundTruthId}@${version}`;
}

/**
 * The authoritative in-memory projection of committed journal batches. The same
 * `apply*` rules validate new imports and replay the journal on load, so a journal
 * that contains conflicting records cannot load.
 */
export class CorpusState {
  batches = 0;
  /** The latest committed batch that changed corpus data (export-only batches do not). */
  lastDataBatch = 0;
  groundTruth = new Map<string, GroundTruthEntry>();
  runs = new Map<string, RunEntry>();
  observations = new Map<string, ObservationEntry>();
  adjudications = new Map<string, readonly AdjudicationEntry[]>();
  exports = new Map<string, ExportEntry>();

  clone(): CorpusState {
    const copy = new CorpusState();
    copy.batches = this.batches;
    copy.lastDataBatch = this.lastDataBatch;
    copy.groundTruth = new Map(this.groundTruth);
    copy.runs = new Map(this.runs);
    copy.observations = new Map(this.observations);
    copy.adjudications = new Map(this.adjudications);
    copy.exports = new Map(this.exports);
    return copy;
  }

  applyGroundTruth(value: GroundTruthVersion, artifact: ArtifactRef, batch: number): ApplyStatus {
    const key = groundTruthKey(value.groundTruthId, value.version);
    const digest = digestOf(value);
    const existing = this.groundTruth.get(key);
    if (existing !== undefined) {
      if (existing.digest === digest) return "unchanged";
      throw new CorpusIdentityConflictError("ground_truth", key, "a ground-truth version is immutable; register a new version");
    }
    this.groundTruth.set(key, Object.freeze({ value, artifact, digest, batch }));
    return "appended";
  }

  applyRun(provenance: EvaluationRunProvenance, batch: number): ApplyStatus {
    const digest = digestOf(provenance);
    const existing = this.runs.get(provenance.runId);
    if (existing !== undefined) {
      if (existing.digest === digest) return "unchanged";
      throw new CorpusIdentityConflictError("run", provenance.runId, "run provenance differs from the recorded run/snapshot/protocol/model/harness identity");
    }
    if (provenance.groundTruth !== null) {
      const key = groundTruthKey(provenance.groundTruth.groundTruthId, provenance.groundTruth.version);
      if (!this.groundTruth.has(key)) throw new Error(`CORPUS_GROUND_TRUTH_MISSING:${key}`);
    }
    this.runs.set(provenance.runId, Object.freeze({ provenance, digest, batch }));
    return "appended";
  }

  applyObservation(observation: CorpusObservation, batch: number): ApplyStatus {
    const key = observationKey(observation.corpus, observation.runId, observation.findingId);
    const digest = digestOf(observation);
    const existing = this.observations.get(key);
    if (existing !== undefined) {
      if (existing.digest === digest) return "unchanged";
      throw new CorpusIdentityConflictError("observation", key, "an imported observation is immutable; record a changed judgment as an adjudication");
    }
    const run = this.runs.get(observation.runId);
    if (run === undefined) throw new Error(`CORPUS_RUN_PROVENANCE_MISSING:${observation.runId}`);
    if (observation.corpus === "independence") {
      const known = new Set(run.provenance.models.map(({ auditorId }) => auditorId));
      const unknown = observation.auditorIds.find((auditorId) => !known.has(auditorId));
      if (unknown !== undefined) throw new CorpusIdentityConflictError("auditor", `${observation.runId}/${unknown}`, "auditor is not part of the run's recorded model identity");
    }
    this.observations.set(key, Object.freeze({ observation, digest, batch }));
    return "appended";
  }

  applyAdjudication(adjudication: CorpusAdjudication, recordedAt: number, batch: number): ApplyStatus {
    const key = observationKey(adjudication.judgment.corpus, adjudication.runId, adjudication.findingId);
    const observation = this.observations.get(key);
    if (observation === undefined) throw new Error(`CORPUS_OBSERVATION_MISSING:${key}`);
    const digest = digestOf(adjudication);
    const history = this.adjudications.get(key) ?? [];
    const existing = history[adjudication.version - 1];
    if (existing !== undefined) {
      if (existing.digest === digest) return "unchanged";
      throw new CorpusIdentityConflictError("adjudication", `${key}#${adjudication.version}`, "a recorded adjudication version is append-only; submit the next version instead");
    }
    if (adjudication.version !== history.length + 1) {
      throw new Error(`CORPUS_ADJUDICATION_VERSION_GAP:${key}: expected version ${history.length + 1}, received ${adjudication.version}`);
    }
    if (adjudication.groundTruthItem !== null) {
      const cited = adjudication.groundTruthItem;
      const runTruth = this.runs.get(adjudication.runId)?.provenance.groundTruth ?? null;
      if (runTruth === null || runTruth.groundTruthId !== cited.groundTruthId || runTruth.version !== cited.version) {
        throw new CorpusIdentityConflictError("groundTruth", key, "adjudication cites ground truth other than the run's recorded ground-truth version");
      }
      const truth = this.groundTruth.get(groundTruthKey(cited.groundTruthId, cited.version));
      if (truth === undefined || !truth.value.items.some(({ id }) => id === cited.itemId)) {
        throw new Error(`CORPUS_GROUND_TRUTH_ITEM_MISSING:${groundTruthKey(cited.groundTruthId, cited.version)}/${cited.itemId}`);
      }
    }
    this.adjudications.set(key, Object.freeze([...history, Object.freeze({ adjudication, digest, batch, recordedAt })]));
    return "appended";
  }

  applyExport(entry: ExportEntry): ApplyStatus {
    const existing = this.exports.get(entry.report.hash);
    if (existing !== undefined) return "unchanged";
    if (entry.asOfBatch >= entry.batch) throw new Error("CORPUS_EXPORT_AS_OF_INVALID");
    this.exports.set(entry.report.hash, Object.freeze(entry));
    return "appended";
  }
}

/** One observation with its judgment history, as visible at a committed batch. */
export interface CorpusEntryView {
  readonly original: CorpusObservation;
  readonly adjudications: readonly AdjudicationEntry[];
  /** The observation with the latest visible judgment applied. */
  readonly effective: CorpusObservation;
  /** 0 when the imported judgment stands; otherwise the latest visible adjudication version. */
  readonly judgmentVersion: number;
}

/** A read-only projection of the state as of a committed batch. */
export class CorpusView {
  constructor(private readonly state: CorpusState, readonly asOfBatch: number) {
    if (!Number.isSafeInteger(asOfBatch) || asOfBatch < 0 || asOfBatch > state.batches) throw new Error("CORPUS_AS_OF_BATCH_OUT_OF_RANGE");
  }

  run(runId: string): EvaluationRunProvenance | null {
    const entry = this.state.runs.get(runId);
    return entry === undefined || entry.batch > this.asOfBatch ? null : entry.provenance;
  }

  groundTruth(groundTruthId: string, version: number): GroundTruthEntry | null {
    const entry = this.state.groundTruth.get(groundTruthKey(groundTruthId, version));
    return entry === undefined || entry.batch > this.asOfBatch ? null : entry;
  }

  entries(corpus: CorpusKind, runIds: readonly string[] | null): readonly CorpusEntryView[] {
    const result: CorpusEntryView[] = [];
    for (const [key, entry] of this.state.observations) {
      if (entry.batch > this.asOfBatch || entry.observation.corpus !== corpus) continue;
      if (runIds !== null && !runIds.includes(entry.observation.runId)) continue;
      const adjudications = (this.state.adjudications.get(key) ?? []).filter(({ batch }) => batch <= this.asOfBatch);
      const latest = adjudications.at(-1);
      result.push(Object.freeze({
        original: entry.observation,
        adjudications: Object.freeze(adjudications),
        effective: latest === undefined ? entry.observation : withJudgment(entry.observation, latest.adjudication),
        judgmentVersion: latest?.adjudication.version ?? 0,
      }));
    }
    return Object.freeze(result);
  }
}

function withJudgment(observation: CorpusObservation, adjudication: CorpusAdjudication): CorpusObservation {
  const judgment = adjudication.judgment;
  if (observation.corpus === "real_world_outcomes" && judgment.corpus === "real_world_outcomes") return Object.freeze({ ...observation, outcome: judgment.outcome });
  if (observation.corpus === "independence" && judgment.corpus === "independence") return Object.freeze({ ...observation, accepted: judgment.accepted });
  throw new Error("CORPUS_JUDGMENT_CORPUS_MISMATCH");
}
