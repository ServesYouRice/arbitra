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
  /** A model profile's work went to its fallback (`to`), or, with no fallback left (`to` null), the run paused. `reason`:
   * the account could not pay (`credit_out`), a subscription's usage limit resets later than the run waits
   * (`usage_limit`, with `resetsAt`), the profile reached its dollar cap (`cost_cap`), or the limit `from` was switched
   * from has reset and the work goes back (`reset`). `spentUsd` is what the profile had spent through its API, null
   * when it is not priced. The composition root records it; the runner never does. */
  | { readonly t: "model_route_switched"; readonly runId: string; readonly from: string; readonly to: string | null; readonly reason: ModelRouteReason;
      readonly spentUsd: number | null; readonly resetsAt?: string; readonly effort?: string; readonly detail?: string; readonly at?: string };

export const MODEL_ROUTE_REASONS = ["credit_out", "usage_limit", "cost_cap", "reset"] as const;
export type ModelRouteReason = (typeof MODEL_ROUTE_REASONS)[number];

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
  if (value["t"] === "model_route_switched") return typeof value["from"] === "string" && value["from"] !== "" && (value["to"] === null || typeof value["to"] === "string" && value["to"] !== "")
    && MODEL_ROUTE_REASONS.includes(value["reason"] as ModelRouteReason) && (value["spentUsd"] === null || typeof value["spentUsd"] === "number" && Number.isFinite(value["spentUsd"]) && value["spentUsd"] >= 0)
    && (value["resetsAt"] === undefined || typeof value["resetsAt"] === "string" && !Number.isNaN(Date.parse(value["resetsAt"])))
    && (value["effort"] === undefined || typeof value["effort"] === "string") && (value["detail"] === undefined || typeof value["detail"] === "string");
  return false;
}
