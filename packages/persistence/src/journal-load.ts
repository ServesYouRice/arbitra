import { readFile, truncate } from "node:fs/promises";

import type { ArtifactRef } from "./artifact-store.js";
import type { JournalRecord } from "./journal.js";

export interface JournalLoadFileSystem {
  readFile(path: string): Promise<Uint8Array>;
  truncate(path: string, length: number): Promise<void>;
}

export interface LoadedJournal {
  readonly records: readonly JournalRecord[];
  readonly truncatedBytes: number;
}

export interface JournalProjection {
  readonly completed: ReadonlyMap<string, ArtifactRef>;
  readonly attempts: ReadonlyMap<string, number>;
}

const nodeFileSystem: JournalLoadFileSystem = { readFile, truncate };

export async function loadJournal(
  path: string,
  fileSystem: JournalLoadFileSystem = nodeFileSystem,
): Promise<LoadedJournal> {
  let bytes: Uint8Array;
  try {
    bytes = await fileSystem.readFile(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return { records: [], truncatedBytes: 0 };
    throw error;
  }

  const lastNewline = bytes.lastIndexOf(0x0a);
  const retainedLength = lastNewline < 0 ? 0 : lastNewline + 1;
  const truncatedBytes = bytes.byteLength - retainedLength;
  if (truncatedBytes > 0) await fileSystem.truncate(path, retainedLength);

  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, retainedLength));
  const lines = text.split("\n");
  lines.pop();
  const records = lines.map((line, index) => parseRecord(line, index + 1));
  return { records, truncatedBytes };
}

export function projectJournal(records: readonly JournalRecord[]): JournalProjection {
  const completed = new Map<string, ArtifactRef>();
  const attempts = new Map<string, number>();
  for (const record of records) {
    if (record.t === "attempt_start") {
      attempts.set(record.id, Math.max(attempts.get(record.id) ?? 0, record.attempt));
    } else if (record.t === "end") {
      completed.set(record.id, record.artifact);
    }
  }
  return { completed, attempts };
}

function parseRecord(line: string, lineNumber: number): JournalRecord {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch (error) {
    throw new SyntaxError(`Invalid journal JSON at complete line ${lineNumber}`, { cause: error });
  }
  if (!isRecord(value)) throw new TypeError(`Invalid journal record at line ${lineNumber}`);
  return value;
}

function isRecord(value: unknown): value is JournalRecord {
  if (!isObject(value) || typeof value.id !== "string" || !isAttempt(value.attempt)) return false;
  if (value.t === "attempt_start") {
    return value.providerRequestId === undefined || typeof value.providerRequestId === "string";
  }
  if (value.t === "attempt_error") return typeof value.error === "string";
  return value.t === "end"
    && value.ok === true
    && isUsage(value.usage)
    && isArtifactRef(value.artifact);
}

function isArtifactRef(value: unknown): value is ArtifactRef {
  return isObject(value)
    && typeof value.hash === "string"
    && typeof value.byteLength === "number"
    && typeof value.extension === "string"
    && typeof value.relativePath === "string";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAttempt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isUsage(value: unknown): value is Readonly<Record<string, number>> | null {
  return value === null || (isObject(value) && Object.values(value).every((item) => (
    typeof item === "number" && Number.isFinite(item)
  )));
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isObject(error) && error.code === code;
}
