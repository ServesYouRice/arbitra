import { createHash } from "node:crypto";

export type CanonicalSerialiser = (value: unknown) => string;

/** Builds a retry-independent identity from logical, rather than attempt, inputs. */
export function activityId(
  runId: string,
  nodeId: string,
  operationKind: string,
  logicalInput: unknown,
  promptHash?: string,
  serialise: CanonicalSerialiser = canonicalIdentityJson,
): string {
  const identity = [runId, nodeId, operationKind, serialise(logicalInput), promptHash ?? null];
  return createHash("sha256").update(canonicalIdentityJson(identity)).digest("hex");
}

// Kept private so callers can inject persistence's canonicalJson without coupling the
// core project to a sibling source tree. This covers identity inputs only.
function canonicalIdentityJson(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Activity identity contains a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (Array.isArray(value)) {
    const values: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new TypeError("Activity identity contains an array hole");
      values.push(canonicalIdentityJson(value[index]));
    }
    return `[${values.join(",")}]`;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Activity identity contains a non-JSON object");
    }
    const object = value as Record<string, unknown>;
    const entries = Object.keys(object).map((originalKey) => ({
      key: originalKey.normalize("NFC"),
      value: object[originalKey],
    })).sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
    for (let index = 1; index < entries.length; index += 1) {
      if (entries[index - 1]?.key === entries[index]?.key) {
        throw new TypeError("Activity identity contains colliding Unicode keys");
      }
    }
    return `{${entries.map(({ key, value: item }) => (
      `${JSON.stringify(key)}:${canonicalIdentityJson(item)}`
    )).join(",")}}`;
  }
  throw new TypeError("Activity identity contains a value that JSON cannot represent");
}
