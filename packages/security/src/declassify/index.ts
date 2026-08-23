import { normalizeSchemaPath } from "../control-class.js";
import type { FieldTrust } from "../provenance.js";
import { CLEAN_TAINT } from "../taint.js";

export const DECLASSIFIER_CATEGORIES = [
  "schema_enum",
  "boolean",
  "bounded_number",
  "snapshot_path",
  "line_range",
  "evidence_id",
  "orchestrator_id",
] as const;

export type DeclassifierCategory = (typeof DECLASSIFIER_CATEGORIES)[number];

export type DeclassifiableSchemaPath =
  | "sourceFinding.schemaVersion"
  | "sourceFinding.category"
  | "sourceFinding.severity"
  | "sourceFinding.status"
  | "sourceFinding.confidence"
  | "sourceFinding.productionBlocker"
  | `sourceFinding.locations[${number}].path`
  | `sourceFinding.locations[${number}].lineRange`
  | `sourceFinding.evidence[${number}].id`
  | "sourceFinding.sourceFindingId";

const proofBrand: unique symbol = Symbol("declassification-proof");

export interface DeclassificationProof<Value = unknown> {
  readonly category: DeclassifierCategory;
  readonly value: Value;
  readonly property: string;
  readonly [proofBrand]: true;
}

export interface Declassified<Value> {
  readonly value: Value;
  readonly trust: FieldTrust;
  readonly proof: Pick<DeclassificationProof<Value>, "category" | "property">;
}

const FIELD_DECLASSIFIERS: Readonly<Record<string, DeclassifierCategory>> = Object.freeze({
  "sourceFinding.schemaVersion": "bounded_number",
  "sourceFinding.category": "schema_enum",
  "sourceFinding.severity": "schema_enum",
  "sourceFinding.status": "schema_enum",
  "sourceFinding.confidence": "bounded_number",
  "sourceFinding.productionBlocker": "boolean",
  "sourceFinding.locations[].path": "snapshot_path",
  "sourceFinding.locations[].lineRange": "line_range",
  "sourceFinding.evidence[].id": "evidence_id",
  "sourceFinding.sourceFindingId": "orchestrator_id",
});

const NEVER_DECLASSIFIABLE: readonly (readonly [RegExp, string])[] = Object.freeze([
  [/^sourceFinding\.title$/u, "finding_title"],
  [/^sourceFinding\.problem$/u, "problem_description"],
  [/^sourceFinding\.evidence\[\]\.text$/u, "evidence_quotation"],
  [/^sourceFinding\.recommendedFix$/u, "remediation_prose"],
  [/^task\.implementationGuidance(?:\[\])?$/u, "implementation_guidance"],
  [/^plan\.criticRationale$/u, "critic_rationale"],
  [/^plan\.plannerRationale$/u, "planner_rationale"],
]);

export function declassify<Value>(
  field: DeclassifiableSchemaPath,
  value: Value,
  proof: DeclassificationProof<Value>,
  trust: FieldTrust,
): Declassified<Value> {
  const normalized = normalizeSchemaPath(field);
  const forbiddenReason = NEVER_DECLASSIFIABLE.find(([pattern]) => pattern.test(normalized))?.[1];
  if (forbiddenReason !== undefined) {
    throw new Error(`FREE_TEXT_NEVER_DECLASSIFIABLE: ${forbiddenReason}`);
  }
  const expected = FIELD_DECLASSIFIERS[normalized];
  if (expected === undefined) {
    throw new Error(`NO_REGISTERED_DECLASSIFIER: ${normalized}`);
  }
  if (proof.category !== expected) {
    throw new Error(`DECLASSIFIER_PROOF_MISMATCH: expected ${expected}, received ${proof.category}`);
  }
  if (proof[proofBrand] !== true) {
    throw new Error("UNREGISTERED_DECLASSIFIER_PROOF: proof was not issued by this registry");
  }
  if (!Object.is(proof.value, value)) {
    throw new Error("DECLASSIFIER_VALUE_MISMATCH: proof was issued for a different value");
  }
  if (trust.controlClass !== "data") {
    throw new Error(`CONTROL_CLASS_NOT_DECLASSIFIABLE: ${trust.controlClass}`);
  }

  return Object.freeze({
    value,
    trust: Object.freeze({ ...trust, taint: CLEAN_TAINT }),
    proof: Object.freeze({ category: proof.category, property: proof.property }),
  });
}

export function proveSchemaEnum<Value extends string>(
  value: Value,
  allowedValues: readonly Value[],
): DeclassificationProof<Value> {
  if (!allowedValues.includes(value)) throw new Error("ENUM_VALUE_NOT_IN_SCHEMA");
  return proof("schema_enum", value, "value is a member of the closed schema enum");
}

export function proveBoolean(value: boolean): DeclassificationProof<boolean> {
  if (typeof value !== "boolean") throw new Error("VALUE_IS_NOT_BOOLEAN");
  return proof("boolean", value, "value is boolean");
}

export function proveBoundedNumber(
  value: number,
  bounds: { readonly minimum: number; readonly maximum: number },
): DeclassificationProof<number> {
  if (
    !Number.isFinite(bounds.minimum)
    || !Number.isFinite(bounds.maximum)
    || bounds.minimum > bounds.maximum
    || !Number.isFinite(value)
    || value < bounds.minimum
    || value > bounds.maximum
  ) {
    throw new Error("NUMBER_OUTSIDE_PROVEN_BOUNDS");
  }
  return proof("bounded_number", value, `value is within [${bounds.minimum}, ${bounds.maximum}]`);
}

export function proveSnapshotPath(
  value: string,
  snapshotPaths: ReadonlySet<string>,
): DeclassificationProof<string> {
  if (!snapshotPaths.has(value)) throw new Error("PATH_NOT_IN_IMMUTABLE_SNAPSHOT");
  return proof("snapshot_path", value, "path exists in the immutable snapshot as evidence only");
}

export interface LineRange {
  readonly startLine: number;
  readonly endLine: number;
}

export function proveLineRange(value: LineRange, actualLineCount: number): DeclassificationProof<LineRange> {
  if (
    !Number.isInteger(actualLineCount)
    || actualLineCount < 0
    ||
    !Number.isInteger(value.startLine)
    || !Number.isInteger(value.endLine)
    || value.startLine < 1
    || value.endLine < value.startLine
    || value.endLine > actualLineCount
  ) {
    throw new Error("LINE_RANGE_OUTSIDE_ACTUAL_FILE");
  }
  return proof("line_range", value, `range falls inside a ${actualLineCount}-line file`);
}

export function proveEvidenceId(
  value: string,
  knownArtifactIds: ReadonlySet<string>,
): DeclassificationProof<string> {
  if (!knownArtifactIds.has(value)) throw new Error("EVIDENCE_ID_DOES_NOT_RESOLVE");
  return proof("evidence_id", value, "evidence ID resolves to a known artifact");
}

export function proveOrchestratorId(
  value: string,
  generatedIds: ReadonlySet<string>,
): DeclassificationProof<string> {
  if (!generatedIds.has(value)) throw new Error("ID_NOT_ORCHESTRATOR_GENERATED");
  return proof("orchestrator_id", value, "ID is present in the orchestrator-issued registry");
}

function proof<Value>(
  category: DeclassifierCategory,
  value: Value,
  property: string,
): DeclassificationProof<Value> {
  return Object.freeze({ category, value, property, [proofBrand]: true });
}
