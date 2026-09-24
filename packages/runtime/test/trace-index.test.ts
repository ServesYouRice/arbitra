import { appendFile, mkdtemp, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "@arbitra/persistence/canonical-json.js";
import { rebuildTraceIndex, traceIndexPath, type TraceIndexObserver } from "@arbitra/persistence/trace-index.js";
import { loadActivityTraces, TraceRecorder, traceDirectory } from "@arbitra/persistence/trace.js";

import { indexedTraceEntry, indexedTracePage, traceEntry, tracePage } from "../src/trace-browser.js";
import { browserQueries, syntheticTrace } from "./trace-fixture.js";

const RUN = "run-1";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function root(): Promise<string> { const path = await mkdtemp(join(tmpdir(), "arbitra-trace-index-")); roots.push(path); return path; }
function logPath(runs: string): string { return join(traceDirectory(runs, RUN), "model-activity.jsonl"); }
async function record(runs: string, from: number, to: number, recorder = new TraceRecorder(runs)): Promise<void> {
  for (let index = from; index < to; index += 1) await recorder.record(syntheticTrace(RUN, index));
}
function observed(): { observer: TraceIndexObserver; resets: string[]; bytes: () => number } {
  const resets: string[] = []; let bytes = 0;
  return { observer: { reset: (reason) => resets.push(reason), logBytesRead: (count) => { bytes += count; } }, resets, bytes: () => bytes };
}

/** Every browser query and every ID lookup agrees between the index and a full journal scan. */
async function expectAgreement(runs: string, observer?: TraceIndexObserver): Promise<number> {
  const journal = await loadActivityTraces(runs, RUN);
  for (const query of browserQueries(journal.length)) {
    expect(await indexedTracePage(runs, RUN, query, { observer }), JSON.stringify(query)).toEqual(tracePage(journal, query));
  }
  for (let id = 0; id < journal.length; id += 1) {
    expect(await indexedTraceEntry(runs, RUN, String(id), { observer })).toEqual(traceEntry(journal, String(id)));
  }
  await expect(indexedTraceEntry(runs, RUN, String(journal.length), { observer })).rejects.toMatchObject({ message: "TRACE_ABSENT", statusCode: 404 });
  await expect(indexedTraceEntry(runs, RUN, "01", { observer })).rejects.toMatchObject({ message: "INVALID_TRACE_ID", statusCode: 400 });
  return journal.length;
}

describe("persistent trace index agrees with the authoritative journal", () => {
  it("serves an absent log as an empty history without creating an index", async () => {
    const runs = await root();
    expect(await expectAgreement(runs)).toBe(0);
    await expect(stat(traceIndexPath(runs, RUN))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("agrees across filters and pagination after appends and a restart, extending incrementally", async () => {
    const runs = await root();
    await record(runs, 0, 60);
    const first = observed();
    expect(await expectAgreement(runs, first.observer)).toBe(60);
    expect(first.resets).toEqual([]);

    // A different recorder instance models a restarted writer; the persisted index is reused and extended.
    await record(runs, 60, 90);
    const second = observed();
    expect(await expectAgreement(runs, second.observer)).toBe(90);
    expect(second.resets).toEqual([]);
    const size = (await stat(logPath(runs))).size;
    const warm = observed();
    await indexedTracePage(runs, RUN, { limit: 5, offset: 40 }, { observer: warm.observer });
    // Only the verified first/last lines and the five served lines are read — not the log.
    expect(warm.bytes()).toBeLessThan(size / 5);
  });

  it("never serves a torn tail and agrees once a restarted writer repairs it", async () => {
    const runs = await root();
    await record(runs, 0, 20);
    await appendFile(logPath(runs), '{"schemaVersion":1,"runId":"run-1","activityId":"torn');
    expect(await expectAgreement(runs)).toBe(20);
    expect((await indexedTracePage(runs, RUN, { offset: 19 })).nextOffset).toBeNull();

    await record(runs, 20, 30, new TraceRecorder(runs));
    const repaired = observed();
    expect(await expectAgreement(runs, repaired.observer)).toBe(30);
    expect(repaired.resets).toEqual([]);

    // A tail that becomes committed by completing its line is indexed then, not before.
    const line = canonicalJson(syntheticTrace(RUN, 30));
    await appendFile(logPath(runs), line.slice(0, 40));
    expect(await expectAgreement(runs)).toBe(30);
    await appendFile(logPath(runs), `${line.slice(40)}\n`);
    expect(await expectAgreement(runs)).toBe(31);
  });

  it("agrees after explicit rebuild, index deletion and index corruption", async () => {
    const runs = await root();
    await record(runs, 0, 40);
    expect(await expectAgreement(runs)).toBe(40);
    expect(await rebuildTraceIndex(runs, RUN)).toEqual({ traceCount: 40, committedBytes: (await stat(logPath(runs))).size });
    expect(await expectAgreement(runs)).toBe(40);

    await rm(traceIndexPath(runs, RUN));
    expect(await expectAgreement(runs)).toBe(40);

    await writeFile(traceIndexPath(runs, RUN), "not a sqlite database");
    const garbage = observed();
    expect(await expectAgreement(runs, garbage.observer)).toBe(40);
    expect(garbage.resets.length).toBeGreaterThan(0);

    for (const tamper of ["UPDATE traces SET node_id = 'critic' WHERE trace_id = 0",
      "UPDATE traces SET byte_offset = byte_offset + 3 WHERE trace_id = 7",
      "DELETE FROM traces WHERE trace_id = 39",
      "UPDATE meta SET format = 'other'"]) {
      const database = new DatabaseSync(traceIndexPath(runs, RUN));
      database.exec(tamper); database.close();
      const detected = observed();
      expect(await expectAgreement(runs, detected.observer), tamper).toBe(40);
      expect(detected.resets.length, tamper).toBeGreaterThan(0);
    }
  });

  it("detects a truncated or replaced log and re-derives positions from the journal", async () => {
    const runs = await root();
    await record(runs, 0, 30);
    expect(await expectAgreement(runs)).toBe(30);
    const size = (await stat(logPath(runs))).size;
    await truncate(logPath(runs), Math.floor(size / 2));
    const shorter = observed();
    expect(await expectAgreement(runs, shorter.observer)).toBeLessThan(30);
    expect(shorter.resets).toContain("LOG_SHORTER_THAN_INDEX");

    // Same run, different history of greater length: stale positions must not be reused.
    const replacement = Array.from({ length: 40 }, (_, index) => `${canonicalJson(syntheticTrace(RUN, 1000 + index))}\n`).join("");
    await writeFile(logPath(runs), replacement);
    const replaced = observed();
    expect(await expectAgreement(runs, replaced.observer)).toBe(40);
    expect(replaced.resets).toContain("LOG_PREFIX_CHANGED");
  });

  it("surfaces an invalid committed record exactly like the journal loader", async () => {
    const runs = await root();
    await record(runs, 0, 5);
    await appendFile(logPath(runs), "{not json}\n");
    await expect(loadActivityTraces(runs, RUN)).rejects.toThrow("Invalid model trace JSON at line 6");
    await expect(indexedTracePage(runs, RUN, {})).rejects.toThrow("Invalid model trace JSON at line 6");
    await writeFile(logPath(runs), `${canonicalJson({ ...syntheticTrace(RUN, 0), runId: "other-run" })}\n`);
    await expect(loadActivityTraces(runs, RUN)).rejects.toThrow("TRACE_RUN_ID_MISMATCH");
    await expect(indexedTraceEntry(runs, RUN, "0")).rejects.toThrow("TRACE_RUN_ID_MISMATCH");
  });

  it("serialises concurrent queries and appends without diverging", async () => {
    const runs = await root();
    const recorder = new TraceRecorder(runs);
    await record(runs, 0, 10, recorder);
    await Promise.all([record(runs, 10, 40, recorder),
      ...Array.from({ length: 20 }, (_, index) => indexedTracePage(runs, RUN, { offset: index, limit: 3 }))]);
    expect(await expectAgreement(runs)).toBe(40);
  });
});
