/**
 * One event of a run's server-sent event stream (`GET /runs/:id/events`); `from` and `to` are a `host_suspended` event's
 * sleep, and `action`, `kind`, `result` and `until` what a `helper_action` event says the run helper did.
 */
export interface RunEvent { readonly t: string; readonly runId: string; readonly state?: string; readonly nodeId?: string; readonly activityId?: string; readonly reason?: string; readonly replayed?: boolean; readonly attempt?: number; readonly effortCollapse?: string; readonly semanticState?: string; readonly from?: string; readonly to?: string;
  readonly action?: string; readonly kind?: string; readonly result?: string; readonly until?: string; readonly at?: string }
