import type { ControlClass } from "./control-class.js";
import type { Taint } from "./taint.js";

export const PROVENANCES = ["system", "user", "repo", "tool", "model"] as const;

export type Provenance = (typeof PROVENANCES)[number];

export interface FieldTrust {
  readonly provenance: Provenance;
  readonly taint: Taint;
  readonly controlClass: ControlClass;
}

export type FieldTrustMap<FieldFamily extends string = string> = Readonly<
  Record<FieldFamily, FieldTrust>
>;

/** Keeps trust metadata beside an artifact without wrapping each primitive value. */
export interface TrustAnnotated<Value, FieldFamily extends string = string> {
  readonly value: Value;
  readonly fieldTrust: FieldTrustMap<FieldFamily>;
}

export function annotateTrust<Value, FieldFamily extends string>(
  value: Value,
  fieldTrust: Record<FieldFamily, FieldTrust>,
): TrustAnnotated<Value, FieldFamily> {
  const entries = Object.entries<FieldTrust>(fieldTrust);
  if (entries.length === 0) {
    throw new Error("TRUST_METADATA_REQUIRED: at least one field family must be classified");
  }
  for (const [field, trust] of entries) {
    if (trust.provenance === "repo" && !trust.taint.tainted) {
      throw new Error(`REPOSITORY_CONTENT_MUST_BE_TAINTED: ${field}`);
    }
  }

  const frozenTrust = Object.fromEntries(
    entries.map(([field, trust]) => [field, Object.freeze({ ...trust })]),
  ) as Record<FieldFamily, FieldTrust>;

  return Object.freeze({ value, fieldTrust: Object.freeze(frozenTrust) });
}
