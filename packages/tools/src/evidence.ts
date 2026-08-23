import type { ExposureFootprint } from "./footprint/index.js";

export interface EvidenceQuote {
  readonly sourceId: string;
  readonly path?: string;
  readonly start: number;
  readonly end: number;
}

export type EvidenceVerdict =
  | { readonly valid: true }
  | { readonly valid: false; readonly code: "OUTSIDE_EXPOSURE_FOOTPRINT"; readonly message: string };

export function validateEvidence(quote: EvidenceQuote, footprint: ExposureFootprint): EvidenceVerdict {
  const candidates = footprint.ranges
    .filter((range) => range.sourceId === quote.sourceId && (quote.path === undefined || range.path === quote.path))
    .sort((left, right) => left.start - right.start);
  let coveredUntil = quote.start;
  for (const range of candidates) {
    if (range.end <= coveredUntil || range.start > coveredUntil) continue;
    coveredUntil = Math.max(coveredUntil, range.end);
    if (coveredUntil >= quote.end) return Object.freeze({ valid: true });
  }
  return Object.freeze({
    valid: false,
    code: "OUTSIDE_EXPOSURE_FOOTPRINT",
    message: `Evidence range ${quote.start}-${quote.end} was not delivered to node ${footprint.nodeId}; read the cited range before quoting it.`,
  });
}
