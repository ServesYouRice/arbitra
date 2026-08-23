import type { ActivityRecord } from "../activity.js";

export const RUN_STATES = [
  "CREATED",
  "SNAPSHOTTED",
  "PREFLIGHT_COMPLETE",
  "DISCOVERY_RUNNING",
  "DISCOVERY_COMPLETE",
  "CLUSTERED",
  "PEER_REVIEW_RUNNING",
  "CONSENSUS_PRELIMINARY",
  "VERIFYING",
  "CONSENSUS_COMPLETE",
  "PLANNING",
  "PLAN_REVIEW",
  "PLAN_REVISION",
  "COMPILED",
  "COMPLETED",
  "FAILED",
  "BLOCKED",
  "CANCELLED",
  "SUSPENDED_BUDGET",
  "SUSPENDED_RATE_LIMIT",
] as const;

export type RunState = (typeof RUN_STATES)[number];

export type RunEvent =
  | { readonly t: "run_transition"; readonly runId: string; readonly state: RunState; readonly reason?: string }
  | { readonly t: "node_dispatched"; readonly runId: string; readonly nodeId: string; readonly activityId: string }
  | { readonly t: "node_completed"; readonly runId: string; readonly nodeId: string; readonly activityId: string; readonly replayed: boolean };

export type RunnerJournalRecord = ActivityRecord | RunEvent;

export interface RunnerJournalPort {
  append(record: RunnerJournalRecord, durability?: "cheap" | "expensive"): Promise<void>;
}

export function isRunEvent(record: RunnerJournalRecord): record is RunEvent {
  return record.t === "run_transition" || record.t === "node_dispatched" || record.t === "node_completed";
}

