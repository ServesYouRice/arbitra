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

/**
 * `at` is when the run store wrote the event (ISO-8601). The runner never sets it: the store reads the wall clock at the
 * composition boundary, and events recorded before it did have none.
 */
export type RunEvent =
  | { readonly t: "run_transition"; readonly runId: string; readonly state: RunState; readonly reason?: string; readonly at?: string }
  | { readonly t: "node_dispatched"; readonly runId: string; readonly nodeId: string; readonly activityId: string; readonly at?: string }
  | { readonly t: "node_completed"; readonly runId: string; readonly nodeId: string; readonly activityId: string; readonly replayed: boolean; readonly at?: string }
  /** The computer slept (was suspended) from `from` to `to` (ISO-8601) while the run was live. The composition root
   * records it as it sees the wake; the runner never does. */
  | { readonly t: "host_suspended"; readonly runId: string; readonly from: string; readonly to: string; readonly at?: string }
  /** What the run helper did about a stop (packages/runtime/src/run-helper.ts): the reason it read and the kind it read
   * it as, its action (`wait`, `resume`, `leave`, `resume-refused`, `wait-ended`) and why, and the time it waits for.
   * The composition root records it while the run is stopped; the runner never does. */
  | { readonly t: "helper_action"; readonly runId: string; readonly action: string; readonly reason: string; readonly kind: string; readonly result: string; readonly until?: string; readonly at?: string };

export type RunnerJournalRecord = ActivityRecord | RunEvent;

export interface RunnerJournalPort {
  append(record: RunnerJournalRecord, durability?: "cheap" | "expensive"): Promise<void>;
}

export function isRunEvent(record: unknown): record is RunEvent {
  if (typeof record !== "object" || record === null || Array.isArray(record)) return false;
  const value = record as Record<string, unknown>;
  if (typeof value["runId"] !== "string" || value["runId"] === "") return false;
  if (value["at"] !== undefined && (typeof value["at"] !== "string" || Number.isNaN(Date.parse(value["at"])))) return false;
  if (value["t"] === "run_transition") return typeof value["state"] === "string" && RUN_STATES.includes(value["state"] as RunState) && (value["reason"] === undefined || typeof value["reason"] === "string");
  if (value["t"] === "node_dispatched") return typeof value["nodeId"] === "string" && value["nodeId"] !== "" && typeof value["activityId"] === "string" && value["activityId"] !== "";
  if (value["t"] === "node_completed") return typeof value["nodeId"] === "string" && value["nodeId"] !== "" && typeof value["activityId"] === "string" && value["activityId"] !== "" && typeof value["replayed"] === "boolean";
  if (value["t"] === "host_suspended") return [value["from"], value["to"]].every((time) => typeof time === "string" && !Number.isNaN(Date.parse(time)));
  if (value["t"] === "helper_action") return typeof value["action"] === "string" && value["action"] !== "" && typeof value["reason"] === "string" && typeof value["kind"] === "string" && typeof value["result"] === "string"
    && (value["until"] === undefined || (typeof value["until"] === "string" && !Number.isNaN(Date.parse(value["until"]))));
  return false;
}
