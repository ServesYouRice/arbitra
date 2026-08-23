import { mkdir, open, readFile, rename, truncate, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalJson } from "./canonical-json.js";
import { DEFAULT_FSYNC_POLICY, fsync, type FsyncPolicy } from "./fsync.js";

export interface PersistedIssueOperation { readonly operationId: string; readonly candidateId: string; readonly authorId: string; readonly round: number; readonly type: string; readonly citedEvidenceIds: readonly string[]; readonly [key: string]: unknown }
export interface LoadedIssueOperations { readonly operations: readonly PersistedIssueOperation[]; readonly truncatedBytes: number }
const TYPES = new Set(["add_candidate", "add_missing_finding", "accept", "reject", "needs_verification", "merge", "split", "add_evidence", "add_counter_evidence", "change_severity", "change_blocker", "supplement_remediation", "supplement_verification"]);

export class IssueOperationLog {
  readonly path: string;
  constructor(runDirectory: string, private readonly fsyncPolicy: FsyncPolicy = DEFAULT_FSYNC_POLICY) { this.path = join(runDirectory, "issue-ops.jsonl"); }
  async append(operation: PersistedIssueOperation): Promise<void> {
    validate(operation, 0); await mkdir(dirname(this.path), { recursive: true }); const handle = await open(this.path, "a");
    try { await handle.write(new TextEncoder().encode(`${canonicalJson(operation)}\n`)); await fsync(handle, this.fsyncPolicy, "expensive"); } finally { await handle.close(); }
  }
  load(): Promise<LoadedIssueOperations> { return loadIssueOperations(this.path); }
}

export async function loadIssueOperations(path: string): Promise<LoadedIssueOperations> {
  let bytes: Uint8Array; try { bytes = await readFile(path); } catch (error) { if (hasCode(error, "ENOENT")) return { operations: [], truncatedBytes: 0 }; throw error; }
  const newline = bytes.lastIndexOf(0x0a); const retained = newline < 0 ? 0 : newline + 1; const truncatedBytes = bytes.byteLength - retained; if (truncatedBytes > 0) await truncate(path, retained);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, retained)); const lines = text.split("\n"); lines.pop();
  return Object.freeze({ operations: Object.freeze(lines.map((line, index) => { let value: unknown; try { value = JSON.parse(line) as unknown; } catch (error) { throw new SyntaxError(`Invalid issue operation JSON at complete line ${index + 1}`, { cause: error }); } validate(value, index + 1); return value; })), truncatedBytes });
}

export async function writeIssueBoardProjection(runDirectory: string, board: unknown): Promise<string> {
  const path = join(runDirectory, "projections", "issue-board.json"); const temporary = `${path}.tmp`; await mkdir(dirname(path), { recursive: true }); await writeFile(temporary, new TextEncoder().encode(`${canonicalJson(board)}\n`)); await rename(temporary, path); return path;
}
export async function rebuildIssueBoardProjection<T>(runDirectory: string, project: (operations: readonly PersistedIssueOperation[]) => T): Promise<T> {
  const loaded = await loadIssueOperations(join(runDirectory, "issue-ops.jsonl")); const board = project(loaded.operations); await writeIssueBoardProjection(runDirectory, board); return board;
}

function validate(value: unknown, line: number): asserts value is PersistedIssueOperation {
  if (typeof value !== "object" || value === null) throw new Error(`Invalid issue operation at line ${line}`); const item = value as Record<string, unknown>;
  if (typeof item.operationId !== "string" || item.operationId === "" || typeof item.candidateId !== "string" || item.candidateId === "" || typeof item.authorId !== "string" || item.authorId === "" || !Number.isSafeInteger(item.round) || (item.round as number) < 0 || typeof item.type !== "string" || !TYPES.has(item.type) || !Array.isArray(item.citedEvidenceIds) || !item.citedEvidenceIds.every((id) => typeof id === "string" && id !== "")) throw new Error(`Invalid issue operation at line ${line}`);
}
function hasCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
