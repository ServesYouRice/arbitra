import { appendFile, mkdir, mkdtemp, open, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CorpusAdjudication, EvaluationRunProvenance, GroundTruthVersion } from "@arbitra/schemas/evaluation-corpus.js";

import { canonicalJson } from "../../src/canonical-json.js";
import { IncomparableCorpusAggregationError } from "../../src/evaluation-corpus/query.js";
import type { CorpusRedactor } from "../../src/evaluation-corpus/report.js";
import { CorpusIdentityConflictError } from "../../src/evaluation-corpus/state.js";
import {
  CORPUS_JOURNAL_FILE,
  CorpusJournalCorruptError,
  CorpusReportMismatchError,
  DurableIndependenceCorpusStore,
  DurableRealWorldOutcomeStore,
  EvaluationCorpusStore,
  type CorpusFileSystem,
  type EvaluationCorpusImport,
} from "../../src/evaluation-corpus/store.js";

const roots: string[] = [];
afterEach(async () => {
  for (const path of roots.splice(0)) {
    const resolved = resolve(path);
    if (!resolved.startsWith(`${resolve(tmpdir())}${sep}`)) throw new Error("UNSAFE_TEST_CLEANUP_PATH");
    await rm(resolved, { recursive: true, force: true });
  }
});

const SECRET = "sk-live1234567890abcdefXYZ";
/** Minimal stand-in for `redactSecrets`; the cross-package test uses the production redactor. */
const redactor: CorpusRedactor = {
  version: "test-1",
  redact(text) {
    let count = 0;
    const redacted = text.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, () => { count += 1; return "[REDACTED:api_token]"; });
    return { text: redacted, redactionCount: count };
  },
};

const truthV1: GroundTruthVersion = {
  groundTruthId: "expanded-evaluation", version: 1,
  items: [
    { id: "DEF-PATH-ESCAPE", kind: "defect", category: "authorization", path: "repo/src/files.ts", location: "readTenantFile", detectionCriteria: "Reports the tenant-root escape.", rationale: "No containment check." },
    { id: "DECOY-BOUND-PATH", kind: "decoy", category: "authorization", path: "repo/src/files.ts", location: "readPublicAsset", detectionCriteria: "Does not report the contained path.", rationale: "Mechanically contained." },
  ],
};

function run(runId: string, overrides: Partial<EvaluationRunProvenance> = {}): EvaluationRunProvenance {
  return {
    runId, mode: "scripted",
    snapshot: { repository: "fixtures/expanded", sourceDigest: "sha256:source-1", commit: null },
    protocol: { id: "audit", version: "1.0.0", hash: "sha256:protocol-1" },
    harness: { id: "canonical", version: "1", policyHash: "sha256:policy-1" },
    models: [
      { auditorId: "auditor-a", modelId: "model-a", modelProfileVersion: "1", transportId: "fake", transportVersion: "1" },
      { auditorId: "auditor-b", modelId: "model-b", modelProfileVersion: "1", transportId: "fake", transportVersion: "1" },
    ],
    groundTruth: { groundTruthId: "expanded-evaluation", version: 1 },
    ...overrides,
  };
}

function adjudication(overrides: Partial<CorpusAdjudication> = {}): CorpusAdjudication {
  return {
    runId: "run-1", findingId: "F-1", version: 1,
    judgment: { corpus: "real_world_outcomes", outcome: "recurred" },
    adjudicator: "maintainer-1", rationale: "The defect came back after the fix.",
    adjudicatedAt: "2026-09-01T12:00:00Z",
    groundTruthItem: { groundTruthId: "expanded-evaluation", version: 1, itemId: "DEF-PATH-ESCAPE" },
    ...overrides,
  };
}

const bundle: EvaluationCorpusImport = {
  groundTruth: [truthV1],
  runs: [run("run-1"), run("run-2")],
  observations: [
    { corpus: "real_world_outcomes", runId: "run-1", findingId: "F-1", outcome: "fixed", costUsd: 0.08, latencyMs: 900 },
    { corpus: "real_world_outcomes", runId: "run-2", findingId: "F-2", outcome: "rejected", costUsd: null, latencyMs: null },
    { corpus: "independence", runId: "run-1", findingId: "F-1", auditorIds: ["auditor-a", "auditor-b"], independentlyFoundBy: ["auditor-a", "auditor-b"], accepted: true },
  ],
};

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "arbitra-corpus-"));
  roots.push(root);
  return root;
}

function counterClock(start = 1_000): { now(): number } {
  let tick = start;
  return { now: () => tick++ };
}

function storeAt(directory: string, fileSystem?: CorpusFileSystem): EvaluationCorpusStore {
  return new EvaluationCorpusStore(directory, { clock: counterClock(), fsyncPolicy: "always", ...(fileSystem === undefined ? {} : { fileSystem }) });
}

async function journal(directory: string): Promise<string> {
  return readFile(join(directory, CORPUS_JOURNAL_FILE), "utf8");
}

describe("durable evaluation corpus", () => {
  it("keeps observations, provenance, ground truth and adjudication history across restart", async () => {
    const root = await makeRoot();
    const first = storeAt(root);
    await first.import(bundle);
    await first.adjudicate(adjudication());

    const restarted = storeAt(root);
    expect(await restarted.open()).toEqual({ truncatedBytes: 0, discardedRecords: 0, committedBatches: 2 });
    const outcomes = new DurableRealWorldOutcomeStore(restarted);
    expect(await outcomes.query()).toEqual([
      { corpus: "real_world_outcomes", runId: "run-1", findingId: "F-1", outcome: "recurred", costUsd: 0.08, latencyMs: 900 },
      { corpus: "real_world_outcomes", runId: "run-2", findingId: "F-2", outcome: "rejected", costUsd: null, latencyMs: null },
    ]);
    expect(await new DurableIndependenceCorpusStore(restarted).query(["run-1"])).toEqual([bundle.observations?.[2]]);
    expect(await restarted.provenance("run-2")).toEqual(run("run-2"));
    expect(await restarted.groundTruth("expanded-evaluation", 1)).toEqual(truthV1);
    const history = await restarted.history("real_world_outcomes", "run-1", "F-1");
    expect(history?.observation).toMatchObject({ outcome: "fixed" });
    expect(history?.adjudications).toEqual([adjudication()]);
    expect(await readdir(join(root, "artifacts"))).toHaveLength(1);
  });

  it("treats a repeated import as a no-op, before and after restart", async () => {
    const root = await makeRoot();
    const store = storeAt(root);
    expect(await store.import(bundle)).toEqual({ appended: 6, unchanged: 0, batch: 1 });
    const before = await journal(root);
    expect(await store.import(bundle)).toEqual({ appended: 0, unchanged: 6, batch: null });
    expect(await storeAt(root).import(bundle)).toEqual({ appended: 0, unchanged: 6, batch: null });
    expect(await journal(root)).toBe(before);

    const extended = { ...bundle, observations: [...(bundle.observations ?? []), { corpus: "real_world_outcomes" as const, runId: "run-2", findingId: "F-3", outcome: "verified" as const, costUsd: 0.01, latencyMs: 5 }] };
    expect(await store.import(extended)).toEqual({ appended: 1, unchanged: 6, batch: 2 });
    await Promise.all([store.adjudicate(adjudication()), store.adjudicate(adjudication())]);
    expect((await store.history("real_world_outcomes", "run-1", "F-1"))?.adjudications).toHaveLength(1);
  });

  it("recovers from a torn trailing record and from records whose batch never committed", async () => {
    const root = await makeRoot();
    await storeAt(root).import(bundle);
    const committed = await journal(root);

    const uncommitted = `${canonicalJson({ v: 1, t: "run", batch: 2, provenance: run("run-9"), digest: "0".repeat(64) })}\n`;
    await appendFile(join(root, CORPUS_JOURNAL_FILE), `${uncommitted}{"v":1,"t":"observ`);
    const recovered = storeAt(root);
    const recovery = await recovered.open();
    expect(recovery.discardedRecords).toBe(1);
    expect(recovery.truncatedBytes).toBe(Buffer.byteLength(uncommitted) + Buffer.byteLength(`{"v":1,"t":"observ`));
    expect(await journal(root)).toBe(committed);
    expect(await recovered.provenance("run-9")).toBeNull();
    expect(await recovered.observations("real_world_outcomes")).toHaveLength(2);
    expect(await recovered.import({ runs: [run("run-9")] })).toEqual({ appended: 1, unchanged: 0, batch: 2 });
    expect(await storeAt(root).provenance("run-9")).toEqual(run("run-9"));
  });

  it("rolls back a write that failed part-way and completes the import on retry", async () => {
    const root = await makeRoot();
    await storeAt(root).import({ groundTruth: [truthV1], runs: [run("run-1")] });
    let failNext = true;
    const tornWriter: CorpusFileSystem = {
      mkdir: (path, options) => mkdir(path, options),
      readFile: (path) => readFile(path),
      truncate: (path, length) => truncate(path, length),
      async open(path, flags) {
        const handle = await open(path, flags);
        return {
          async write(data: Uint8Array) {
            if (!failNext) return handle.write(data);
            failNext = false;
            await handle.write(data.subarray(0, Math.floor(data.byteLength * 0.75)));
            throw Object.assign(new Error("simulated power loss"), { code: "EIO" });
          },
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
    };
    const store = storeAt(root, tornWriter);
    const observations: EvaluationCorpusImport = { observations: [bundle.observations?.[0] ?? never(), bundle.observations?.[2] ?? never()] };
    await expect(store.import(observations)).rejects.toThrow("simulated power loss");
    expect(await store.observations("real_world_outcomes")).toEqual([]);
    expect(await store.import(observations)).toEqual({ appended: 2, unchanged: 0, batch: 2 });
    expect(await storeAt(root).observations("independence")).toHaveLength(1);
  });

  it("fails closed when a committed record is corrupted", async () => {
    const root = await makeRoot();
    await storeAt(root).import(bundle);
    const text = await journal(root);
    await writeFile(join(root, CORPUS_JOURNAL_FILE), text.replace('"outcome":"fixed"', '"outcome":"verified"'));
    await expect(storeAt(root).open()).rejects.toBeInstanceOf(CorpusJournalCorruptError);
  });

  it("rejects conflicting identities atomically", async () => {
    const root = await makeRoot();
    const store = storeAt(root);
    await store.import(bundle);
    await store.adjudicate(adjudication());
    const before = await journal(root);

    const conflicts: EvaluationCorpusImport[] = [
      { runs: [run("run-1", { harness: { id: "canonical", version: "2", policyHash: "sha256:policy-2" } })] },
      { runs: [run("run-new")], observations: [{ corpus: "real_world_outcomes", runId: "run-1", findingId: "F-1", outcome: "ignored", costUsd: 0.08, latencyMs: 900 }] },
      { groundTruth: [{ ...truthV1, items: truthV1.items.slice(0, 1) }] },
      { observations: [{ corpus: "independence", runId: "run-2", findingId: "F-9", auditorIds: ["auditor-a", "auditor-z"], independentlyFoundBy: [], accepted: false }] },
      { adjudications: [adjudication({ rationale: "Rewritten history." })] },
      { adjudications: [adjudication({ version: 2, groundTruthItem: { groundTruthId: "expanded-evaluation", version: 2, itemId: "DEF-PATH-ESCAPE" } })] },
    ];
    for (const conflict of conflicts) await expect(store.import(conflict)).rejects.toBeInstanceOf(CorpusIdentityConflictError);
    await expect(store.import({ adjudications: [adjudication({ version: 3 })] })).rejects.toThrow("CORPUS_ADJUDICATION_VERSION_GAP");
    await expect(store.import({ observations: [{ corpus: "real_world_outcomes", runId: "unregistered", findingId: "F-1", outcome: "fixed", costUsd: null, latencyMs: null }] })).rejects.toThrow("CORPUS_RUN_PROVENANCE_MISSING");
    await expect(store.import({ runs: [{ ...run("run-3"), apiKey: SECRET } as EvaluationRunProvenance] })).rejects.toThrow("unknown field apiKey");
    await expect(store.import({ observations: [{ corpus: "real_world_outcomes", runId: "run-1", findingId: "F-5", outcome: "fixed", costUsd: -1, latencyMs: null }] })).rejects.toThrow("costUsd");
    expect(await journal(root)).toBe(before);
    expect(await storeAt(root).provenance("run-new")).toBeNull();
  });

  it("retains denominators and unknown measurements in outcome summaries", async () => {
    const store = storeAt(await makeRoot());
    await store.import(bundle);
    await store.adjudicate(adjudication());
    const summary = await store.summarizeOutcomes({ runIds: ["run-1", "run-2", "run-missing"], groupBy: [] });
    expect(summary.denominator).toEqual({ runCount: 2, observationCount: 2, runsWithGroundTruth: 2, adjudicatedCount: 1, unmatchedRunIds: ["run-missing"] });
    expect(summary.rows).toHaveLength(1);
    expect(summary.rows[0]).toMatchObject({
      runCount: 2, observationCount: 2, adjudicatedCount: 1,
      outcomes: { verified: 0, rejected: 1, fixed: 0, ignored: 0, recurred: 1 },
      costUsd: { total: null, knownCount: 1, unknownCount: 1 },
      latencyMs: { mean: 900, knownCount: 1, unknownCount: 1 },
    });
    const independence = await store.summarizeIndependence({ groupBy: [] });
    expect(independence).toMatchObject({ applicable: true, denominator: { observationCount: 1 }, rows: [{ findingCount: 1, acceptedCount: 1, acceptedRate: 1, independentlyFoundCount: 1, multiplyFoundCount: 1, auditorSlotCount: 2 }] });
    expect(await store.summarizeIndependence({ runIds: ["run-2"], groupBy: [] })).toMatchObject({ applicable: false, reason: "no_independence_observations", rows: [] });
  });

  it("refuses to aggregate across protocol, model, harness, ground truth or mode unless grouped", async () => {
    const root = await makeRoot();
    const store = storeAt(root);
    await store.import(bundle);
    await store.import({
      groundTruth: [{ ...truthV1, version: 2 }],
      runs: [
        run("run-p2", { protocol: { id: "audit", version: "2.0.0", hash: "sha256:protocol-2" } }),
        run("run-live", { mode: "real_models" }),
        run("run-gt2", { groundTruth: { groundTruthId: "expanded-evaluation", version: 2 } }),
      ],
      observations: ["run-p2", "run-live", "run-gt2"].map((runId) => ({ corpus: "real_world_outcomes" as const, runId, findingId: "F-1", outcome: "fixed" as const, costUsd: 0.02, latencyMs: 10 })),
    });
    for (const [runId, dimension] of [["run-p2", "protocol"], ["run-live", "mode"], ["run-gt2", "groundTruth"]] as const) {
      const attempt = store.summarizeOutcomes({ runIds: ["run-1", runId], groupBy: [] });
      await expect(attempt).rejects.toBeInstanceOf(IncomparableCorpusAggregationError);
      await expect(store.summarizeOutcomes({ runIds: ["run-1", runId], groupBy: [] })).rejects.toThrow(`INCOMPARABLE_IDENTITY_MIX:${dimension}: group by ${dimension} or narrow the filter`);
    }
    const grouped = await store.summarizeOutcomes({ runIds: ["run-1", "run-2", "run-p2"], groupBy: ["protocol"] });
    expect(grouped.rows.map(({ group, observationCount }) => [group.protocol, observationCount])).toEqual([
      [canonicalJson(["audit", "1.0.0", "sha256:protocol-1"]), 2],
      [canonicalJson(["audit", "2.0.0", "sha256:protocol-2"]), 1],
    ]);
    const before = await journal(root);
    await expect(store.exportReport({ corpus: "real_world_outcomes", groupBy: [] }, redactor)).rejects.toBeInstanceOf(IncomparableCorpusAggregationError);
    expect(await journal(root)).toBe(before);
    expect(await store.exports()).toEqual([]);
  });

  it("reconstructs exported reports from saved artifacts, redacted, without silently changing judgments", async () => {
    const root = await makeRoot();
    const store = storeAt(root);
    await store.import(bundle);
    await store.adjudicate(adjudication({ rationale: `Recurred; the leaked key api_key=${SECRET} was rotated.` }));
    const exported = await store.exportReport({ corpus: "real_world_outcomes", groupBy: [] }, redactor);
    expect(exported.status).toBe("appended");
    expect(exported.report.redaction).toEqual({ version: "test-1", count: 1 });
    expect(exported.report.observations[0]).toMatchObject({ runId: "run-1", judgment: { outcome: "recurred" }, judgmentVersion: 1, imported: { outcome: "fixed" } });
    expect(exported.report.summary.denominator.observationCount).toBe(2);
    const savedBytes = await readFile(join(root, exported.ref.relativePath), "utf8");
    expect(savedBytes).not.toContain(SECRET);
    expect(savedBytes).toContain("[REDACTED:api_token]");
    expect(await store.exportReport({ corpus: "real_world_outcomes", groupBy: [] }, redactor)).toMatchObject({ status: "unchanged", ref: exported.ref });

    await store.adjudicate(adjudication({ version: 2, judgment: { corpus: "real_world_outcomes", outcome: "fixed" }, rationale: "Second fix held.", adjudicatedAt: "2026-09-10T08:00:00Z" }));
    const restarted = storeAt(root);
    const rebuilt = await restarted.reconstructReport(exported.ref, redactor);
    expect(canonicalJson(rebuilt.report)).toBe(canonicalJson(exported.report));
    expect(rebuilt.supersededJudgments).toEqual([{ runId: "run-1", findingId: "F-1", reportedVersion: 1, currentVersion: 2 }]);
    const latest = await restarted.exportReport({ corpus: "real_world_outcomes", groupBy: [] }, redactor);
    expect(latest.ref.hash).not.toBe(exported.ref.hash);
    expect(latest.report.observations[0]).toMatchObject({ judgment: { outcome: "fixed" }, judgmentVersion: 2 });
    expect((await restarted.exports()).map(({ report }) => report.hash)).toEqual([exported.ref.hash, latest.ref.hash]);

    await expect(restarted.reconstructReport(exported.ref, { ...redactor, version: "test-2" })).rejects.toBeInstanceOf(CorpusReportMismatchError);
    const leaky: CorpusRedactor = { version: "test-1", redact: (text) => ({ text, redactionCount: 0 }) };
    await expect(restarted.reconstructReport(exported.ref, leaky)).rejects.toThrow("CORPUS_REPORT_RECONSTRUCTION_MISMATCH");
    await writeFile(join(root, exported.ref.relativePath), savedBytes.replace("recurred", "verified"));
    await expect(storeAt(root).reconstructReport(exported.ref, redactor)).rejects.toThrow(/content-address/u);
  });
});

function never(): never { throw new Error("fixture missing"); }
