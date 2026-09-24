import { mkdir, mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import { canonicalJson } from "@arbitra/persistence/canonical-json.js";
import { rebuildTraceIndex } from "@arbitra/persistence/trace-index.js";
import { loadActivityTraces, traceDirectory } from "@arbitra/persistence/trace.js";

import { indexedTraceEntry, indexedTracePage, tracePage } from "../src/trace-browser.js";
import { syntheticTrace } from "./trace-fixture.js";

/**
 * P17 trace-history benchmark. Opt-in: `pnpm --filter @arbitra/runtime bench:traces`
 * (ARBITRA_TRACE_BENCH=1, optional ARBITRA_TRACE_BENCH_SIZE, default 100 000 traces).
 *
 * Budget at the 100k-trace target, warm index, per browser request:
 *   p95 latency ≤ 50 ms for every measured page/detail shape, log bytes read ≤ 256 KiB,
 *   transient heap growth ≤ 16 MiB. The full-scan baseline is measured for contrast.
 */
const enabled = process.env["ARBITRA_TRACE_BENCH"] === "1";
const SIZE = Number(process.env["ARBITRA_TRACE_BENCH_SIZE"] ?? 100_000);
const RUN = "bench-run";
const BUDGET = { p95Ms: 50, logBytesPerRequest: 256 * 1024, heapBytes: 16 * 1024 * 1024 };

interface Measurement { readonly name: string; readonly medianMs: number; readonly p95Ms: number; readonly logBytes: number; readonly heapBytes: number }

describe.skipIf(!enabled)("trace index benchmark", () => {
  it(`meets the budget at ${SIZE} traces and avoids full-log reads per page`, async () => {
    const runs = await mkdtemp(join(tmpdir(), "arbitra-trace-bench-"));
    try {
      const directory = traceDirectory(runs, RUN);
      await mkdir(directory, { recursive: true });
      const log = await open(join(directory, "model-activity.jsonl"), "w");
      for (let start = 0; start < SIZE; start += 5_000) {
        let chunk = "";
        for (let index = start; index < Math.min(SIZE, start + 5_000); index += 1) chunk += `${canonicalJson(syntheticTrace(RUN, index))}\n`;
        await log.write(chunk);
      }
      await log.close();
      const logBytes = (await stat(join(directory, "model-activity.jsonl"))).size;

      const coldStart = performance.now();
      await rebuildTraceIndex(runs, RUN);
      const coldBuildMs = performance.now() - coldStart;
      const indexBytes = (await stat(join(directory, "model-activity.index.db"))).size;

      const shapes: readonly [string, Record<string, string | number> | string][] = [
        ["first page", {}], ["deep page", { offset: SIZE - 25 }], ["node filter", { nodeId: "critic", offset: 5_000 }],
        ["composed filter", { nodeId: "audit", outcome: "success", modelId: "model-a" }], ["activity substring", { activity: "batch-3/turn/1" }],
        ["max page", { limit: 100, offset: 50_000 % SIZE }], ["detail", String(SIZE - 1)],
      ];
      const indexed: Measurement[] = [];
      for (const [name, query] of shapes) {
        indexed.push(await measure(`indexed ${name}`, 40, (observer) => typeof query === "string"
          ? indexedTraceEntry(runs, RUN, query, { observer }) : indexedTracePage(runs, RUN, query, { observer })));
      }
      const baseline: Measurement[] = [];
      for (const [name, query] of shapes.slice(0, 3)) {
        baseline.push(await measure(`full scan ${name}`, 5, async (observer) => {
          const traces = await loadActivityTraces(runs, RUN);
          observer.logBytesRead?.(logBytes);
          return tracePage(traces, query);
        }));
      }
      const report = { traces: SIZE, logBytes, indexBytes, coldBuildMs: round(coldBuildMs), budget: BUDGET, indexed, baseline };
      console.log(`P17 trace index benchmark\n${JSON.stringify(report, null, 2)}`);

      for (const measurement of indexed) {
        expect(measurement.p95Ms, measurement.name).toBeLessThanOrEqual(BUDGET.p95Ms);
        expect(measurement.logBytes, measurement.name).toBeLessThanOrEqual(BUDGET.logBytesPerRequest);
        expect(measurement.heapBytes, measurement.name).toBeLessThanOrEqual(BUDGET.heapBytes);
      }
    } finally { await rm(runs, { recursive: true, force: true }); }
  }, 600_000);
});

async function measure(name: string, iterations: number,
  request: (observer: { logBytesRead?(bytes: number): void }) => Promise<unknown>): Promise<Measurement> {
  await request({});
  const samples: number[] = []; let logBytes = 0; let heapBytes = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    (globalThis as { gc?: () => void }).gc?.();
    let bytes = 0;
    const heapBefore = process.memoryUsage().heapUsed;
    const start = performance.now();
    await request({ logBytesRead: (count) => { bytes += count; } });
    samples.push(performance.now() - start);
    heapBytes = Math.max(heapBytes, process.memoryUsage().heapUsed - heapBefore);
    logBytes = Math.max(logBytes, bytes);
  }
  samples.sort((left, right) => left - right);
  return { name, medianMs: round(samples[Math.floor(samples.length / 2)] ?? 0),
    p95Ms: round(samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)] ?? 0), logBytes, heapBytes };
}
function round(value: number): number { return Math.round(value * 100) / 100; }
