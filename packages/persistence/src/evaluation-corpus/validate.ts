import {
  CORPUS_IDENTITY_DIMENSIONS,
  OUTCOME_STATES,
  type CorpusAdjudication,
  type CorpusIdentityDimension,
  type CorpusJudgment,
  type CorpusKind,
  type CorpusObservation,
  type EvaluationRunProvenance,
  type GroundTruthItem,
  type GroundTruthReference,
  type GroundTruthVersion,
} from "@arbitra/schemas/evaluation-corpus.js";

/** Strict input validation: unknown keys are rejected so no credential-bearing field can ride along. */

const MAX_IDENTIFIER = 512;
const MAX_TEXT = 16_384;

export function validateGroundTruth(value: unknown): GroundTruthVersion {
  const input = exact(value, "ground_truth", ["groundTruthId", "version", "items"]);
  const groundTruthId = identifier(input.groundTruthId, "ground_truth.groundTruthId");
  const version = positiveInteger(input.version, "ground_truth.version");
  if (!Array.isArray(input.items) || input.items.length === 0) invalid("ground_truth.items");
  const seen = new Set<string>();
  const items = input.items.map((item: unknown, index: number): GroundTruthItem => {
    const path = `ground_truth.items[${index}]`;
    const entry = exact(item, path, ["id", "kind", "category", "path", "location", "detectionCriteria", "rationale"]);
    const id = identifier(entry.id, `${path}.id`);
    if (seen.has(id)) invalid(`${path}.id:duplicate`);
    seen.add(id);
    if (entry.kind !== "defect" && entry.kind !== "decoy") invalid(`${path}.kind`);
    return Object.freeze({
      id, kind: entry.kind,
      category: identifier(entry.category, `${path}.category`),
      path: identifier(entry.path, `${path}.path`),
      location: identifier(entry.location, `${path}.location`),
      detectionCriteria: text(entry.detectionCriteria, `${path}.detectionCriteria`),
      rationale: text(entry.rationale, `${path}.rationale`),
    });
  });
  return Object.freeze({ groundTruthId, version, items: Object.freeze(items) });
}

export function validateProvenance(value: unknown): EvaluationRunProvenance {
  const input = exact(value, "run", ["runId", "mode", "snapshot", "protocol", "harness", "models", "groundTruth"]);
  const runId = identifier(input.runId, "run.runId");
  if (input.mode !== "scripted" && input.mode !== "real_models") invalid("run.mode");
  const snapshot = exact(input.snapshot, "run.snapshot", ["repository", "sourceDigest", "commit"]);
  const protocol = exact(input.protocol, "run.protocol", ["id", "version", "hash"]);
  const harness = exact(input.harness, "run.harness", ["id", "version", "policyHash"]);
  if (!Array.isArray(input.models) || input.models.length === 0) invalid("run.models");
  const auditors = new Set<string>();
  const models = input.models.map((model: unknown, index: number) => {
    const path = `run.models[${index}]`;
    const entry = exact(model, path, ["auditorId", "modelId", "modelProfileVersion", "transportId", "transportVersion"]);
    const auditorId = identifier(entry.auditorId, `${path}.auditorId`);
    if (auditors.has(auditorId)) invalid(`${path}.auditorId:duplicate`);
    auditors.add(auditorId);
    return Object.freeze({
      auditorId,
      modelId: identifier(entry.modelId, `${path}.modelId`),
      modelProfileVersion: identifier(entry.modelProfileVersion, `${path}.modelProfileVersion`),
      transportId: identifier(entry.transportId, `${path}.transportId`),
      transportVersion: identifier(entry.transportVersion, `${path}.transportVersion`),
    });
  });
  return Object.freeze({
    runId, mode: input.mode,
    snapshot: Object.freeze({
      repository: identifier(snapshot.repository, "run.snapshot.repository"),
      sourceDigest: identifier(snapshot.sourceDigest, "run.snapshot.sourceDigest"),
      commit: snapshot.commit === null ? null : identifier(snapshot.commit, "run.snapshot.commit"),
    }),
    protocol: Object.freeze({ id: identifier(protocol.id, "run.protocol.id"), version: identifier(protocol.version, "run.protocol.version"), hash: identifier(protocol.hash, "run.protocol.hash") }),
    harness: Object.freeze({ id: identifier(harness.id, "run.harness.id"), version: identifier(harness.version, "run.harness.version"), policyHash: identifier(harness.policyHash, "run.harness.policyHash") }),
    models: Object.freeze(models),
    groundTruth: input.groundTruth === null ? null : groundTruthReference(input.groundTruth, "run.groundTruth"),
  });
}

export function validateObservation(value: unknown): CorpusObservation {
  if (!isObject(value)) invalid("observation");
  if (value.corpus === "real_world_outcomes") {
    const input = exact(value, "observation", ["corpus", "runId", "findingId", "outcome", "costUsd", "latencyMs"]);
    return Object.freeze({
      corpus: "real_world_outcomes",
      runId: identifier(input.runId, "observation.runId"),
      findingId: identifier(input.findingId, "observation.findingId"),
      outcome: outcomeState(input.outcome, "observation.outcome"),
      costUsd: nullableMeasurement(input.costUsd, "observation.costUsd"),
      latencyMs: nullableMeasurement(input.latencyMs, "observation.latencyMs"),
    });
  }
  if (value.corpus === "independence") {
    const input = exact(value, "observation", ["corpus", "runId", "findingId", "auditorIds", "independentlyFoundBy", "accepted"]);
    const auditorIds = identifierList(input.auditorIds, "observation.auditorIds");
    const independentlyFoundBy = identifierList(input.independentlyFoundBy, "observation.independentlyFoundBy");
    if (auditorIds.length < 2 || independentlyFoundBy.some((id) => !auditorIds.includes(id))) throw new Error("INVALID_INDEPENDENCE_OBSERVATION");
    if (typeof input.accepted !== "boolean") invalid("observation.accepted");
    return Object.freeze({
      corpus: "independence",
      runId: identifier(input.runId, "observation.runId"),
      findingId: identifier(input.findingId, "observation.findingId"),
      auditorIds, independentlyFoundBy, accepted: input.accepted,
    });
  }
  return invalid("observation.corpus");
}

export function validateAdjudication(value: unknown): CorpusAdjudication {
  const input = exact(value, "adjudication", ["runId", "findingId", "version", "judgment", "adjudicator", "rationale", "adjudicatedAt", "groundTruthItem"]);
  return Object.freeze({
    runId: identifier(input.runId, "adjudication.runId"),
    findingId: identifier(input.findingId, "adjudication.findingId"),
    version: positiveInteger(input.version, "adjudication.version"),
    judgment: judgment(input.judgment),
    adjudicator: identifier(input.adjudicator, "adjudication.adjudicator"),
    rationale: text(input.rationale, "adjudication.rationale"),
    adjudicatedAt: timestamp(input.adjudicatedAt, "adjudication.adjudicatedAt"),
    groundTruthItem: input.groundTruthItem === null ? null : groundTruthItemReference(input.groundTruthItem),
  });
}

export function validateGroupBy(value: unknown): readonly CorpusIdentityDimension[] {
  if (!Array.isArray(value)) invalid("query.groupBy");
  const dimensions = value.map((item: unknown) => {
    if (typeof item !== "string" || !(CORPUS_IDENTITY_DIMENSIONS as readonly string[]).includes(item)) invalid("query.groupBy");
    return item as CorpusIdentityDimension;
  });
  if (new Set(dimensions).size !== dimensions.length) throw new Error("DUPLICATE_CORPUS_GROUP_DIMENSION");
  return Object.freeze(dimensions);
}

export function validateRunIdFilter(value: unknown): readonly string[] | null {
  if (value === undefined) return null;
  return Object.freeze([...new Set(identifierList(value, "query.runIds"))].sort());
}

export function validateCorpusKind(value: unknown): CorpusKind {
  if (value !== "real_world_outcomes" && value !== "independence") invalid("query.corpus");
  return value;
}

function judgment(value: unknown): CorpusJudgment {
  if (!isObject(value)) invalid("adjudication.judgment");
  if (value.corpus === "real_world_outcomes") {
    const input = exact(value, "adjudication.judgment", ["corpus", "outcome"]);
    return Object.freeze({ corpus: "real_world_outcomes", outcome: outcomeState(input.outcome, "adjudication.judgment.outcome") });
  }
  if (value.corpus === "independence") {
    const input = exact(value, "adjudication.judgment", ["corpus", "accepted"]);
    if (typeof input.accepted !== "boolean") invalid("adjudication.judgment.accepted");
    return Object.freeze({ corpus: "independence", accepted: input.accepted });
  }
  return invalid("adjudication.judgment.corpus");
}

function groundTruthReference(value: unknown, path: string): GroundTruthReference {
  const input = exact(value, path, ["groundTruthId", "version"]);
  return Object.freeze({ groundTruthId: identifier(input.groundTruthId, `${path}.groundTruthId`), version: positiveInteger(input.version, `${path}.version`) });
}

function groundTruthItemReference(value: unknown): GroundTruthReference & { readonly itemId: string } {
  const path = "adjudication.groundTruthItem";
  const input = exact(value, path, ["groundTruthId", "version", "itemId"]);
  return Object.freeze({
    groundTruthId: identifier(input.groundTruthId, `${path}.groundTruthId`),
    version: positiveInteger(input.version, `${path}.version`),
    itemId: identifier(input.itemId, `${path}.itemId`),
  });
}

function outcomeState(value: unknown, path: string) {
  if (typeof value !== "string" || !(OUTCOME_STATES as readonly string[]).includes(value)) invalid(path);
  return value as (typeof OUTCOME_STATES)[number];
}

function exact(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!isObject(value)) invalid(path);
  const actual = Object.keys(value);
  const unknown = actual.find((key) => !keys.includes(key));
  if (unknown !== undefined) throw new TypeError(`INVALID_CORPUS_INPUT:${path}: unknown field ${unknown}`);
  const missing = keys.find((key) => !(key in value));
  if (missing !== undefined) throw new TypeError(`INVALID_CORPUS_INPUT:${path}: missing field ${missing}`);
  return value;
}

function identifier(value: unknown, path: string): string {
  // eslint-disable-next-line no-control-regex -- identifiers must not carry control characters
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > MAX_IDENTIFIER || /[\u0000-\u001f\u007f]/u.test(value)) invalid(path);
  return value;
}

function identifierList(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) invalid(path);
  const items = value.map((item: unknown, index: number) => identifier(item, `${path}[${index}]`));
  if (new Set(items).size !== items.length) invalid(`${path}:duplicate`);
  return Object.freeze(items);
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_TEXT) invalid(path);
  return value;
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid(path);
  return value;
}

/** A measurement is a finite non-negative number or `null` (unknown). Never coerced to zero. */
function nullableMeasurement(value: unknown, path: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) invalid(path);
  return value;
}

function timestamp(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || Number.isNaN(Date.parse(value))) invalid(path);
  return value;
}

function invalid(path: string): never {
  throw new TypeError(`INVALID_CORPUS_INPUT:${path}`);
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
