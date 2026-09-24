/**
 * Canonical types for the longitudinal evaluation corpora.
 *
 * The observation shapes are the contract of the corpus store interfaces in
 * `packages/core/src/eval/corpora.ts`; the provenance, ground-truth and adjudication
 * shapes are what the durable store in `packages/persistence/src/evaluation-corpus/`
 * records alongside them. Unknown measurements are `null`, never zero.
 */

export type OutcomeState = "verified" | "rejected" | "fixed" | "ignored" | "recurred";
export const OUTCOME_STATES: readonly OutcomeState[] = Object.freeze(["verified", "rejected", "fixed", "ignored", "recurred"]);

export type CorpusKind = "real_world_outcomes" | "independence";

export interface RealWorldOutcomeObservation {
  readonly corpus: "real_world_outcomes";
  readonly runId: string;
  readonly findingId: string;
  readonly outcome: OutcomeState;
  readonly costUsd: number | null;
  readonly latencyMs: number | null;
}

export interface IndependenceObservation {
  readonly corpus: "independence";
  readonly runId: string;
  readonly findingId: string;
  readonly auditorIds: readonly string[];
  readonly independentlyFoundBy: readonly string[];
  readonly accepted: boolean;
}

export type CorpusObservation = RealWorldOutcomeObservation | IndependenceObservation;

/** One item of a versioned ground-truth set. Decoys are required to make precision visible. */
export interface GroundTruthItem {
  readonly id: string;
  readonly kind: "defect" | "decoy";
  readonly category: string;
  readonly path: string;
  readonly location: string;
  readonly detectionCriteria: string;
  readonly rationale: string;
}

/** An immutable ground-truth version. A changed set is a new version, never an edit. */
export interface GroundTruthVersion {
  readonly groundTruthId: string;
  readonly version: number;
  readonly items: readonly GroundTruthItem[];
}

export interface GroundTruthReference {
  readonly groundTruthId: string;
  readonly version: number;
}

/**
 * Identity of the run an observation came from. It deliberately has no endpoint,
 * credential or free-form configuration field: unknown keys are rejected.
 */
export interface EvaluationRunProvenance {
  readonly runId: string;
  /** Scripted auditors and real models are never aggregated together unless grouped. */
  readonly mode: "scripted" | "real_models";
  readonly snapshot: {
    readonly repository: string;
    readonly sourceDigest: string;
    readonly commit: string | null;
  };
  readonly protocol: { readonly id: string; readonly version: string; readonly hash: string };
  readonly harness: { readonly id: string; readonly version: string; readonly policyHash: string };
  readonly models: readonly {
    readonly auditorId: string;
    readonly modelId: string;
    readonly modelProfileVersion: string;
    readonly transportId: string;
    readonly transportVersion: string;
  }[];
  readonly groundTruth: GroundTruthReference | null;
}

export type CorpusJudgment =
  | { readonly corpus: "real_world_outcomes"; readonly outcome: OutcomeState }
  | { readonly corpus: "independence"; readonly accepted: boolean };

/**
 * A versioned ruling on one observation. Version 0 is the observation as imported;
 * version n supersedes n-1 and never replaces it.
 */
export interface CorpusAdjudication {
  readonly runId: string;
  readonly findingId: string;
  readonly version: number;
  readonly judgment: CorpusJudgment;
  readonly adjudicator: string;
  readonly rationale: string;
  /** When the judgment was made (ISO-8601), supplied by the caller as data. */
  readonly adjudicatedAt: string;
  readonly groundTruthItem: (GroundTruthReference & { readonly itemId: string }) | null;
}

/** Aggregation dimensions that are refused unless grouped by or narrowed to one identity. */
export type CorpusIdentityDimension = "model" | "harness" | "protocol" | "groundTruth" | "mode";
export const CORPUS_IDENTITY_DIMENSIONS: readonly CorpusIdentityDimension[] = Object.freeze(["model", "harness", "protocol", "groundTruth", "mode"]);
