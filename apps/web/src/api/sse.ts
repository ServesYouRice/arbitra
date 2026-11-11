/**
 * One event of a run's server-sent event stream (`GET /runs/:id/events`). `from` and `to` are a `host_suspended` event's
 * sleep, or a `model_route_switched` event's profiles (`to` null: none was left, and the run paused), with its
 * `reason`, `spentUsd`, `resetsAt` and `effort`.
 */
export interface RunEvent { readonly t: string; readonly runId: string; readonly state?: string; readonly nodeId?: string; readonly activityId?: string; readonly reason?: string; readonly replayed?: boolean; readonly attempt?: number; readonly effortCollapse?: string; readonly semanticState?: string; readonly from?: string; readonly to?: string | null;
  readonly at?: string; readonly spentUsd?: number | null; readonly resetsAt?: string; readonly effort?: string }
