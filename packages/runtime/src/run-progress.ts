import type { RunEvent } from "@arbitra/core/runner/events.js";
import type { RunnerGraph } from "@arbitra/core/runner/workflow-runner.js";
import type { ModelActivityTraceRecord } from "@arbitra/persistence/trace.js";
import { PROGRESS_SEVERITIES, type AuditorProgress, type FoundIssue, type ProgressSeverity, type ProgressTime, type RunProgress, type StageProgress } from "@arbitra/schemas/run-progress.js";

/** States in which the run is not working: it finished, failed, waits on a person or on a limit. */
const STOPPED = new Set(["COMPLETED", "FAILED", "BLOCKED", "CANCELLED", "SUSPENDED_BUDGET", "SUSPENDED_RATE_LIMIT"]);
/** Model activities recorded under a name of their own that belong to a graph node's work. */
const ACTIVITY_STAGES: Readonly<Record<string, string>> = Object.freeze({ "semantic-clustering": "consensus", "peer-review": "consensus", "peer-conflict": "consensus", "critique-check": "critic" });
const UNIT_FINDINGS = /^findings-(.+)-((?:scope|window)-[0-9a-f]{24})$/u;
const DECLINED_UNIT = /^discovery-declined-(.+)-((?:scope|window|whole)[0-9a-f-]*)$/u;
const ACTIVITY_TRACE = /^model-activity-[0-9a-f]{64}-trace$/u;

export interface ProgressDescriptor { readonly artifactId: string; readonly kind: string; readonly nodeId?: string | null }

/** What one artifact contributes, kept small so a cache of many stays small. Artifacts never change, so neither does this. */
export type ArtifactDigest =
  | { readonly kind: "findings"; readonly items: readonly FoundIssue[] }
  | { readonly kind: "trace"; readonly activityId: string; readonly timedOutAndRetried: boolean }
  | { readonly kind: "other" };

export interface ProgressInput {
  readonly runId: string;
  readonly state: string;
  readonly live: boolean;
  readonly now: string;
  readonly events: readonly RunEvent[];
  readonly graph: RunnerGraph | undefined;
  readonly configuration: { readonly models?: Readonly<Record<string, { readonly modelId?: string }>>; readonly workflow?: Readonly<Record<string, unknown>> } | undefined;
  readonly descriptors: readonly ProgressDescriptor[];
  /** The digest of an artifact this read needs: per-unit and final findings, and model activity traces. */
  readonly digest: (descriptor: ProgressDescriptor) => Promise<ArtifactDigest>;
  readonly traces: readonly ModelActivityTraceRecord[];
}

/** The artifacts whose content the progress read needs; every other artifact is counted by its kind alone. */
export function needsDigest(kind: string): boolean {
  return kind.startsWith("findings-") || ACTIVITY_TRACE.test(kind);
}

/** Read the parts of an artifact the progress needs from its parsed content. */
export function digestArtifact(kind: string, content: unknown, nodeId: string | null): ArtifactDigest {
  if (ACTIVITY_TRACE.test(kind)) {
    const value = record(content);
    const attempts = Array.isArray(value["attempts"]) ? value["attempts"].map(record) : [];
    // An attempt the computer's sleep cut was sent again for the sleep, not for running past its time limit.
    return { kind: "trace", activityId: typeof value["activityId"] === "string" ? value["activityId"] : nodeId ?? kind,
      timedOutAndRetried: attempts.some((attempt) => attempt["outcome"] === "retry" && attempt["errorCode"] === "TIMEOUT" && attempt["suspended"] === undefined) };
  }
  if (kind.startsWith("findings-") && Array.isArray(content)) {
    const auditorId = nodeId ?? kind.slice("findings-".length);
    return { kind: "findings", items: content.map(record).map((finding): FoundIssue => {
      const location = Array.isArray(finding["locations"]) ? record(finding["locations"][0]) : {};
      const severity = PROGRESS_SEVERITIES.includes(finding["severity"] as ProgressSeverity) ? finding["severity"] as ProgressSeverity : "informational";
      return { title: typeof finding["title"] === "string" ? finding["title"] : "untitled", severity, path: typeof location["path"] === "string" ? location["path"] : null,
        line: typeof location["startLine"] === "number" ? location["startLine"] : null, auditorId };
    }) };
  }
  return { kind: "other" };
}

export async function summariseProgress(input: ProgressInput): Promise<RunProgress> {
  const nodeIds = input.graph?.nodes.map(({ id }) => id) ?? [];
  const auditorIds = (input.graph?.nodes ?? []).filter(({ id, kind }) => kind === "model" && id.startsWith("auditor-")).map(({ id }) => id);
  const { run, stages } = timeline(input.events, nodeIds, input.state, input.live);
  const byStage = new Map<string, { calls: number; tokens: number }>();
  let used = 0; let withoutUsage = 0;
  for (const trace of input.traces) {
    const stage = nodeIds.includes(trace.nodeId) ? trace.nodeId : ACTIVITY_STAGES[trace.nodeId] ?? trace.nodeId;
    const entry = byStage.get(stage) ?? { calls: 0, tokens: 0 };
    const tokens = trace.tokenUsage === null ? null : (trace.tokenUsage.inputTokens ?? 0) + (trace.tokenUsage.outputTokens ?? 0);
    entry.calls += 1; entry.tokens += tokens ?? 0;
    byStage.set(stage, entry);
    if (tokens === null) withoutUsage += 1; else used += tokens;
  }

  const auditors: AuditorProgress[] = [];
  const items: FoundIssue[] = [];
  for (const auditorId of auditorIds) {
    const final = input.descriptors.findLast(({ kind }) => kind === `findings-${auditorId}`);
    const units = input.descriptors.filter(({ kind }) => UNIT_FINDINGS.exec(kind)?.[1] === auditorId);
    const declined = input.descriptors.filter(({ kind }) => DECLINED_UNIT.exec(kind)?.[1] === auditorId).length;
    // The auditor's final record holds every unit's findings and its follow-ups; until it exists, the units' do.
    const sources = final === undefined ? units : [final];
    const found = (await Promise.all(sources.map(async (descriptor) => { const digest = await input.digest(descriptor); return digest.kind === "findings" ? digest.items : []; }))).flat()
      .map((item) => ({ ...item, auditorId }));
    items.push(...found);
    auditors.push({ auditorId, modelId: input.configuration?.models?.[auditorId]?.modelId ?? null, partsRead: units.length === 0 && final !== undefined ? 1 : units.length, partsDeclined: declined,
      findings: found.length, finished: final !== undefined });
  }
  const rank = (severity: ProgressSeverity): number => PROGRESS_SEVERITIES.indexOf(severity);
  const ordered = items.map((item, index) => ({ item, index })).sort((a, b) => rank(a.item.severity) - rank(b.item.severity) || a.index - b.index).map(({ item }) => item);
  const bySeverity = Object.fromEntries(PROGRESS_SEVERITIES.map((severity) => [severity, items.filter((item) => item.severity === severity).length])) as Record<ProgressSeverity, number>;

  const retried = new Set<string>();
  for (const descriptor of input.descriptors.filter(({ kind }) => ACTIVITY_TRACE.test(kind))) {
    const digest = await input.digest(descriptor);
    if (digest.kind === "trace" && digest.timedOutAndRetried) retried.add(digest.activityId);
  }
  const execution = record(input.configuration?.workflow?.["modelExecution"]);
  return Object.freeze({
    runId: input.runId, state: input.state, live: input.live, readAt: input.now, run,
    stages: Object.freeze(stages.map((stage) => Object.freeze({ ...stage, calls: byStage.get(stage.nodeId)?.calls ?? 0, tokens: byStage.get(stage.nodeId)?.tokens ?? 0 }))),
    auditors: Object.freeze(auditors),
    found: Object.freeze({ total: items.length, bySeverity: Object.freeze(bySeverity), items: Object.freeze(ordered) }),
    tokens: Object.freeze({ used, callsWithoutUsage: withoutUsage, limit: typeof execution["maximumTokens"] === "number" ? execution["maximumTokens"] : null }),
    restarted: Object.freeze({ afterTimeout: retried.size, timeoutMs: typeof execution["timeoutMs"] === "number" ? execution["timeoutMs"] : null, activities: Object.freeze([...retried].sort()) }),
  });
}

interface Clock { elapsed: number | null; open: string | null; startedAt: string | null; endedAt: string | null }
const newClock = (): Clock => ({ elapsed: 0, open: null, startedAt: null, endedAt: null });
const add = (clock: Clock, from: string | null, to: string | undefined): void => {
  if (clock.elapsed === null) return;
  const span = from === null || to === undefined ? Number.NaN : Date.parse(to) - Date.parse(from);
  clock.elapsed = Number.isFinite(span) ? clock.elapsed + Math.max(0, span) : null;
};

/**
 * Each node's status and working time, and the run's, from the event sequence. A node works from its dispatch to its
 * completion, or to the run's stop when the run paused, failed or was cancelled first. A dispatch whose completion is
 * a replay of an earlier attempt adds no time. A run works from each start or resume to its next stop.
 */
export function timeline(events: readonly RunEvent[], nodeIds: readonly string[], state: string, live: boolean): { readonly run: ProgressTime; readonly stages: readonly Omit<StageProgress, "calls" | "tokens">[] } {
  const run = newClock();
  const nodes = new Map(nodeIds.map((id) => [id, { clock: newClock(), completed: false, replayedOnly: true, interrupted: false }]));
  // An open interval's start is its event's time, or "" when that event has none.
  const close = (at: string | undefined): void => {
    if (run.open !== null) { add(run, run.open || null, at); run.open = null; run.endedAt = at ?? null; }
    for (const node of nodes.values()) if (node.clock.open !== null) {
      node.clock.startedAt ??= node.clock.open || null;
      add(node.clock, node.clock.open || null, at);
      node.clock.open = null; node.interrupted = true;
    }
  };
  let lastAt: string | undefined;
  for (const event of events) {
    if (event.t === "run_transition" && event.state === "CREATED") {
      // A run whose process ended without recording a stop worked until its last recorded event.
      close(lastAt);
      run.open = event.at ?? ""; run.startedAt ??= event.at ?? null;
    } else if (event.t === "run_transition") {
      if (STOPPED.has(event.state)) close(event.at);
    } else if (event.t === "node_dispatched" || event.t === "node_completed") {
      const node = nodes.get(event.nodeId);
      if (node !== undefined && event.t === "node_dispatched") { node.clock.open = event.at ?? ""; node.interrupted = false; }
      else if (node !== undefined && event.t === "node_completed") {
        if (!event.replayed) { node.clock.startedAt ??= node.clock.open || null; add(node.clock, node.clock.open || null, event.at); node.clock.endedAt = event.at ?? null; node.replayedOnly = false; }
        node.clock.open = null; node.completed = true; node.interrupted = false;
      }
    }
    lastAt = event.at ?? lastAt;
  }
  const working = !STOPPED.has(state);
  const time = (clock: Clock): ProgressTime => {
    const open = clock.open === null || clock.open === "" ? null : clock.open;
    // An interval still open without its start time leaves the total unknown.
    return { elapsedMs: clock.open === "" ? null : clock.elapsed, runningSince: live && working ? open : null, startedAt: clock.startedAt ?? open, endedAt: clock.open === null ? clock.endedAt : null };
  };
  return {
    run: time(run),
    stages: [...nodes].map(([nodeId, node]) => {
      const open = node.clock.open !== null;
      const status: StageProgress["status"] = open && working ? "running" : node.completed ? node.replayedOnly ? "reused" : "done"
        : working ? "waiting" : node.interrupted || open ? state === "FAILED" ? "failed" : "stopped" : "waiting";
      return { nodeId, status, ...time(node.clock) };
    }),
  };
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
