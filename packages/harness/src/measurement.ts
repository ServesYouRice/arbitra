/**
 * Measurement classes. A result produced under a native harness is evidence about that
 * harness as much as about the model, so it must never be pooled with canonical-harness
 * measurements (premise scoring, independence, per-model quality) unless a caller groups
 * by harness explicitly. Native harness identities are always recorded as `native:<id>`.
 */
export type HarnessMeasurementClass = "canonical" | "native";

export const NATIVE_HARNESS_ID_PREFIX = "native:";

export function harnessMeasurementClass(harnessId: string): HarnessMeasurementClass {
  if (harnessId.trim() === "") throw new Error("INVALID_HARNESS_IDENTITY");
  return harnessId.startsWith(NATIVE_HARNESS_ID_PREFIX) ? "native" : "canonical";
}

/** Throws before any aggregation when a native measurement would be pooled into a canonical-only measure. */
export function assertCanonicalMeasurements(harnessIds: readonly string[], measure: string): void {
  const native = [...new Set(harnessIds.filter((id) => harnessMeasurementClass(id) === "native"))].sort();
  if (native.length > 0) throw new Error(`NATIVE_MEASUREMENT_NOT_POOLABLE:${measure}:${native.join(",")}`);
}
