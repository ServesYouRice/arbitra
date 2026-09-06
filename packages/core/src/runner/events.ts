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

export function isRunEvent(record: unknown): record is RunEvent {
  if (typeof record !== "object" || record === null || Array.isArray(record)) return false;
  const value = record as Record<string, unknown>;
  if (typeof value["runId"] !== "string" || value["runId"] === "") return false;
  if (value["t"] === "run_transition") return typeof value["state"] === "string" && RUN_STATES.includes(value["state"] as RunState) && (value["reason"] === undefined || typeof value["reason"] === "string");
  if (value["t"] === "node_dispatched") return typeof value["nodeId"] === "string" && value["nodeId"] !== "" && typeof value["activityId"] === "string" && value["activityId"] !== "";
  if (value["t"] === "node_completed") return typeof value["nodeId"] === "string" && value["nodeId"] !== "" && typeof value["activityId"] === "string" && value["activityId"] !== "" && typeof value["replayed"] === "boolean";
  return false;
}
