import type { ActivityArtifactRef, ActivityRecord } from "../activity.js";
import type { RunState, RunnerJournalRecord } from "./events.js";

export interface RunnerProjection {
  readonly state: RunState;
  readonly completed: ReadonlyMap<string, ActivityArtifactRef>;
  readonly attempts: ReadonlyMap<string, number>;
  readonly completedNodeIds: ReadonlySet<string>;
}

export function projectRunState(records: readonly RunnerJournalRecord[]): RunState {
  let state: RunState = "CREATED";
  for (const record of records) {
    if (record.t === "run_transition") state = record.state;
  }
  return state;
}

export function projectRunner(records: readonly RunnerJournalRecord[]): RunnerProjection {
  const completed = new Map<string, ActivityArtifactRef>();
  const attempts = new Map<string, number>();
  const completedNodeIds = new Set<string>();
  for (const record of records) {
    if (record.t === "attempt_start") {
      attempts.set(record.id, Math.max(attempts.get(record.id) ?? 0, record.attempt));
    } else if (record.t === "end") {
      completed.set(record.id, record.artifact);
    } else if (record.t === "node_completed") {
      completedNodeIds.add(record.nodeId);
    }
  }
  return { state: projectRunState(records), completed, attempts, completedNodeIds };
}

export function isActivityRecord(record: RunnerJournalRecord): record is ActivityRecord {
  return record.t === "attempt_start" || record.t === "attempt_error" || record.t === "end";
}

