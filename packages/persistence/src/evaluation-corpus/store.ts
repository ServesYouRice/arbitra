import { createHash } from "node:crypto";
import { mkdir, open, readFile, truncate } from "node:fs/promises";
import { join } from "node:path";

import type {
  CorpusAdjudication,
  CorpusKind,
  CorpusObservation,
  EvaluationRunProvenance,
  GroundTruthVersion,
  IndependenceObservation,
  RealWorldOutcomeObservation,
} from "@arbitra/schemas/evaluation-corpus.js";

import { ArtifactStore, contentAddress, type ArtifactFileSystem, type ArtifactRef } from "../artifact-store.js";
import { canonicalJson } from "../canonical-json.js";
import { DEFAULT_FSYNC_POLICY, fsync, type FsyncPolicy, type Fsyncable } from "../fsync.js";
import { summarizeIndependence, summarizeOutcomes, type CorpusAggregateQuery, type IndependenceSummary, type OutcomeSummary } from "./query.js";
import { buildCorpusReport, redactDeep, type CorpusRedactor, type CorpusReport } from "./report.js";
import {
  CorpusState,
  CorpusView,
  digestOf,
  observationKey,
  type CorpusRecord,
  type CorpusReportQuery,
  type ExportEntry,
} from "./state.js";
import {
  isObject,
  validateAdjudication,
  validateCorpusKind,
  validateGroundTruth,
  validateGroupBy,
  validateObservation,
  validateProvenance,
  validateRunIdFilter,
} from "./validate.js";

export const CORPUS_JOURNAL_FILE = "corpus.jsonl";
const GROUND_TRUTH_EXTENSION = "ground-truth";
const REPORT_EXTENSION = "corpus-report";

export interface CorpusClock { now(): number }

export interface CorpusFileHandle extends Fsyncable {
  write(data: Uint8Array): Promise<unknown>;
  close(): Promise<void>;
}

export interface CorpusFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  open(path: string, flags: "a"): Promise<CorpusFileHandle>;
  readFile(path: string): Promise<Uint8Array>;
  truncate(path: string, length: number): Promise<void>;
}

export interface EvaluationCorpusStoreOptions {
  /** Injected so persistence stays deterministic; stamps when an adjudication was recorded. */
  readonly clock: CorpusClock;
  readonly fsyncPolicy?: FsyncPolicy;
  readonly fileSystem?: CorpusFileSystem;
  readonly artifactFileSystem?: ArtifactFileSystem;
}

export interface CorpusRecovery {
  /** Bytes removed from the journal tail: a torn line and/or complete records without a commit. */
  readonly truncatedBytes: number;
  /** Complete but uncommitted records rolled back. */
  readonly discardedRecords: number;
  readonly committedBatches: number;
}

export interface EvaluationCorpusImport {
  readonly groundTruth?: readonly GroundTruthVersion[];
  readonly runs?: readonly EvaluationRunProvenance[];
  readonly observations?: readonly CorpusObservation[];
  readonly adjudications?: readonly CorpusAdjudication[];
}

export interface CorpusImportResult {
  readonly appended: number;
  readonly unchanged: number;
  /** The committed batch, or null when the whole import was already present. */
  readonly batch: number | null;
}

export interface CorpusExportRequest {
  readonly corpus: CorpusKind;
  readonly runIds?: readonly string[];
  readonly groupBy: CorpusAggregateQuery["groupBy"];
}

export interface CorpusExportResult {
  readonly ref: ArtifactRef;
  readonly report: CorpusReport;
  readonly status: "appended" | "unchanged";
}

export interface SupersededJudgment {
  readonly runId: string;
  readonly findingId: string;
  readonly reportedVersion: number;
  readonly currentVersion: number;
}

export interface ReconstructedCorpusReport {
  readonly report: CorpusReport;
  /** Judgments adjudicated again after the export. Reported explicitly, never applied silently. */
  readonly supersededJudgments: readonly SupersededJudgment[];
}

export interface ObservationHistory {
  readonly observation: CorpusObservation;
  readonly adjudications: readonly CorpusAdjudication[];
}

export class CorpusJournalCorruptError extends Error {
  constructor(detail: string, options?: { readonly cause?: unknown }) {
    super(`CORPUS_JOURNAL_CORRUPT: ${detail}`, options);
    this.name = "CorpusJournalCorruptError";
  }
}

export class CorpusReportMismatchError extends Error {
  constructor(readonly code: "CORPUS_REPORT_HISTORY_CHANGED" | "CORPUS_REPORT_RECONSTRUCTION_MISMATCH" | "CORPUS_REPORT_CONTAINS_UNREDACTED_SECRET" | "CORPUS_REPORT_NOT_EXPORTED", detail: string) {
    super(`${code}: ${detail}`);
    this.name = "CorpusReportMismatchError";
  }
}

const nodeFileSystem: CorpusFileSystem = { mkdir, open, readFile, truncate };

/**
 * Durable evaluation corpus: an append-only JSONL journal of batched records plus
 * content-addressed artifacts (ground-truth sets and exported reports).
 *
 * Every write is one batch terminated by a `commit` record and flushed as the
 * `expensive` durability class. On load, a torn tail and any complete records after the
 * last commit are truncated, so a crash mid-import leaves exactly the batches that
 * committed. One writer per corpus directory; loading a journal whose records conflict
 * fails closed.
 */
export class EvaluationCorpusStore {
  readonly directory: string;
  readonly journalPath: string;

  readonly #clock: CorpusClock;
  readonly #fsyncPolicy: FsyncPolicy;
  readonly #fileSystem: CorpusFileSystem;
  readonly #artifacts: ArtifactStore;
  #state: CorpusState | null = null;
  #commitOffsets: number[] = [0];
  #recovery: CorpusRecovery | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(directory: string, options: EvaluationCorpusStoreOptions) {
    this.directory = directory;
    this.journalPath = join(directory, CORPUS_JOURNAL_FILE);
    this.#clock = options.clock;
    this.#fsyncPolicy = options.fsyncPolicy ?? DEFAULT_FSYNC_POLICY;
    this.#fileSystem = options.fileSystem ?? nodeFileSystem;
    this.#artifacts = new ArtifactStore(directory, {
      fsyncPolicy: this.#fsyncPolicy,
      ...(options.artifactFileSystem === undefined ? {} : { fileSystem: options.artifactFileSystem }),
    });
  }

  /** Load (and if necessary recover) the journal; returns what the most recent load repaired. */
  async open(): Promise<CorpusRecovery> {
    return this.#exclusive(async () => {
      await this.#loaded();
      if (this.#recovery === null) throw new Error("CORPUS_NOT_LOADED");
      return this.#recovery;
    });
  }

  /**
   * Idempotently import ground truth, run provenance, observations and adjudications,
   * in that order, as one atomic batch. Records already present with identical content
   * are skipped; a record whose identity exists with different content fails the whole
   * import before anything is written.
   */
  async import(bundle: EvaluationCorpusImport): Promise<CorpusImportResult> {
    return this.#exclusive(async () => {
      const state = await this.#loaded();
      const input = validateBundle(bundle);
      const draft = state.clone();
      const batch = state.batches + 1;
      const records: CorpusRecord[] = [];
      const newArtifacts: { readonly value: GroundTruthVersion; readonly ref: ArtifactRef }[] = [];
      let unchanged = 0;
      const count = (status: "appended" | "unchanged", record: () => CorpusRecord): void => {
        if (status === "unchanged") unchanged += 1; else records.push(record());
      };
      for (const value of input.groundTruth) {
        const ref = contentAddress(value, GROUND_TRUTH_EXTENSION);
        count(draft.applyGroundTruth(value, ref, batch), () => {
          newArtifacts.push({ value, ref });
          return { v: 1, t: "ground_truth", batch, groundTruthId: value.groundTruthId, version: value.version, artifact: ref, digest: digestOf(value) };
        });
      }
      for (const provenance of input.runs) count(draft.applyRun(provenance, batch), () => ({ v: 1, t: "run", batch, provenance, digest: digestOf(provenance) }));
      for (const observation of input.observations) count(draft.applyObservation(observation, batch), () => ({ v: 1, t: "observation", batch, observation, digest: digestOf(observation) }));
      for (const adjudication of input.adjudications) {
        const recordedAt = this.#clock.now();
        if (!Number.isFinite(recordedAt)) throw new RangeError("CORPUS_CLOCK_INVALID");
        count(draft.applyAdjudication(adjudication, recordedAt, batch), () => ({ v: 1, t: "adjudication", batch, adjudication, recordedAt, digest: digestOf(adjudication) }));
      }
      if (records.length === 0) return Object.freeze({ appended: 0, unchanged, batch: null });
      for (const { value, ref } of newArtifacts) {
        const written = await this.#artifacts.put(value, GROUND_TRUTH_EXTENSION, { durability: "expensive" });
        if (written.hash !== ref.hash) throw new Error("CORPUS_GROUND_TRUTH_ADDRESS_MISMATCH");
      }
      await this.#commit(records, draft, batch, true);
      return Object.freeze({ appended: records.length, unchanged, batch });
    });
  }

  registerGroundTruth(value: GroundTruthVersion): Promise<CorpusImportResult> { return this.import({ groundTruth: [value] }); }
  registerRun(provenance: EvaluationRunProvenance): Promise<CorpusImportResult> { return this.import({ runs: [provenance] }); }
  appendObservation(observation: CorpusObservation): Promise<CorpusImportResult> { return this.import({ observations: [observation] }); }
  adjudicate(adjudication: CorpusAdjudication): Promise<CorpusImportResult> { return this.import({ adjudications: [adjudication] }); }

  /** Observations with their latest committed judgment applied, in import order. */
  async observations(corpus: CorpusKind, runIds?: readonly string[]): Promise<readonly CorpusObservation[]> {
    const view = await this.view();
    return Object.freeze(view.entries(validateCorpusKind(corpus), validateRunIdFilter(runIds)).map(({ effective }) => effective));
  }

  /** The imported observation and every adjudication version, oldest first. */
  async history(corpus: CorpusKind, runId: string, findingId: string): Promise<ObservationHistory | null> {
    const state = await this.#exclusive(() => this.#loaded());
    const key = observationKey(corpus, runId, findingId);
    const observation = state.observations.get(key);
    if (observation === undefined) return null;
    return Object.freeze({
      observation: observation.observation,
      adjudications: Object.freeze((state.adjudications.get(key) ?? []).map(({ adjudication }) => adjudication)),
    });
  }

  async provenance(runId: string): Promise<EvaluationRunProvenance | null> {
    return (await this.view()).run(runId);
  }

  async groundTruth(groundTruthId: string, version: number): Promise<GroundTruthVersion | null> {
    return (await this.view()).groundTruth(groundTruthId, version)?.value ?? null;
  }

  /** A read-only view as of a committed batch (default: latest). */
  async view(asOfBatch?: number): Promise<CorpusView> {
    const state = await this.#exclusive(() => this.#loaded());
    return new CorpusView(state, asOfBatch ?? state.batches);
  }

  async summarizeOutcomes(query: { readonly runIds?: readonly string[]; readonly groupBy: CorpusAggregateQuery["groupBy"] }): Promise<OutcomeSummary> {
    return summarizeOutcomes(await this.view(), normalizeAggregate(query));
  }

  async summarizeIndependence(query: { readonly runIds?: readonly string[]; readonly groupBy: CorpusAggregateQuery["groupBy"] }): Promise<IndependenceSummary> {
    return summarizeIndependence(await this.view(), normalizeAggregate(query));
  }

  async exports(): Promise<readonly ExportEntry[]> {
    const state = await this.#exclusive(() => this.#loaded());
    return Object.freeze([...state.exports.values()].sort((left, right) => left.batch - right.batch));
  }

  /**
   * Build a redacted report as of the latest data batch, save it as a content-addressed
   * artifact and journal the export. An incomparable aggregation throws before anything
   * is saved. Exporting unchanged data again returns the same artifact.
   */
  async exportReport(request: CorpusExportRequest, redactor: CorpusRedactor): Promise<CorpusExportResult> {
    return this.#exclusive(async () => {
      const state = await this.#loaded();
      const query = normalizeReportQuery(request);
      const asOfBatch = state.lastDataBatch;
      const report = buildCorpusReport(new CorpusView(state, asOfBatch), query, await this.#prefixDigest(asOfBatch), redactor);
      if (redactDeep(report, redactor).count !== 0) throw new Error("CORPUS_REPORT_REDACTION_INCOMPLETE");
      const ref = contentAddress(report, REPORT_EXTENSION);
      if (state.exports.has(ref.hash)) return Object.freeze({ ref, report, status: "unchanged" as const });
      const written = await this.#artifacts.put(report, REPORT_EXTENSION, { durability: "expensive" });
      if (written.hash !== ref.hash) throw new Error("CORPUS_REPORT_ADDRESS_MISMATCH");
      const draft = state.clone();
      const batch = state.batches + 1;
      draft.applyExport({ report: ref, asOfBatch, query, batch });
      await this.#commit([{ v: 1, t: "export", batch, report: ref, asOfBatch, query }], draft, batch, false);
      return Object.freeze({ ref, report, status: "appended" as const });
    });
  }

  /**
   * Rebuild an exported report from the journal prefix and ground-truth artifacts it
   * was computed from, and require byte equality with the saved artifact. Later
   * adjudications do not alter the rebuilt report; they are listed as superseded.
   */
  async reconstructReport(ref: ArtifactRef, redactor: CorpusRedactor): Promise<ReconstructedCorpusReport> {
    return this.#exclusive(async () => {
      const state = await this.#loaded();
      const entry = state.exports.get(ref.hash);
      if (entry === undefined) throw new CorpusReportMismatchError("CORPUS_REPORT_NOT_EXPORTED", ref.relativePath);
      const saved = await this.#artifacts.get<CorpusReport>(entry.report);
      const prefixDigest = await this.#prefixDigest(entry.asOfBatch);
      if (saved.journalPrefixDigest !== prefixDigest) throw new CorpusReportMismatchError("CORPUS_REPORT_HISTORY_CHANGED", `journal prefix through batch ${entry.asOfBatch} no longer matches the report`);
      const rebuilt = buildCorpusReport(new CorpusView(state, entry.asOfBatch), entry.query, prefixDigest, redactor);
      if (canonicalJson(rebuilt) !== canonicalJson(saved)) throw new CorpusReportMismatchError("CORPUS_REPORT_RECONSTRUCTION_MISMATCH", "saved report differs from the report rebuilt from its journal prefix");
      if (redactDeep(saved, redactor).count !== 0) throw new CorpusReportMismatchError("CORPUS_REPORT_CONTAINS_UNREDACTED_SECRET", ref.relativePath);
      const current = new Map(new CorpusView(state, state.batches).entries(entry.query.corpus, entry.query.runIds)
        .map((value) => [observationKey(value.original.corpus, value.original.runId, value.original.findingId), value.judgmentVersion]));
      const supersededJudgments = saved.observations.flatMap((observation) => {
        const currentVersion = current.get(observationKey(entry.query.corpus, observation.runId, observation.findingId)) ?? observation.judgmentVersion;
        return currentVersion > observation.judgmentVersion
          ? [Object.freeze({ runId: observation.runId, findingId: observation.findingId, reportedVersion: observation.judgmentVersion, currentVersion })]
          : [];
      });
      return Object.freeze({ report: saved, supersededJudgments: Object.freeze(supersededJudgments) });
    });
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  async #loaded(): Promise<CorpusState> {
    if (this.#state === null) await this.#load();
    if (this.#state === null) throw new Error("CORPUS_NOT_LOADED");
    return this.#state;
  }

  async #readJournal(): Promise<Uint8Array> {
    try {
      return await this.#fileSystem.readFile(this.journalPath);
    } catch (error) {
      if (isObject(error) && error.code === "ENOENT") return new Uint8Array();
      throw error;
    }
  }

  async #load(): Promise<void> {
    const bytes = await this.#readJournal();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const lines: { readonly end: number; readonly record: CorpusRecord | null }[] = [];
    let start = 0;
    for (let index = 0; index < bytes.byteLength; index += 1) {
      if (bytes[index] !== 0x0a) continue;
      lines.push({ end: index + 1, record: parseRecord(bytes.subarray(start, index), decoder) });
      start = index + 1;
    }
    let lastCommit = -1;
    lines.forEach(({ record }, index) => { if (record?.t === "commit") lastCommit = index; });

    const state = new CorpusState();
    const offsets = [0];
    let pending: CorpusRecord[] = [];
    for (let index = 0; index <= lastCommit; index += 1) {
      const line = lines[index];
      if (line === undefined || line.record === null) throw new CorpusJournalCorruptError(`line ${index + 1} is not a valid corpus record`);
      const record = line.record;
      if (record.t !== "commit") { pending.push(record); continue; }
      if (record.batch !== state.batches + 1 || record.count !== pending.length || pending.length === 0 || pending.some(({ batch }) => batch !== record.batch)) {
        throw new CorpusJournalCorruptError(`batch ${record.batch} at line ${index + 1} is out of sequence or incomplete`);
      }
      let hasData = false;
      try {
        for (const item of pending) hasData = await this.#replay(state, item) || hasData;
      } catch (error) {
        if (error instanceof CorpusJournalCorruptError) throw error;
        throw new CorpusJournalCorruptError(`batch ${record.batch} cannot be replayed`, { cause: error });
      }
      state.batches = record.batch;
      if (hasData) state.lastDataBatch = record.batch;
      offsets.push(line.end);
      pending = [];
    }
    const committedLength = offsets.at(-1) ?? 0;
    const truncatedBytes = bytes.byteLength - committedLength;
    if (truncatedBytes > 0) await this.#fileSystem.truncate(this.journalPath, committedLength);
    this.#state = state;
    this.#commitOffsets = offsets;
    this.#recovery = Object.freeze({ truncatedBytes, discardedRecords: lines.length - (lastCommit + 1), committedBatches: state.batches });
  }

  async #replay(state: CorpusState, record: CorpusRecord): Promise<boolean> {
    const expectAppended = (status: "appended" | "unchanged"): void => {
      if (status !== "appended") throw new CorpusJournalCorruptError(`duplicate ${record.t} record in batch ${record.batch}`);
    };
    switch (record.t) {
      case "ground_truth": {
        let value: GroundTruthVersion;
        try { value = validateGroundTruth(await this.#artifacts.get<unknown>(record.artifact)); }
        catch (error) { throw new CorpusJournalCorruptError(`ground-truth artifact ${record.artifact.relativePath} is missing or invalid`, { cause: error }); }
        if (value.groundTruthId !== record.groundTruthId || value.version !== record.version || digestOf(value) !== record.digest) {
          throw new CorpusJournalCorruptError(`ground-truth artifact ${record.artifact.relativePath} does not match its record`);
        }
        expectAppended(state.applyGroundTruth(value, record.artifact, record.batch));
        return true;
      }
      case "run": expectAppended(state.applyRun(record.provenance, record.batch)); return true;
      case "observation": expectAppended(state.applyObservation(record.observation, record.batch)); return true;
      case "adjudication": expectAppended(state.applyAdjudication(record.adjudication, record.recordedAt, record.batch)); return true;
      case "export": expectAppended(state.applyExport({ report: record.report, asOfBatch: record.asOfBatch, query: record.query, batch: record.batch })); return false;
      case "commit": throw new CorpusJournalCorruptError("nested commit");
    }
  }

  async #commit(records: readonly CorpusRecord[], draft: CorpusState, batch: number, hasData: boolean): Promise<void> {
    const text = [...records, { v: 1, t: "commit", batch, count: records.length } satisfies CorpusRecord]
      .map((record) => `${canonicalJson(record)}\n`).join("");
    const bytes = new TextEncoder().encode(text);
    try {
      await this.#fileSystem.mkdir(this.directory, { recursive: true });
      const handle = await this.#fileSystem.open(this.journalPath, "a");
      try {
        await handle.write(bytes);
        await fsync(handle, this.#fsyncPolicy, "expensive");
      } finally {
        await handle.close();
      }
    } catch (error) {
      // The on-disk tail is unknown; the next operation reloads and truncates any uncommitted bytes.
      this.#state = null;
      throw error;
    }
    draft.batches = batch;
    if (hasData) draft.lastDataBatch = batch;
    this.#state = draft;
    this.#commitOffsets = [...this.#commitOffsets, (this.#commitOffsets.at(-1) ?? 0) + bytes.byteLength];
  }

  async #prefixDigest(asOfBatch: number): Promise<string> {
    const end = this.#commitOffsets[asOfBatch];
    if (end === undefined) throw new Error("CORPUS_AS_OF_BATCH_OUT_OF_RANGE");
    const bytes = await this.#readJournal();
    if (bytes.byteLength < end) throw new CorpusReportMismatchError("CORPUS_REPORT_HISTORY_CHANGED", "journal is shorter than its committed history");
    return createHash("sha256").update(bytes.subarray(0, end)).digest("hex");
  }
}

/** Durable `RealWorldOutcomeStore` (see `packages/core/src/eval/corpora.ts`). */
export class DurableRealWorldOutcomeStore {
  constructor(readonly corpus: EvaluationCorpusStore) {}
  async append(observation: RealWorldOutcomeObservation): Promise<void> {
    if (observation.corpus !== "real_world_outcomes") throw new TypeError("INVALID_CORPUS_INPUT:observation.corpus");
    await this.corpus.appendObservation(observation);
  }
  async query(runIds?: readonly string[]): Promise<readonly RealWorldOutcomeObservation[]> {
    return await this.corpus.observations("real_world_outcomes", runIds) as readonly RealWorldOutcomeObservation[];
  }
}

/** Durable `IndependenceCorpusStore` (see `packages/core/src/eval/corpora.ts`). */
export class DurableIndependenceCorpusStore {
  constructor(readonly corpus: EvaluationCorpusStore) {}
  async append(observation: IndependenceObservation): Promise<void> {
    if (observation.corpus !== "independence") throw new TypeError("INVALID_CORPUS_INPUT:observation.corpus");
    await this.corpus.appendObservation(observation);
  }
  async query(runIds?: readonly string[]): Promise<readonly IndependenceObservation[]> {
    return await this.corpus.observations("independence", runIds) as readonly IndependenceObservation[];
  }
}

function validateBundle(bundle: unknown): {
  readonly groundTruth: readonly GroundTruthVersion[]; readonly runs: readonly EvaluationRunProvenance[];
  readonly observations: readonly CorpusObservation[]; readonly adjudications: readonly CorpusAdjudication[];
} {
  if (!isObject(bundle)) throw new TypeError("INVALID_CORPUS_INPUT:import");
  const unknown = Object.keys(bundle).find((key) => !["groundTruth", "runs", "observations", "adjudications"].includes(key));
  if (unknown !== undefined) throw new TypeError(`INVALID_CORPUS_INPUT:import: unknown field ${unknown}`);
  const list = <T>(value: unknown, name: string, validate: (item: unknown) => T): readonly T[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new TypeError(`INVALID_CORPUS_INPUT:import.${name}`);
    return value.map(validate);
  };
  return {
    groundTruth: list(bundle.groundTruth, "groundTruth", validateGroundTruth),
    runs: list(bundle.runs, "runs", validateProvenance),
    observations: list(bundle.observations, "observations", validateObservation),
    adjudications: list(bundle.adjudications, "adjudications", validateAdjudication),
  };
}

function normalizeAggregate(query: { readonly runIds?: readonly string[]; readonly groupBy: unknown }): CorpusAggregateQuery {
  return Object.freeze({ runIds: validateRunIdFilter(query.runIds), groupBy: validateGroupBy(query.groupBy) });
}

function normalizeReportQuery(request: CorpusExportRequest): CorpusReportQuery {
  if (!isObject(request)) throw new TypeError("INVALID_CORPUS_INPUT:query");
  return Object.freeze({ corpus: validateCorpusKind(request.corpus), ...normalizeAggregate(request) });
}

function parseRecord(bytes: Uint8Array, decoder: TextDecoder): CorpusRecord | null {
  let value: unknown;
  try { value = JSON.parse(decoder.decode(bytes)) as unknown; } catch { return null; }
  try { return validateRecord(value); } catch { return null; }
}

function validateRecord(value: unknown): CorpusRecord {
  if (!isObject(value) || value.v !== 1 || !positiveInteger(value.batch)) throw new Error("record");
  const batch = value.batch;
  switch (value.t) {
    case "commit":
      if (!nonnegativeInteger(value.count)) throw new Error("commit");
      return { v: 1, t: "commit", batch, count: value.count };
    case "ground_truth":
      if (typeof value.groundTruthId !== "string" || !positiveInteger(value.version) || !isArtifactRef(value.artifact) || !isDigest(value.digest)) throw new Error("ground_truth");
      return { v: 1, t: "ground_truth", batch, groundTruthId: value.groundTruthId, version: value.version, artifact: value.artifact, digest: value.digest };
    case "run": {
      const provenance = validateProvenance(value.provenance);
      if (value.digest !== digestOf(provenance)) throw new Error("digest");
      return { v: 1, t: "run", batch, provenance, digest: value.digest };
    }
    case "observation": {
      const observation = validateObservation(value.observation);
      if (value.digest !== digestOf(observation)) throw new Error("digest");
      return { v: 1, t: "observation", batch, observation, digest: value.digest };
    }
    case "adjudication": {
      const adjudication = validateAdjudication(value.adjudication);
      if (value.digest !== digestOf(adjudication) || typeof value.recordedAt !== "number" || !Number.isFinite(value.recordedAt)) throw new Error("adjudication");
      return { v: 1, t: "adjudication", batch, adjudication, recordedAt: value.recordedAt, digest: value.digest };
    }
    case "export": {
      if (!isArtifactRef(value.report) || !nonnegativeInteger(value.asOfBatch) || !isObject(value.query)) throw new Error("export");
      const query = value.query;
      const runIds = query.runIds === null ? null : validateRunIdFilter(query.runIds);
      return { v: 1, t: "export", batch, report: value.report, asOfBatch: value.asOfBatch,
        query: Object.freeze({ corpus: validateCorpusKind(query.corpus), runIds, groupBy: validateGroupBy(query.groupBy) }) };
    }
    default:
      throw new Error("type");
  }
}

function isArtifactRef(value: unknown): value is ArtifactRef {
  return isObject(value) && isDigest(value.hash) && nonnegativeInteger(value.byteLength)
    && typeof value.extension === "string" && value.relativePath === `artifacts/${String(value.hash)}.${value.extension}`;
}
function isDigest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
function positiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 1; }
function nonnegativeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
