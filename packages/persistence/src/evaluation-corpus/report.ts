import type { EvaluationRunProvenance } from "@arbitra/schemas/evaluation-corpus.js";

import { summarizeIndependence, summarizeOutcomes, type IndependenceSummary, type OutcomeSummary } from "./query.js";
import type { CorpusReportQuery, CorpusView } from "./state.js";

/**
 * Outbound redaction boundary, injected because persistence sits below
 * `packages/security`. The composition layer passes `redactSecrets`; `version` pins the
 * pattern set so a report rebuilt under different patterns is detected, not trusted.
 */
export interface CorpusRedactor {
  readonly version: string;
  redact(text: string): { readonly text: string; readonly redactionCount: number };
}

export interface CorpusReportObservation {
  readonly runId: string;
  readonly findingId: string;
  /** The observation exactly as imported (judgment version 0). */
  readonly imported: Readonly<Record<string, unknown>>;
  /** The judgment the report used, and which version of it. */
  readonly judgment: Readonly<Record<string, unknown>>;
  readonly judgmentVersion: number;
  readonly adjudication: {
    readonly adjudicator: string; readonly rationale: string; readonly adjudicatedAt: string;
    readonly groundTruthItem: { readonly groundTruthId: string; readonly version: number; readonly itemId: string } | null;
  } | null;
}

export interface CorpusReport {
  readonly schemaVersion: 1;
  readonly kind: "arbitra.evaluation-corpus-report";
  readonly query: CorpusReportQuery;
  /** The last committed journal batch the report reflects, and a digest of that journal prefix. */
  readonly asOfBatch: number;
  readonly journalPrefixDigest: string;
  readonly summary: OutcomeSummary | IndependenceSummary;
  readonly runs: readonly EvaluationRunProvenance[];
  readonly groundTruth: readonly { readonly groundTruthId: string; readonly version: number; readonly digest: string; readonly artifactHash: string; readonly defects: number; readonly decoys: number }[];
  readonly observations: readonly CorpusReportObservation[];
  readonly redaction: { readonly version: string; readonly count: number };
}

/** Build the redacted report deterministically from a committed view. */
export function buildCorpusReport(view: CorpusView, query: CorpusReportQuery, journalPrefixDigest: string, redactor: CorpusRedactor): CorpusReport {
  const aggregate = { runIds: query.runIds, groupBy: query.groupBy };
  const summary = query.corpus === "real_world_outcomes" ? summarizeOutcomes(view, aggregate) : summarizeIndependence(view, aggregate);
  const entries = view.entries(query.corpus, query.runIds);
  const runIds = [...new Set(entries.map(({ original }) => original.runId))].sort();
  const runs = runIds.map((runId) => {
    const run = view.run(runId);
    if (run === null) throw new Error(`CORPUS_RUN_PROVENANCE_MISSING:${runId}`);
    return run;
  });
  const truthKeys = [...new Map(runs.flatMap(({ groundTruth }) => groundTruth === null ? [] : [[`${groundTruth.groundTruthId}@${groundTruth.version}`, groundTruth] as const])).values()]
    .sort((left, right) => left.groundTruthId.localeCompare(right.groundTruthId) || left.version - right.version);
  const groundTruth = truthKeys.map(({ groundTruthId, version }) => {
    const entry = view.groundTruth(groundTruthId, version);
    if (entry === null) throw new Error(`CORPUS_GROUND_TRUTH_MISSING:${groundTruthId}@${version}`);
    return {
      groundTruthId, version, digest: entry.digest, artifactHash: entry.artifact.hash,
      defects: entry.value.items.filter(({ kind }) => kind === "defect").length,
      decoys: entry.value.items.filter(({ kind }) => kind === "decoy").length,
    };
  });
  const observations = entries.map((entry): CorpusReportObservation => {
    const { runId, findingId } = entry.original;
    const imported = Object.fromEntries(Object.entries(entry.original).filter(([key]) => key !== "corpus" && key !== "runId" && key !== "findingId"));
    const latest = entry.adjudications.at(-1)?.adjudication;
    const judgment = entry.effective.corpus === "real_world_outcomes" ? { outcome: entry.effective.outcome } : { accepted: entry.effective.accepted };
    return {
      runId, findingId, imported, judgment, judgmentVersion: entry.judgmentVersion,
      adjudication: latest === undefined ? null : {
        adjudicator: latest.adjudicator, rationale: latest.rationale, adjudicatedAt: latest.adjudicatedAt, groundTruthItem: latest.groundTruthItem,
      },
    };
  }).sort((left, right) => left.runId.localeCompare(right.runId) || left.findingId.localeCompare(right.findingId));

  const unredacted = {
    schemaVersion: 1 as const, kind: "arbitra.evaluation-corpus-report" as const,
    query, asOfBatch: view.asOfBatch, journalPrefixDigest, summary, runs, groundTruth, observations,
  };
  const { value, count } = redactDeep(unredacted, redactor);
  return deepFreeze({ ...(value as typeof unredacted), redaction: { version: redactor.version, count } });
}

/** Redact every string value in a JSON tree. Fails closed on an invalid redactor result. */
export function redactDeep(value: unknown, redactor: CorpusRedactor): { readonly value: unknown; readonly count: number } {
  let count = 0;
  const visit = (node: unknown): unknown => {
    if (typeof node === "string") {
      const result = redactor.redact(node);
      if (typeof result.text !== "string" || !Number.isSafeInteger(result.redactionCount) || result.redactionCount < 0) throw new Error("CORPUS_REPORT_REDACTION_FAILED");
      count += result.redactionCount;
      return result.text;
    }
    if (Array.isArray(node)) return node.map(visit);
    if (typeof node === "object" && node !== null) return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, visit(child)]));
    return node;
  };
  const redacted = visit(value);
  return { value: redacted, count };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
