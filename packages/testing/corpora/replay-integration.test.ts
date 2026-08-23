import { describe, expect, it } from "vitest";
import { createRedactedExport, replay, type ReplayRunResult, type ReplaySourceRun } from "../../core/src/replay/index.js";
import { redactSecrets } from "../../security/src/redaction.js";
import { cluster, deterministicClusteringStrategy, type ValidatedClusterInput } from "../../workflow/src/clustering/index.js";
import { computeConsensus, type ConsensusBoard } from "../../workflow/src/consensus/index.js";
import { verifyItems } from "../../workflow/src/nodes/verification/index.js";

describe("production replay integration", () => {
  it("reuses persisted round-zero findings through production clustering, consensus and deterministic verification", async () => {
    const findings = [finding("auditor-a/F-1", "auditor-a"), finding("auditor-b/F-1", "auditor-b")];
    const source: ReplaySourceRun = { runId: "source-run", roundZero: [{ artifactRef: "sha256:round-zero", findings }], result: { runId: "source-run", issues: [], metrics: {} } };
    const saved: ReplayRunResult[] = [];
    const result = await replay("source-run", { consensusPolicy: "full", maximumRounds: 2, criticEnabled: false }, {
      repository: { async loadRun() { return structuredClone(source); }, async saveReplay(value) { saved.push(value); } },
      pipeline: {
        async cluster(values) { return cluster(values as readonly ValidatedClusterInput[], { strategy: deterministicClusteringStrategy }); },
        async reachConsensus(clustering) {
          const clusterId = (clustering as { readonly clusters: readonly { readonly clusterId: string }[] }).clusters[0]!.clusterId;
          const board: ConsensusBoard = { candidates: { [clusterId]: { candidateId: clusterId, claim: { title: "Authorization bypass", description: "Header bypasses roles" }, sourceFindingIds: findings.map(({ finding: value }) => value.sourceFindingId), severity: "high", blocker: false, status: "open", votes: [{ authorId: "auditor-a", disposition: "accept", citedEvidenceIds: ["E-1"], reason: "confirmed" }, { authorId: "auditor-b", disposition: "accept", citedEvidenceIds: ["E-2"], reason: "confirmed" }], evidence: [], counterEvidence: [], firstSeenRound: 0, lastChangedRound: 1, category: "authorization" } } };
          return computeConsensus(board, { name: "full", quorum: 2, minimumIndependentGroupsForHighRisk: 2 }, { auditors: [{ auditorId: "auditor-a", independenceGroup: "a" }, { auditorId: "auditor-b", independenceGroup: "b" }], round: 1, maximumRounds: 2 });
        },
        async verify(consensus) {
          const candidateId = (consensus as { readonly candidates: readonly { readonly candidateId: string }[] }).candidates[0]!.candidateId;
          const operations: unknown[] = [];
          return verifyItems([{ candidateId, severity: "high", claim: "Header bypasses roles", question: "Is the bypass reachable?", citedEvidenceIds: ["E-1"], citedContext: [{ evidenceId: "E-1", text: "header === let-me-in" }], symbols: ["isAdmin"], routes: [], dependencies: [] }], deterministicTools(), { maximumItems: 1, allowModelCall: false, round: 1 }, { sink: { async append(operation) { operations.push(operation); } } });
        },
      },
      createRunId: () => "replay-run",
    });
    expect(result).toMatchObject({ sourceRunId: "source-run", reusedRoundZeroArtifactRefs: ["sha256:round-zero"], clustering: { clusters: [{ sourceFindingIds: ["auditor-a/F-1", "auditor-b/F-1"] }] }, consensus: { candidates: [{ outcome: "accepted" }] }, verification: { metrics: { resolvedDisputes: 1, modelCalls: 0 } } });
    expect(saved).toEqual([result]);
  });

  it("uses the production secret redactor at the outbound export boundary", () => {
    const secret = "github_pat_12345678901234567890";
    const result = createRedactedExport({ runId: "secret-run", issues: [{ id: "C-1", title: "Credential exposure", evidence: [{ path: "src/config.ts", startLine: 3, endLine: 3, quote: `api_key=${secret}`, artifactRef: "sha256:evidence" }] }] }, { redact(text) { const result = redactSecrets(text); return { text: result.text, redactionCount: result.redactions.length }; } });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result).toMatchObject({ redactionCount: 1, issues: [{ evidence: [{ path: "src/config.ts", lineRange: { start: 3, end: 3 }, quote: "api_key=[REDACTED:github_token]" }] }] });
  });
});

function finding(sourceFindingId: string, auditorId: string): ValidatedClusterInput {
  return { validation: "accepted", auditorId, finding: { sourceFindingId, category: "authorization", title: "Authorization bypass", problem: "A request header bypasses role enforcement", recommendedFix: "Use authenticated roles", locations: [{ path: "src/auth.ts", startLine: 4, endLine: 6, symbol: "isAdmin" }], failureMechanisms: ["authorization"] } };
}

function deterministicTools() {
  const attempt = (method: string, verdict: string) => ({ method, verdict, evidenceIds: verdict === "confirmed" ? ["E-V"] : [], artifactRefs: [`artifact:${method}`], toolCallIds: [`tool:${method}`], activityId: `activity:${method}`, confidence: verdict === "confirmed" ? 1 : null });
  return { async readCitedLines() { return attempt("cited_lines", "confirmed"); }, async searchSymbolOrCallPath() { return attempt("symbol_or_call_path", "inconclusive"); }, async inspectRouteConfigMiddleware() { return attempt("route_config_middleware", "inconclusive"); }, async inspectDependencyOrImportPath() { return attempt("dependency_or_import_path", "inconclusive"); }, async runAllowlistedSafeTest() { return attempt("allowlisted_safe_test", "inconclusive"); }, async boundedDeterministicCheck() { return attempt("bounded_deterministic_check", "inconclusive"); } } as never;
}
