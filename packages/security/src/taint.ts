import type { Provenance } from "./provenance.js";

export const MAX_TAINT_SOURCES = 32;
const TRUNCATED_SOURCE = "[additional-taint-sources]";

export interface Taint {
  readonly tainted: boolean;
  /** Bounded, deduplicated identifiers for display and audit only. */
  readonly sources: readonly string[];
}

export const CLEAN_TAINT: Taint = Object.freeze({ tainted: false, sources: Object.freeze([]) });

export function taintedBy(...sources: readonly string[]): Taint {
  const normalized = boundedSources(sources);
  if (normalized.length === 0) {
    throw new Error("TAINT_SOURCE_REQUIRED: tainted values require at least one source");
  }
  return Object.freeze({ tainted: true, sources: normalized });
}

/** A node output is tainted when any input is tainted, independent of output provenance. */
export function propagate(inputs: readonly Taint[]): Taint {
  const taintedInputs = inputs.filter((input) => input.tainted);
  if (taintedInputs.length === 0) return CLEAN_TAINT;
  return taintedBy(...taintedInputs.flatMap((input) => input.sources));
}

/**
 * Applies provenance-specific ingress rules, then propagates input influence.
 * Repository bytes are always tainted. Tool and model output can never clear input taint.
 */
export function taintForOutput(
  provenance: Provenance,
  source: string,
  inputs: readonly Taint[] = [],
): Taint {
  const inherited = propagate(inputs);
  if (provenance === "repo") return taintedBy(source, ...inherited.sources);
  if (inherited.tainted) return inherited;
  return CLEAN_TAINT;
}

function boundedSources(sources: readonly string[]): readonly string[] {
  const unique = [...new Set(sources.filter((source) => source.length > 0))].sort();
  if (unique.length <= MAX_TAINT_SOURCES) return Object.freeze(unique);
  return Object.freeze([...unique.slice(0, MAX_TAINT_SOURCES - 1), TRUNCATED_SOURCE]);
}
