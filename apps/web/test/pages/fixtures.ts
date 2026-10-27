import type { RunListItem, RunOverview, RunProgress, RunResource } from "../../src/api/runs.js";
import type { WorkflowJson } from "../../src/graph/layout.js";
import { ARTIFACT_CONTENT } from "../views/fixtures.js";

export const AUDIT_WORKFLOW: WorkflowJson = {
  id: "audit-deep",
  nodes: [
    { id: "preflight", kind: "deterministic", label: "Preflight" }, { id: "auditor-a", kind: "model", label: "Auditor A" }, { id: "auditor-b", kind: "model", label: "Auditor B" },
    { id: "consensus", kind: "loop", label: "Consensus" }, { id: "verification", kind: "subgraph", label: "Verification" }, { id: "planner", kind: "model", label: "Planner" },
  ],
  edges: [{ id: "p-a", from: "preflight", to: "auditor-a" }, { id: "p-b", from: "preflight", to: "auditor-b" }, { id: "a-c", from: "auditor-a", to: "consensus" }, { id: "b-c", from: "auditor-b", to: "consensus" }, { id: "c-v", from: "consensus", to: "verification" }, { id: "v-p", from: "verification", to: "planner" }],
};
export const FEATURE_WORKFLOW: WorkflowJson = { id: "feature-simple", nodes: [{ id: "preflight", kind: "deterministic", label: "Preflight" }, { id: "feature", kind: "subgraph", label: "Requirements, exploration and planning" }, { id: "render", kind: "deterministic", label: "Render" }], edges: [{ id: "a", from: "preflight", to: "feature" }, { id: "b", from: "feature", to: "render" }] };

export function resource(overrides: Partial<RunResource> = {}): RunResource {
  return { runId: "run-1", state: "COMPLETED", resumable: false, checkpoints: [], workflow: AUDIT_WORKFLOW, ...overrides };
}

export function listItem(overrides: Partial<RunListItem> = {}): RunListItem {
  return { runId: "run-1", state: "COMPLETED", reason: null, mode: "audit", workflowId: "audit-deep", repository: "/work/fixture", executor: "scripted", createdAt: "2026-09-29T09:00:00.000Z",
    updatedAt: "2026-09-29T09:05:00.000Z", live: false, replayOf: null, pendingDecisions: 0, gate: { status: "failed", reasons: ["unresolved_issues", "degraded_coverage"] }, problem: null, ...overrides };
}

export function overview(overrides: Partial<RunOverview> = {}): RunOverview {
  return { ...listItem(), scope: { kind: "repository" }, consensusPolicy: "risk_weighted", maximumRounds: 1, criticEnabled: false, checkpointMode: null, workflowGraph: null, configuration: null, ...overrides };
}

/** The artifact routes of one run: a listing of `kinds` and each artifact's content. */
export function artifactRoutes(runId: string, contents: Readonly<Record<string, unknown>> = ARTIFACT_CONTENT, nodes: Readonly<Record<string, string>> = {}): Record<string, unknown> {
  const routes: Record<string, unknown> = {
    [`GET /runs/${runId}/artifacts`]: Object.keys(contents).map((kind) => ({ artifactId: `artifact:${kind}`, kind, mediaType: "application/json", bytes: 256, redacted: true, nodeId: nodes[kind] ?? null })),
  };
  for (const [kind, content] of Object.entries(contents)) routes[`GET /runs/${runId}/artifacts/${encodeURIComponent(`artifact:${kind}`)}`] = { artifactId: `artifact:${kind}`, kind, mediaType: "application/json", bytes: 256, redacted: true, nodeId: nodes[kind] ?? null, content: JSON.stringify(content), truncated: false, continuationArtifactId: null };
  return routes;
}

export const EMPTY_TRACES = { entries: [], total: 0, offset: 0, nextOffset: null, facets: { nodeIds: [], modelIds: [], protocolIds: [] } };

/** A balanced audit's graph with a plan review: two finders side by side, as a real two-vendor run records it. */
export const BALANCED_WORKFLOW: WorkflowJson = {
  id: "audit-balanced",
  nodes: [
    { id: "preflight", kind: "deterministic", label: "Diff scope" }, { id: "auditor-a", kind: "model", label: "Auditor A" }, { id: "auditor-b", kind: "model", label: "Auditor B" },
    { id: "consensus", kind: "loop", label: "Disagreement" }, { id: "verification", kind: "subgraph", label: "Verification" }, { id: "planner", kind: "model", label: "Planner" }, { id: "critic", kind: "model", label: "Critic" },
  ],
  edges: [{ id: "p-a", from: "preflight", to: "auditor-a" }, { id: "p-b", from: "preflight", to: "auditor-b" }, { id: "a-c", from: "auditor-a", to: "consensus" }, { id: "b-c", from: "auditor-b", to: "consensus" },
    { id: "c-v", from: "consensus", to: "verification" }, { id: "v-p", from: "verification", to: "planner" }, { id: "p-c", from: "planner", to: "critic" }],
};

const profile = (provider: string, modelId: string, transport: string, word: "effort" | "reasoning_effort") => ({ provider, modelId, family: provider, transport, capabilityTier: "frontier", independenceGroup: provider,
  effort: { params: { medium: { [word]: "high" }, high: { [word]: "xhigh" } } } });
/** Opus 5.5 and GPT-6.1 Sol at depth deep: the finders at xhigh, the later steps at their own effort. */
export const MODEL_CONFIGURATION: Readonly<Record<string, unknown>> = Object.freeze({
  mode: "audit", auditDepth: "deep",
  models: { "auditor-a": profile("anthropic", "claude-opus-5-5", "claude-code-cli", "effort"), "auditor-b": profile("openai", "gpt-6.1-sol", "codex-cli", "reasoning_effort") },
  workflow: { modelExecution: { roles: { planner: "auditor-a", verifier: "auditor-a", critic: "auditor-b" }, stageEffort: { verification: "medium", planner: "medium", critic: "medium" }, maximumTokens: 65_000_000, timeoutMs: 900_000 } },
});

export function modelOverview(overrides: Partial<RunOverview> = {}): RunOverview {
  return overview({ workflowId: "audit-balanced", executor: "models", repository: "/work/veritra", configuration: MODEL_CONFIGURATION, maximumRounds: 0, ...overrides });
}

const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();
const stage = (nodeId: string, status: RunProgress["stages"][number]["status"], extra: Partial<RunProgress["stages"][number]> = {}): RunProgress["stages"][number] =>
  ({ nodeId, status, elapsedMs: 0, runningSince: null, startedAt: null, endedAt: null, calls: 0, tokens: 0, ...extra });

/** An hour into discovery: the project read, both finders working, 309 issues found so far, seven calls restarted. */
export function discoveryProgress(overrides: Partial<RunProgress> = {}): RunProgress {
  const titles = ["sign_enrollment_challenge signs raw caller bytes with the MLS identity key", "process_commit merges commits without validating credentials", "join_group accepts any Welcome with the expected group id",
    "Local ICE candidates are dropped: onIceCandidate is installed after a round trip", "Retry loop never gives up on a closed socket", "Log line prints the session token"];
  return {
    runId: "run-1", state: "DISCOVERY_RUNNING", live: true, readAt: new Date().toISOString(),
    run: { elapsedMs: 0, runningSince: minutesAgo(66), startedAt: minutesAgo(66), endedAt: null },
    stages: [stage("preflight", "done", { elapsedMs: 60_000, endedAt: minutesAgo(65) }), stage("auditor-a", "running", { runningSince: minutesAgo(65), calls: 22, tokens: 2_000_000 }),
      stage("auditor-b", "running", { runningSince: minutesAgo(65), calls: 14, tokens: 1_400_000 }), stage("consensus", "waiting"), stage("verification", "waiting"), stage("planner", "waiting"), stage("critic", "waiting")],
    auditors: [{ auditorId: "auditor-a", modelId: "claude-opus-5-5", partsRead: 22, partsDeclined: 0, findings: 190, finished: false, coverage: null }, { auditorId: "auditor-b", modelId: "gpt-6.1-sol", partsRead: 14, partsDeclined: 1, findings: 119, finished: false, coverage: null }],
    found: { total: 309, bySeverity: { critical: 0, high: 36, medium: 107, low: 158, informational: 8 },
      items: titles.map((title, index) => ({ title, severity: index < 4 ? "high" : "medium", path: `crypto/rust/src/mls.rs`, line: 100 + index, auditorId: index % 2 === 0 ? "auditor-a" : "auditor-b" })) },
    tokens: { used: 3_400_000, callsWithoutUsage: 0, limit: 65_000_000 },
    restarted: { afterTimeout: 7, timeoutMs: 900_000, activities: ["auditor-a/scope-0b908bfe7c26ba1e39d3e593/discovery/turn-0"] },
    ...overrides,
  };
}

/** A finished run's progress: every stage done, with its recorded time. */
export function finishedProgress(overrides: Partial<RunProgress> = {}): RunProgress {
  const done = (nodeId: string, minutes: number, calls = 0, tokens = 0) => stage(nodeId, "done", { elapsedMs: minutes * 60_000, calls, tokens });
  return discoveryProgress({ state: "COMPLETED", live: false, run: { elapsedMs: 105 * 60_000, runningSince: null, startedAt: minutesAgo(200), endedAt: minutesAgo(95) },
    stages: [done("preflight", 0.5), done("auditor-a", 53, 40, 9_000_000), done("auditor-b", 41, 30, 7_000_000), done("consensus", 4, 3, 300_000), done("verification", 19, 30, 6_000_000), done("planner", 26, 5, 4_000_000), done("critic", 2, 2, 500_000)],
    tokens: { used: 26_800_000, callsWithoutUsage: 0, limit: 65_000_000 }, restarted: { afterTimeout: 0, timeoutMs: 900_000, activities: [] }, ...overrides });
}

/** What the check decided, as the metrics route reports it. */
export const CONFIRMED_YIELD = Object.freeze({ candidates: 415, confirmed: 126, confirmedBySeverity: { critical: 1, high: 21, medium: 104 }, rejected: 46, unsettled: 20, acceptedUnchecked: 0, notChecked: 223,
  tokens: 26_800_000, tokensPerConfirmed: 213_000, auditors: [] });
export function metrics(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return { rows: [], denominator: { activityCount: 0, auditorCount: 0, groundTruthAvailable: false }, segmentation: [], independence: { applicable: false, reason: "no_ground_truth_measurement", groups: [] }, confirmedYield: CONFIRMED_YIELD, planResults: null, ...overrides };
}
