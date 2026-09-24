import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  InMemoryIndependenceCorpusStore,
  InMemoryRealWorldOutcomeStore,
  type IndependenceCorpusStore,
  type IndependenceObservation,
  type RealWorldOutcomeObservation,
  type RealWorldOutcomeStore,
} from "../../core/src/eval/corpora.js";
import {
  DurableIndependenceCorpusStore,
  DurableRealWorldOutcomeStore,
  EvaluationCorpusStore,
} from "../../persistence/src/evaluation-corpus/store.js";
import type { CorpusRedactor } from "../../persistence/src/evaluation-corpus/report.js";
import type { EvaluationRunProvenance } from "../../schemas/src/evaluation-corpus.js";
import { REDACTION_PATTERN_VERSION, redactSecrets } from "../../security/src/redaction.js";

const roots: string[] = [];
afterEach(async () => {
  for (const path of roots.splice(0)) {
    const resolved = resolve(path);
    if (!resolved.startsWith(`${resolve(tmpdir())}${sep}`)) throw new Error("UNSAFE_TEST_CLEANUP_PATH");
    await rm(resolved, { recursive: true, force: true });
  }
});

/** The production redactor, adapted at the composition boundary persistence cannot import. */
const productionRedactor: CorpusRedactor = {
  version: `security-redaction@${REDACTION_PATTERN_VERSION}`,
  redact(text) { const result = redactSecrets(text); return { text: result.text, redactionCount: result.redactions.length }; },
};

function fixture<T>(relativePath: string): T {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8")) as T;
}

function provenance(runId: string, auditorIds: readonly string[]): EvaluationRunProvenance {
  return {
    runId, mode: "scripted",
    snapshot: { repository: "fixtures/premise", sourceDigest: "sha256:premise", commit: null },
    protocol: { id: "audit", version: "1.0.0", hash: "sha256:audit" },
    harness: { id: "canonical", version: "1", policyHash: "sha256:policy" },
    models: auditorIds.map((auditorId) => ({ auditorId, modelId: `scripted-${auditorId}`, modelProfileVersion: "1", transportId: "fake", transportVersion: "1" })),
    groundTruth: null,
  };
}

describe("durable corpora behind the core corpus interfaces", () => {
  it("matches the in-memory stores for the shipped fixtures and survives restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbitra-durable-corpora-"));
    roots.push(root);
    const outcomes = fixture<{ readonly observations: readonly Omit<RealWorldOutcomeObservation, "corpus">[] }>("./real-world-outcomes/sample.json").observations
      .map((value): RealWorldOutcomeObservation => ({ corpus: "real_world_outcomes", ...value }));
    const independence = fixture<{ readonly observations: readonly Omit<IndependenceObservation, "corpus">[] }>("./independence/sample.json").observations
      .map((value): IndependenceObservation => ({ corpus: "independence", ...value }));

    const corpus = new EvaluationCorpusStore(root, { clock: { now: () => 0 } });
    await corpus.import({ runs: [
      ...outcomes.map(({ runId }) => provenance(runId, ["auditor-a"])),
      ...independence.map(({ runId, auditorIds }) => provenance(runId, auditorIds)),
    ] });
    const durable: readonly [RealWorldOutcomeStore, IndependenceCorpusStore] = [new DurableRealWorldOutcomeStore(corpus), new DurableIndependenceCorpusStore(corpus)];
    const memory: readonly [RealWorldOutcomeStore, IndependenceCorpusStore] = [new InMemoryRealWorldOutcomeStore(), new InMemoryIndependenceCorpusStore()];
    for (const [outcomeStore, independenceStore] of [durable, memory]) {
      for (const observation of outcomes) await outcomeStore.append(observation);
      for (const observation of independence) await independenceStore.append(observation);
    }

    const restarted = new EvaluationCorpusStore(root, { clock: { now: () => 0 } });
    const reopened: readonly [RealWorldOutcomeStore, IndependenceCorpusStore] = [new DurableRealWorldOutcomeStore(restarted), new DurableIndependenceCorpusStore(restarted)];
    expect(await reopened[0].query()).toEqual(await memory[0].query());
    expect(await reopened[1].query()).toEqual(await memory[1].query());
    expect((await reopened[0].query(["diff-fast-002"]))[0]?.costUsd).toBeNull();
  });

  it("exports through the production redactor and reconstructs without exposing credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbitra-durable-corpora-"));
    roots.push(root);
    const secret = "github_pat_12345678901234567890abcdef";
    const corpus = new EvaluationCorpusStore(root, { clock: { now: () => 0 } });
    await corpus.import({
      runs: [provenance("diff-fast-001", ["auditor-a"])],
      observations: [{ corpus: "real_world_outcomes", runId: "diff-fast-001", findingId: "F-1", outcome: "verified", costUsd: null, latencyMs: 920 }],
      adjudications: [{ runId: "diff-fast-001", findingId: "F-1", version: 1, judgment: { corpus: "real_world_outcomes", outcome: "fixed" }, adjudicator: "maintainer", rationale: `Fixed; rotated token=${secret}`, adjudicatedAt: "2026-09-01T00:00:00Z", groundTruthItem: null }],
    });
    const exported = await corpus.exportReport({ corpus: "real_world_outcomes", groupBy: [] }, productionRedactor);
    const saved = await readFile(join(root, exported.ref.relativePath), "utf8");
    expect(saved).not.toContain(secret);
    expect(saved).toContain("[REDACTED:");
    expect(exported.report.redaction.count).toBeGreaterThan(0);
    const rebuilt = await new EvaluationCorpusStore(root, { clock: { now: () => 0 } }).reconstructReport(exported.ref, productionRedactor);
    expect(rebuilt.report).toEqual(exported.report);
    expect(rebuilt.supersededJudgments).toEqual([]);
  });
});
