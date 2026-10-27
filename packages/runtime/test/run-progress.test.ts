import { describe, expect, it } from "vitest";
import type { RunEvent } from "@arbitra/core/runner/events.js";
import type { RunnerGraph } from "@arbitra/core/runner/workflow-runner.js";
import type { ModelActivityTraceRecord } from "@arbitra/persistence/trace.js";
import { digestArtifact, summariseProgress, timeline, type ProgressDescriptor } from "../src/run-progress.js";

const runId = "run-progress";
const node = (id: string, kind: RunnerGraph["nodes"][number]["kind"]) => ({ id, kind, label: id, goal: id });
const graph: RunnerGraph = { schemaVersion: 1, id: "audit-balanced", entryNodeId: "preflight",
  nodes: [node("preflight", "deterministic"), node("auditor-a", "model"), node("auditor-b", "model"), node("consensus", "loop"), node("verification", "subgraph"), node("planner", "model")],
  edges: [{ id: "p-a", from: "preflight", to: "auditor-a" }, { id: "p-b", from: "preflight", to: "auditor-b" }, { id: "a-c", from: "auditor-a", to: "consensus" }, { id: "b-c", from: "auditor-b", to: "consensus" }, { id: "c-v", from: "consensus", to: "verification" }, { id: "v-p", from: "verification", to: "planner" }] };
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 25, 9, 0) + minutes * 60_000).toISOString();
const state = (value: Extract<RunEvent, { t: "run_transition" }>["state"], minutes: number, reason?: string): RunEvent => ({ t: "run_transition", runId, state: value, at: at(minutes), ...(reason === undefined ? {} : { reason }) });
const dispatched = (nodeId: string, minutes: number): RunEvent => ({ t: "node_dispatched", runId, nodeId, activityId: `${nodeId}-activity`, at: at(minutes) });
const completed = (nodeId: string, minutes: number, replayed = false): RunEvent => ({ t: "node_completed", runId, nodeId, activityId: `${nodeId}-activity`, replayed, at: at(minutes) });
const finding = (title: string, severity: string, path: string, line: number) => ({ title, severity, locations: [{ id: "L1", path, startLine: line, endLine: line }] });
const trace = (nodeId: string, input: number | null, output: number | null): ModelActivityTraceRecord => ({ nodeId, tokenUsage: input === null ? null : { inputTokens: input, outputTokens: output, cacheReadTokens: null, cacheWriteTokens: null } }) as unknown as ModelActivityTraceRecord;

describe("a run's progress, read from its records", () => {
  it("times each stage from its start to its end, and leaves out the time the run was paused", () => {
    const events = [state("CREATED", 0), dispatched("preflight", 0), completed("preflight", 1), state("DISCOVERY_RUNNING", 1), dispatched("auditor-a", 1), dispatched("auditor-b", 1),
      completed("auditor-b", 21), state("SUSPENDED_RATE_LIMIT", 31, "usage limit"), state("CREATED", 91, "resumed"), dispatched("preflight", 91), completed("preflight", 91, true),
      dispatched("auditor-b", 91), completed("auditor-b", 91, true), dispatched("auditor-a", 91)];
    const { run, stages } = timeline(events, graph.nodes.map(({ id }) => id), "DISCOVERY_RUNNING", true);
    const stage = (id: string) => stages.find(({ nodeId }) => nodeId === id);
    expect(run).toEqual({ elapsedMs: 31 * 60_000, runningSince: at(91), startedAt: at(0), endedAt: null });
    expect(stage("preflight")).toEqual({ nodeId: "preflight", status: "done", elapsedMs: 60_000, runningSince: null, startedAt: at(0), endedAt: at(1) });
    // Replayed on resume: its time is the first attempt's only.
    expect(stage("auditor-b")).toMatchObject({ status: "done", elapsedMs: 20 * 60_000, endedAt: at(21) });
    // Thirty minutes before the pause, and running again since the resume.
    expect(stage("auditor-a")).toEqual({ nodeId: "auditor-a", status: "running", elapsedMs: 30 * 60_000, runningSince: at(91), startedAt: at(1), endedAt: null });
    expect(stage("planner")).toMatchObject({ status: "waiting", elapsedMs: 0, startedAt: null });
  });

  it("marks the stage a run failed or paused in, and counts nothing on while the run is stopped", () => {
    const events = [state("CREATED", 0), dispatched("preflight", 0), completed("preflight", 1), dispatched("auditor-a", 1), state("FAILED", 5, "Error: boom")];
    const failed = timeline(events, ["preflight", "auditor-a", "planner"], "FAILED", false);
    expect(failed.stages.map(({ status }) => status)).toEqual(["done", "failed", "waiting"]);
    expect(failed.run).toEqual({ elapsedMs: 5 * 60_000, runningSince: null, startedAt: at(0), endedAt: at(5) });
    const paused = timeline([...events.slice(0, 4), state("SUSPENDED_BUDGET", 5)], ["preflight", "auditor-a"], "SUSPENDED_BUDGET", false);
    expect(paused.stages.map(({ status, elapsedMs }) => [status, elapsedMs])).toEqual([["done", 60_000], ["stopped", 4 * 60_000]]);
  });

  it("says nothing about time for a run recorded before its events carried times", () => {
    const events: RunEvent[] = [{ t: "run_transition", runId, state: "CREATED" }, { t: "node_dispatched", runId, nodeId: "preflight", activityId: "p" }, { t: "node_completed", runId, nodeId: "preflight", activityId: "p", replayed: false }, { t: "node_dispatched", runId, nodeId: "auditor-a", activityId: "a" }];
    const { run, stages } = timeline(events, ["preflight", "auditor-a"], "CREATED", true);
    expect(run.elapsedMs).toBeNull();
    expect(run.runningSince).toBeNull();
    expect(stages.map(({ status, elapsedMs, startedAt }) => [status, elapsedMs, startedAt])).toEqual([["done", null, null], ["running", null, null]]);
  });

  it("counts each finding model's parts, the issues found so far by severity, the tokens and the calls restarted after a timeout", async () => {
    const contents = new Map<string, unknown>([
      ["findings-auditor-a-scope-aaaaaaaaaaaaaaaaaaaaaaaa", [finding("Role check missing", "high", "src/roles.ts", 40), finding("Unbounded retry", "low", "src/retry.ts", 8)]],
      ["findings-auditor-a-window-bbbbbbbbbbbbbbbbbbbbbbbb", [finding("Token logged", "critical", "src/log.ts", 3)]],
      // Auditor B has finished: its own record holds every unit's findings.
      ["findings-auditor-b-scope-cccccccccccccccccccccccc", [finding("Stale cache", "medium", "src/cache.ts", 12)]],
      ["findings-auditor-b", [finding("Stale cache", "medium", "src/cache.ts", 12), finding("Injected text followed", "high", "docs/notes.md", 1)]],
      [`model-activity-${"1".repeat(64)}-trace`, { activityId: "auditor-a/scope-aaaaaaaaaaaaaaaaaaaaaaaa/discovery/turn-0", attempts: [{ outcome: "retry", errorCode: "TIMEOUT" }, { outcome: "completed", errorCode: null }] }],
      [`model-activity-${"2".repeat(64)}-trace`, { activityId: "auditor-b/scope-cccccccccccccccccccccccc/discovery/turn-0", attempts: [{ outcome: "retry", errorCode: "RATE_LIMIT" }, { outcome: "completed", errorCode: null }] }],
      // Auditor A's record is the one a whole-snapshot audit writes before its call; auditor B's is final.
      ["discovery-scopes-auditor-a", { scopes: [{ scopeId: "whole", paths: ["src/roles.ts"] }] }],
      ["discovery-scopes-auditor-b", { scopes: [{ scopeId: "scope-c" }, { scopeId: "scope-e" }, { scopeId: "scope-f", declined: "provider_failed" }, { scopeId: "scope-g", declined: "provider_failed" }, { scopeId: "window-h", declined: "reply_rejected" }] }],
    ]);
    const descriptors: ProgressDescriptor[] = [...contents.keys()].map((kind) => ({ artifactId: `${kind}-0123456789abcdef`, kind, nodeId: kind.startsWith("findings-auditor-a") ? "auditor-a" : kind.startsWith("findings-auditor-b") ? "auditor-b" : null }));
    descriptors.push({ artifactId: "discovery-declined-auditor-a-scope-dddddddddddddddddddddddd-01", kind: "discovery-declined-auditor-a-scope-dddddddddddddddddddddddd", nodeId: "auditor-a" });
    const read: string[] = [];
    const progress = await summariseProgress({
      runId, state: "DISCOVERY_RUNNING", live: true, now: at(10), graph, events: [state("CREATED", 0), dispatched("preflight", 0), completed("preflight", 1), dispatched("auditor-a", 1), dispatched("auditor-b", 1), completed("auditor-b", 9)],
      configuration: { models: { "auditor-a": { modelId: "claude-opus-5-5" }, "auditor-b": { modelId: "gpt-6.1-sol" } }, workflow: { modelExecution: { maximumTokens: 65_000_000, timeoutMs: 900_000 } } },
      descriptors, traces: [trace("auditor-a", 1_000, 200), trace("auditor-a", 500, null), trace("auditor-b", null, null), trace("semantic-clustering", 10, 5)],
      digest: async (descriptor) => { read.push(descriptor.kind); return digestArtifact(descriptor.kind, contents.get(descriptor.kind), descriptor.nodeId ?? null); },
    });
    // A finished auditor's units, answered and not, from its record of them: one at 2 of 5 is not a whole opinion.
    expect(progress.auditors).toEqual([
      { auditorId: "auditor-a", modelId: "claude-opus-5-5", partsRead: 2, partsDeclined: 1, findings: 3, finished: false, coverage: null },
      { auditorId: "auditor-b", modelId: "gpt-6.1-sol", partsRead: 1, partsDeclined: 0, findings: 2, finished: true, coverage: { units: 5, answered: 2, notExamined: { provider_failed: 2, reply_rejected: 1 } } },
    ]);
    expect(progress.found.total).toBe(5);
    expect(progress.found.bySeverity).toEqual({ critical: 1, high: 2, medium: 1, low: 1, informational: 0 });
    expect(progress.found.items.map(({ title, severity, path, line, auditorId }) => `${severity} ${title} ${path}:${line} ${auditorId}`)).toEqual([
      "critical Token logged src/log.ts:3 auditor-a", "high Role check missing src/roles.ts:40 auditor-a", "high Injected text followed docs/notes.md:1 auditor-b",
      "medium Stale cache src/cache.ts:12 auditor-b", "low Unbounded retry src/retry.ts:8 auditor-a",
    ]);
    // A finished auditor's unit records are not read again; its own record holds them.
    expect(read).not.toContain("findings-auditor-b-scope-cccccccccccccccccccccccc");
    expect(progress.tokens).toEqual({ used: 1_715, callsWithoutUsage: 1, limit: 65_000_000 });
    expect(progress.stages.find(({ nodeId }) => nodeId === "auditor-a")).toMatchObject({ status: "running", calls: 2, tokens: 1_700, runningSince: at(1) });
    expect(progress.stages.find(({ nodeId }) => nodeId === "consensus")).toMatchObject({ status: "waiting", calls: 1, tokens: 15 });
    expect(progress.restarted).toEqual({ afterTimeout: 1, timeoutMs: 900_000, activities: ["auditor-a/scope-aaaaaaaaaaaaaaaaaaaaaaaa/discovery/turn-0"] });
    expect(progress.readAt).toBe(at(10));
  });

  it("reads a scripted run, which has no model and no finding of its own per part, without failing", async () => {
    const progress = await summariseProgress({ runId, state: "COMPLETED", live: false, now: at(2), graph, events: [state("CREATED", 0), state("COMPLETED", 2)], configuration: undefined,
      descriptors: [{ artifactId: "findings-auditor-a-1", kind: "findings-auditor-a", nodeId: "auditor-a" }], traces: [],
      digest: async () => digestArtifact("findings-auditor-a", [finding("Null value", "unknown-severity", "a.ts", 1)], "auditor-a") });
    // Without a record of its units, a finished auditor's coverage is not guessed.
    expect(progress.auditors[0]).toEqual({ auditorId: "auditor-a", modelId: null, partsRead: 1, partsDeclined: 0, findings: 1, finished: true, coverage: null });
    expect(progress.found.items[0]?.severity).toBe("informational");
    expect(progress.tokens).toEqual({ used: 0, callsWithoutUsage: 0, limit: null });
  });
});
