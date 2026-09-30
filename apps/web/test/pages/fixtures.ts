import type { RunListItem, RunOverview, RunResource } from "../../src/api/runs.js";
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
