/** One event of a run's server-sent event stream (`GET /runs/:id/events`). */
export interface RunEvent { readonly t: string; readonly runId: string; readonly state?: string; readonly nodeId?: string; readonly activityId?: string; readonly reason?: string; readonly replayed?: boolean; readonly attempt?: number; readonly effortCollapse?: string; readonly semanticState?: string }
