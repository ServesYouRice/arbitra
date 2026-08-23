import { describe, expect, it } from "vitest";
import { InMemoryIndependenceCorpusStore, InMemoryRealWorldOutcomeStore } from "../eval/corpora.js";
import { applySampledFindings, createRedactedExport, diffRuns, replay, sampleSecondAuditor, type ReplayRunResult, type ReplaySourceRun } from "./index.js";

const sourceRun: ReplaySourceRun = {
  runId: "run-source",
  roundZero: [
    { artifactRef: "sha256:auditor-a", findings: [{ id: "F-1", severity: "high" }] },
    { artifactRef: "sha256:auditor-b", findings: [{ id: "F-2", severity: "low" }] },
  ],
  result: { runId: "run-source", issues: [], metrics: {} },
};

describe("replay and evaluation primitives", () => {
  it("creates a new run from persisted round-zero findings and executes all replay stages", async () => {
    const saved: ReplayRunResult[] = [];
    const stageCalls: string[] = [];
    const result = await replay("run-source", { consensusPolicy: "full", maximumRounds: 2, criticEnabled: false }, {
      repository: { async loadRun() { return structuredClone(sourceRun); }, async saveReplay(value) { saved.push(value); } },
      pipeline: {
        async cluster(findings) { stageCalls.push(`cluster:${findings.length}`); return { clusters: 2 }; },
        async reachConsensus(clustering) { stageCalls.push(`consensus:${JSON.stringify(clustering)}`); return { accepted: 1 }; },
        async verify(consensus) { stageCalls.push(`verification:${JSON.stringify(consensus)}`); return { confirmed: 1 }; },
      },
      createRunId: () => "run-replay",
    });
    expect(stageCalls).toEqual(["cluster:2", "consensus:{\"clusters\":2}", "verification:{\"accepted\":1}"]);
    expect(result).toMatchObject({ runId: "run-replay", sourceRunId: "run-source", reusedRoundZeroArtifactRefs: ["sha256:auditor-a", "sha256:auditor-b"] });
    expect(saved).toEqual([result]);
  });

  it("refuses to save when replay mutates the source run", async () => {
    let calls = 0;
    await expect(replay("run-source", { consensusPolicy: "minimal", maximumRounds: 1, criticEnabled: false }, {
      repository: {
        async loadRun() { calls += 1; return calls === 1 ? structuredClone(sourceRun) : { ...structuredClone(sourceRun), result: { ...sourceRun.result, metrics: { cost: 1 } } }; },
        async saveReplay() { throw new Error("must not save"); },
      },
      pipeline: { async cluster() { return {}; }, async reachConsensus() { return {}; }, async verify() { return {}; } },
      createRunId: () => "run-replay",
    })).rejects.toThrow("REPLAY_SOURCE_RUN_MUTATED");
  });

  it("diffs issue state and refuses to invent metric deltas from null data", () => {
    expect(diffRuns(
      { runId: "run-a", issues: [{ id: "C-1", status: "open", severity: "high", verification: null }, { id: "C-2", status: "rejected", severity: "low", verification: "REJECTED" }], metrics: { cost: 1, tokens: null } },
      { runId: "run-b", issues: [{ id: "C-1", status: "accepted", severity: "high", verification: "CONFIRMED" }, { id: "C-3", status: "open", severity: "medium", verification: null }], metrics: { cost: 1.5, tokens: 100 } },
    )).toEqual({ runA: "run-a", runB: "run-b", addedIssueIds: ["C-3"], removedIssueIds: ["C-2"], changedIssues: [{ id: "C-1", before: { status: "open", severity: "high", verification: null }, after: { status: "accepted", severity: "high", verification: "CONFIRMED" } }], metricDeltas: { cost: 0.5, tokens: null } });
  });

  it("samples deterministically from the full identity tuple", () => {
    const identity = ["repo", "base", "head", "protocol"] as const;
    const first = sampleSecondAuditor(...identity, 7);
    expect(sampleSecondAuditor(...identity, 7)).toBe(first);
    expect(sampleSecondAuditor(...identity, 1)).toBe(true);
    expect([sampleSecondAuditor("repo-a", "base", "head", "protocol", 7), sampleSecondAuditor("repo-b", "base", "head", "protocol", 7)]).not.toEqual([true, true]);
  });

  it("never suppresses a sampled auditor material finding from the live gate", () => {
    const result = applySampledFindings(
      [{ id: "F-LOW", severity: "low", source: "primary" }],
      [{ id: "F-HIGH", severity: "high", source: "sampled_second_auditor" }],
    );
    expect(result.findings.map(({ id }) => id)).toEqual(["F-HIGH", "F-LOW"]);
    expect(result).toMatchObject({ materialFindingIds: ["F-HIGH"], gatePassed: false });
  });

  it("redacts planted secrets before producing a minimal evidence export", () => {
    const secret = "sk-live-planted-secret";
    const exported = createRedactedExport({ runId: "run-secret", issues: [{ id: "C-1", title: `leak ${secret}`, evidence: [{ path: "src/config.ts", startLine: 4, endLine: 4, quote: `token=${secret}`, artifactRef: "sha256:evidence" }] }] }, {
      redact(text) { const matches = text.match(/sk-live-[a-z-]+/gu) ?? []; return { text: text.replaceAll(/sk-live-[a-z-]+/gu, "[REDACTED:api_key]"), redactionCount: matches.length }; },
    });
    expect(JSON.stringify(exported)).not.toContain(secret);
    expect(exported).toMatchObject({ redactionCount: 2, issues: [{ evidence: [{ path: "src/config.ts", lineRange: { start: 4, end: 4 }, artifactRef: "sha256:evidence" }] }] });
  });

  it("stores and queries outcome and independence observations through distinct types and stores", async () => {
    const outcomes = new InMemoryRealWorldOutcomeStore();
    const independence = new InMemoryIndependenceCorpusStore();
    await outcomes.append({ corpus: "real_world_outcomes", runId: "diff-fast-1", findingId: "F-1", outcome: "fixed", costUsd: 0.1, latencyMs: 12 });
    await independence.append({ corpus: "independence", runId: "diff-review-1", findingId: "F-1", auditorIds: ["a", "b"], independentlyFoundBy: ["b"], accepted: true });
    expect(await outcomes.query()).toEqual([{ corpus: "real_world_outcomes", runId: "diff-fast-1", findingId: "F-1", outcome: "fixed", costUsd: 0.1, latencyMs: 12 }]);
    expect(await independence.query()).toEqual([{ corpus: "independence", runId: "diff-review-1", findingId: "F-1", auditorIds: ["a", "b"], independentlyFoundBy: ["b"], accepted: true }]);
  });
});
