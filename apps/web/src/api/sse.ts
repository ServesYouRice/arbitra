/**
 * One event of a run's server-sent event stream (`GET /runs/:id/events`). `from` and `to` are a `host_suspended` event's
 * sleep, or a `model_route_switched` event's profiles (`to` null: none was left, and the run paused), with its
 * `reason`, `spentUsd`, `resetsAt` and `effort`; `action`, `kind`, `result` and `until` are what a `helper_action`
 * event says the run helper did; `step`, `from`, `to`, `resetsAt` and `detail` are an `optional_step_limited` event's
 * optional step and the models it left and went to (`to` null: the run went on without it); `profile`, `resetsAt`,
 * `until` and `outcome` are a `model_waiting` or `model_wait_ended` event's model profile whose calls wait in place
 * for its usage limit to reset, and how their wait ended.
 */
export interface RunEvent { readonly t: string; readonly runId: string; readonly state?: string; readonly nodeId?: string; readonly activityId?: string; readonly reason?: string; readonly replayed?: boolean; readonly attempt?: number; readonly effortCollapse?: string; readonly semanticState?: string; readonly from?: string; readonly to?: string | null;
  readonly at?: string; readonly spentUsd?: number | null; readonly resetsAt?: string; readonly effort?: string; readonly action?: string; readonly kind?: string; readonly result?: string; readonly until?: string;
  readonly step?: string; readonly detail?: string; readonly profile?: string; readonly outcome?: string }
