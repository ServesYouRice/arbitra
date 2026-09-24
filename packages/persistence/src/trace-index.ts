import { createHash } from "node:crypto";
import { open, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ModelActivityTraceRecord, TraceOutcome } from "@arbitra/schemas/model-trace.js";

import { parseTraceLine, TRACE_LOG_FILE, traceDirectory } from "./trace.js";

/**
 * Persistent per-run query index over the committed model-activity trace log.
 *
 * The JSONL log stays authoritative. The index stores only byte ranges and filter columns
 * for newline-terminated (committed) lines; every served record is re-read from the log,
 * parsed, validated and compared with its index row. A stale, truncated, replaced or
 * corrupt index is discarded and rebuilt from the log. Trace IDs are positions among the
 * committed non-empty lines, exactly as `loadActivityTraces` assigns them.
 */
export const TRACE_INDEX_FILE = "model-activity.index.db";
const FORMAT = "arbitra-trace-index/1";
const CHUNK_BYTES = 1 << 20;
const NEWLINE = 0x0a;

export interface TraceIndexFilter {
  readonly nodeId?: string | undefined;
  readonly modelId?: string | undefined;
  readonly protocolId?: string | undefined;
  readonly outcome?: TraceOutcome | undefined;
  readonly activity?: string | undefined;
}
export interface IndexedTrace { readonly traceId: number; readonly trace: ModelActivityTraceRecord }
export interface TraceIndexFacets { readonly nodeIds: readonly string[]; readonly modelIds: readonly string[]; readonly protocolIds: readonly string[] }
export interface TraceIndexPage { readonly entries: readonly IndexedTrace[]; readonly total: number; readonly facets: TraceIndexFacets }
export interface TraceIndexObserver {
  /** Bytes read from the authoritative log (catch-up, prefix verification and served records). */
  logBytesRead?(bytes: number): void;
  /** The persisted index was discarded; `reason` says why. */
  reset?(reason: string): void;
}
export interface TraceIndexOptions { readonly observer?: TraceIndexObserver | undefined }
export interface TraceIndexRebuild { readonly traceCount: number; readonly committedBytes: number }

export class TraceIndexCorruptError extends Error {
  constructor(reason: string) { super(`TRACE_INDEX_CORRUPT:${reason}`); this.name = "TraceIndexCorruptError"; }
}

export function traceIndexPath(runsDirectory: string, runId: string): string {
  return join(traceDirectory(runsDirectory, runId), TRACE_INDEX_FILE);
}

/** One filtered page in log order; `offset` counts matching traces, not trace IDs. */
export async function queryTraceIndex(runsDirectory: string, runId: string, filter: TraceIndexFilter,
  offset: number, limit: number, options: TraceIndexOptions = {}): Promise<TraceIndexPage> {
  return withIndex(runsDirectory, runId, options, async (session) => {
    if (session === null) return { entries: [], total: 0, facets: { nodeIds: [], modelIds: [], protocolIds: [] } };
    const { database, meta } = session;
    const clauses: string[] = []; const parameters: (string | bigint)[] = [];
    for (const [column, value] of [["node_id", filter.nodeId], ["model_id", filter.modelId],
      ["protocol_id", filter.protocolId], ["outcome", filter.outcome]] as const) {
      if (value !== undefined) { clauses.push(`${column} = ?`); parameters.push(value); }
    }
    if (filter.activity !== undefined) { clauses.push("instr(activity_id, ?) > 0"); parameters.push(filter.activity); }
    let total: number; let rows: readonly IndexRow[];
    if (clauses.length === 0) {
      // IDs are dense 0..count-1, so an unfiltered page seeks directly to its first ID.
      total = meta.traceCount;
      rows = offset >= total ? [] : database.prepare(`SELECT ${ROW_COLUMNS} FROM traces WHERE trace_id >= ? ORDER BY trace_id LIMIT ?`)
        .all(BigInt(offset), BigInt(limit)) as unknown as IndexRow[];
    } else {
      const where = clauses.join(" AND ");
      total = Number((database.prepare(`SELECT count(*) AS total FROM traces WHERE ${where}`).get(...parameters) as { total: number }).total);
      rows = offset >= total ? [] : database.prepare(`SELECT ${ROW_COLUMNS} FROM traces WHERE ${where} ORDER BY trace_id LIMIT ? OFFSET ?`)
        .all(...parameters, BigInt(limit), BigInt(offset)) as unknown as IndexRow[];
    }
    const entries: IndexedTrace[] = [];
    for (const row of rows) {
      const entry = await session.read(row);
      if (!matches(entry.trace, filter)) throw new TraceIndexCorruptError("FILTER_MISMATCH");
      entries.push(entry);
    }
    return { entries, total, facets: facets(database) };
  });
}

/** The committed trace at a stable ID, or `undefined` when no such committed trace exists. */
export async function readIndexedTrace(runsDirectory: string, runId: string, traceId: number,
  options: TraceIndexOptions = {}): Promise<IndexedTrace | undefined> {
  if (!Number.isSafeInteger(traceId) || traceId < 0) return undefined;
  return withIndex(runsDirectory, runId, options, async (session) => {
    if (session === null || traceId >= session.meta.traceCount) return undefined;
    const row = session.database.prepare(`SELECT ${ROW_COLUMNS} FROM traces WHERE trace_id = ?`).get(BigInt(traceId)) as IndexRow | undefined;
    if (row === undefined) throw new TraceIndexCorruptError("MISSING_ROW");
    return session.read(row);
  });
}

/** Discards the derived index and rebuilds it from the committed log. */
export async function rebuildTraceIndex(runsDirectory: string, runId: string, options: TraceIndexOptions = {}): Promise<TraceIndexRebuild> {
  const path = traceIndexPath(runsDirectory, runId);
  return exclusive(path, async () => {
    await removeIndex(path);
    return run(runsDirectory, runId, options, async (session) => ({
      traceCount: session?.meta.traceCount ?? 0, committedBytes: session?.meta.committedBytes ?? 0 }));
  });
}

interface Meta {
  readonly committedBytes: number; readonly traceCount: number;
  readonly firstOffset: number; readonly firstLength: number; readonly firstHash: string;
  readonly lastOffset: number; readonly lastLength: number; readonly lastHash: string;
}
interface IndexRow {
  readonly trace_id: number; readonly byte_offset: number; readonly byte_length: number;
  readonly node_id: string; readonly model_id: string; readonly protocol_id: string; readonly outcome: string; readonly activity_id: string;
}
interface Session { readonly database: DatabaseSync; readonly meta: Meta; read(row: IndexRow): Promise<IndexedTrace> }

const ROW_COLUMNS = "trace_id, byte_offset, byte_length, node_id, model_id, protocol_id, outcome, activity_id";
const EMPTY_META: Meta = { committedBytes: 0, traceCount: 0, firstOffset: 0, firstLength: 0, firstHash: "", lastOffset: 0, lastLength: 0, lastHash: "" };

const locks = new Map<string, Promise<unknown>>();
async function exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  const settled = current.then(() => undefined, () => undefined);
  locks.set(key, settled);
  try { return await current; } finally { if (locks.get(key) === settled) locks.delete(key); }
}

async function withIndex<T>(runsDirectory: string, runId: string, options: TraceIndexOptions,
  operation: (session: Session | null) => Promise<T>): Promise<T> {
  const path = traceIndexPath(runsDirectory, runId);
  return exclusive(path, async () => {
    try { return await run(runsDirectory, runId, options, operation); }
    catch (error) {
      if (isLogError(error)) throw error;
      // The index is a cache: any failure attributable to it is repaired from the log once.
      options.observer?.reset?.(error instanceof Error ? error.message : "UNKNOWN");
      await removeIndex(path);
      return run(runsDirectory, runId, options, operation);
    }
  });
}

async function run<T>(runsDirectory: string, runId: string, options: TraceIndexOptions,
  operation: (session: Session | null) => Promise<T>): Promise<T> {
  const directory = traceDirectory(runsDirectory, runId);
  let handle: FileHandle;
  try { handle = await open(join(directory, TRACE_LOG_FILE), "r"); }
  catch (error) { if (hasCode(error, "ENOENT")) return operation(null); throw error; }
  try {
    const size = (await handle.stat()).size;
    const observer = options.observer;
    const readRange = async (position: number, length: number): Promise<Buffer> => {
      const buffer = Buffer.alloc(length);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      observer?.logBytesRead?.(filled);
      return filled === length ? buffer : buffer.subarray(0, filled);
    };
    const database = new DatabaseSync(join(directory, TRACE_INDEX_FILE));
    try {
      database.exec("PRAGMA busy_timeout = 5000");
      initialise(database, runId);
      const meta = await synchronise(database, runId, size, readRange, observer);
      return await operation({ database, meta, read: async (row) => {
        // Read the preceding byte too, so a row that does not start on a line boundary is rejected.
        const start = row.byte_offset === 0 ? 0 : row.byte_offset - 1;
        const bytes = await readRange(start, row.byte_offset + row.byte_length - start);
        if (row.byte_offset + row.byte_length > meta.committedBytes || bytes.length !== row.byte_offset + row.byte_length - start
          || (row.byte_offset > 0 && bytes[0] !== NEWLINE) || bytes.at(-1) !== NEWLINE) throw new TraceIndexCorruptError("ROW_RANGE");
        const trace = parseTraceLine(bytes.subarray(row.byte_offset - start, bytes.length - 1).toString("utf8"), runId, row.trace_id);
        if (trace.nodeId !== row.node_id || trace.modelId !== row.model_id || trace.protocolId !== row.protocol_id
          || trace.outcome !== row.outcome || trace.activityId !== row.activity_id) throw new TraceIndexCorruptError("ROW_COLUMNS");
        return { traceId: row.trace_id, trace };
      } });
    } finally { database.close(); }
  } finally { await handle.close(); }
}

function initialise(database: DatabaseSync, runId: string): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      id INTEGER PRIMARY KEY CHECK (id = 0), format TEXT NOT NULL, run_id TEXT NOT NULL,
      committed_bytes INTEGER NOT NULL, trace_count INTEGER NOT NULL,
      first_offset INTEGER NOT NULL, first_length INTEGER NOT NULL, first_hash TEXT NOT NULL,
      last_offset INTEGER NOT NULL, last_length INTEGER NOT NULL, last_hash TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS traces (
      trace_id INTEGER PRIMARY KEY, byte_offset INTEGER NOT NULL, byte_length INTEGER NOT NULL,
      node_id TEXT NOT NULL, model_id TEXT NOT NULL, protocol_id TEXT NOT NULL, outcome TEXT NOT NULL, activity_id TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS traces_node ON traces(node_id, trace_id);
    CREATE INDEX IF NOT EXISTS traces_model ON traces(model_id, trace_id);
    CREATE INDEX IF NOT EXISTS traces_protocol ON traces(protocol_id, trace_id);
    CREATE INDEX IF NOT EXISTS traces_outcome ON traces(outcome, trace_id);
    CREATE TABLE IF NOT EXISTS facets (kind TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (kind, value)) STRICT, WITHOUT ROWID;
  `);
  const select = database.prepare("SELECT format, run_id FROM meta WHERE id = 0");
  let row = select.get() as { format: string; run_id: string } | undefined;
  if (row === undefined) {
    database.prepare(`INSERT OR IGNORE INTO meta VALUES (0, ?, ?, 0, 0, 0, 0, '', 0, 0, '')`).run(FORMAT, runId);
    row = select.get() as { format: string; run_id: string } | undefined;
  }
  if (row?.format !== FORMAT || row.run_id !== runId) throw new TraceIndexCorruptError("FORMAT");
}

function readMeta(database: DatabaseSync): Meta {
  const row = database.prepare(`SELECT committed_bytes, trace_count, first_offset, first_length, first_hash,
    last_offset, last_length, last_hash FROM meta WHERE id = 0`).get() as Record<string, number | string> | undefined;
  if (row === undefined) throw new TraceIndexCorruptError("META");
  const meta: Meta = { committedBytes: Number(row["committed_bytes"]), traceCount: Number(row["trace_count"]),
    firstOffset: Number(row["first_offset"]), firstLength: Number(row["first_length"]), firstHash: String(row["first_hash"]),
    lastOffset: Number(row["last_offset"]), lastLength: Number(row["last_length"]), lastHash: String(row["last_hash"]) };
  const maximum = (database.prepare("SELECT max(trace_id) AS maximum FROM traces").get() as { maximum: number | null }).maximum;
  if ((maximum === null ? 0 : Number(maximum) + 1) !== meta.traceCount) throw new TraceIndexCorruptError("COUNT");
  return meta;
}

async function synchronise(database: DatabaseSync, runId: string, size: number,
  readRange: (position: number, length: number) => Promise<Buffer>, observer: TraceIndexObserver | undefined): Promise<Meta> {
  let meta = readMeta(database);
  const stale = meta.committedBytes > size ? "LOG_SHORTER_THAN_INDEX"
    : meta.traceCount > 0 && (hash(await readRange(meta.firstOffset, meta.firstLength)) !== meta.firstHash
      || hash(await readRange(meta.lastOffset, meta.lastLength)) !== meta.lastHash) ? "LOG_PREFIX_CHANGED" : null;
  if (stale !== null) {
    observer?.reset?.(stale);
    transaction(database, () => {
      database.exec("DELETE FROM traces; DELETE FROM facets;");
      database.prepare(`UPDATE meta SET committed_bytes = 0, trace_count = 0, first_offset = 0, first_length = 0, first_hash = '',
        last_offset = 0, last_length = 0, last_hash = '' WHERE id = 0`).run();
    });
    meta = EMPTY_META;
  }
  const insert = database.prepare("INSERT INTO traces VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const facet = database.prepare("INSERT OR IGNORE INTO facets VALUES (?, ?)");
  const advance = database.prepare(`UPDATE meta SET committed_bytes = ?, trace_count = ?, first_offset = ?, first_length = ?, first_hash = ?,
    last_offset = ?, last_length = ?, last_hash = ? WHERE id = 0`);
  while (meta.committedBytes < size) {
    // Grow the window until it holds at least one complete line; bytes after the last newline are an uncommitted tail.
    let window = Math.min(CHUNK_BYTES, size - meta.committedBytes);
    let bytes = await readRange(meta.committedBytes, window);
    while (bytes.lastIndexOf(NEWLINE) < 0 && meta.committedBytes + window < size) {
      window = Math.min(window * 2, size - meta.committedBytes);
      bytes = await readRange(meta.committedBytes, window);
    }
    const end = bytes.lastIndexOf(NEWLINE) + 1;
    if (end === 0) break;
    const rows: { traceId: number; offset: number; length: number; bytes: Buffer; trace: ModelActivityTraceRecord }[] = [];
    let traceId = meta.traceCount;
    for (let start = 0; start < end;) {
      const stop = bytes.indexOf(NEWLINE, start) + 1;
      if (stop - start > 1) {
        const line = bytes.subarray(start, stop);
        rows.push({ traceId, offset: meta.committedBytes + start, length: stop - start, bytes: line,
          trace: parseTraceLine(line.subarray(0, line.length - 1).toString("utf8"), runId, traceId) });
        traceId += 1;
      }
      start = stop;
    }
    const expected = meta.committedBytes;
    const first = meta.traceCount === 0 ? rows[0] : undefined;
    const last = rows.at(-1);
    const next: Meta = {
      committedBytes: expected + end, traceCount: traceId,
      firstOffset: first?.offset ?? meta.firstOffset, firstLength: first?.length ?? meta.firstLength,
      firstHash: first === undefined ? meta.firstHash : hash(first.bytes),
      lastOffset: last?.offset ?? meta.lastOffset, lastLength: last?.length ?? meta.lastLength,
      lastHash: last === undefined ? meta.lastHash : hash(last.bytes),
    };
    const advanced = transaction(database, () => {
      // Another process may have indexed this range first; only extend the exact prefix we read from.
      if (Number((database.prepare("SELECT committed_bytes AS bytes FROM meta WHERE id = 0").get() as { bytes: number }).bytes) !== expected) return false;
      for (const { traceId: id, offset, length, trace } of rows) {
        insert.run(BigInt(id), BigInt(offset), BigInt(length), trace.nodeId, trace.modelId, trace.protocolId, trace.outcome, trace.activityId);
        facet.run("node", trace.nodeId); facet.run("model", trace.modelId); facet.run("protocol", trace.protocolId);
      }
      advance.run(BigInt(next.committedBytes), BigInt(next.traceCount), BigInt(next.firstOffset), BigInt(next.firstLength), next.firstHash,
        BigInt(next.lastOffset), BigInt(next.lastLength), next.lastHash);
      return true;
    });
    meta = advanced ? next : readMeta(database);
  }
  return meta;
}

function facets(database: DatabaseSync): TraceIndexFacets {
  const values: Record<string, string[]> = { node: [], model: [], protocol: [] };
  for (const { kind, value } of database.prepare("SELECT kind, value FROM facets").all() as { kind: string; value: string }[]) values[kind]?.push(value);
  // JavaScript code-unit order, matching the full-scan implementation rather than SQLite's byte order.
  return { nodeIds: (values["node"] ?? []).sort(), modelIds: (values["model"] ?? []).sort(), protocolIds: (values["protocol"] ?? []).sort() };
}

function matches(trace: ModelActivityTraceRecord, filter: TraceIndexFilter): boolean {
  return (filter.nodeId === undefined || trace.nodeId === filter.nodeId)
    && (filter.modelId === undefined || trace.modelId === filter.modelId)
    && (filter.protocolId === undefined || trace.protocolId === filter.protocolId)
    && (filter.outcome === undefined || trace.outcome === filter.outcome)
    && (filter.activity === undefined || trace.activityId.includes(filter.activity));
}

function transaction<T>(database: DatabaseSync, body: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try { const result = body(); database.exec("COMMIT"); return result; }
  catch (error) { database.exec("ROLLBACK"); throw error; }
}

async function removeIndex(path: string): Promise<void> {
  await Promise.all(["", "-journal", "-wal", "-shm"].map((suffix) => rm(`${path}${suffix}`, { force: true })));
}

/** Errors that describe the authoritative log itself; rebuilding the index cannot fix them. */
function isLogError(error: unknown): boolean {
  return error instanceof SyntaxError || (error instanceof Error && (error.message === "TRACE_RUN_ID_MISMATCH"
    || error.message.startsWith("INVALID_MODEL_ACTIVITY_TRACE") || error.message === "INVALID_TRACE_RUN_ID"));
}
function hash(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
