/**
 * What a run has done so far, read from its own records (`GET /runs/:id/progress`): which stage it is in and for how
 * long, how many parts of the project each finding model has read, the issues found before any check, the tokens
 * used and the model calls started again after their time limit. The run page's watch line reads only this.
 *
 * Times are the run store's write times of the run's events. A run recorded before the store wrote them has none, and
 * every time here is then null rather than guessed.
 */
export type ProgressSeverity = "critical" | "high" | "medium" | "low" | "informational";
export const PROGRESS_SEVERITIES: readonly ProgressSeverity[] = Object.freeze(["critical", "high", "medium", "low", "informational"]);

/** Time spent working, summed over the intervals the records show. */
export interface ProgressTime {
  /** Closed intervals only; null when an event they need has no time. */
  readonly elapsedMs: number | null;
  /** The start of the interval still open, while this control plane executes the run; add `readAt − runningSince`. */
  readonly runningSince: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
}

export interface StageProgress extends ProgressTime {
  readonly nodeId: string;
  /** `reused`: completed only from an earlier attempt's records; `stopped`: running when the run paused, blocked or was cancelled. */
  readonly status: "waiting" | "running" | "done" | "reused" | "failed" | "stopped";
  /** Model calls recorded for the stage, and their reported input and output tokens. */
  readonly calls: number;
  readonly tokens: number;
}

export interface AuditorProgress {
  readonly auditorId: string;
  readonly modelId: string | null;
  /** Discovery units (parts of the project) whose findings are recorded. */
  readonly partsRead: number;
  /** Units the model declined or answered unusably, recorded as unexamined. */
  readonly partsDeclined: number;
  readonly findings: number;
  /** The auditor's whole discovery is recorded. */
  readonly finished: boolean;
}

export interface FoundIssue {
  readonly title: string;
  readonly severity: ProgressSeverity;
  readonly path: string | null;
  readonly line: number | null;
  readonly auditorId: string;
}

/** Discovery's findings as reported, before duplicates are merged or any is checked. Most severe first. */
export interface FoundSoFar {
  readonly total: number;
  readonly bySeverity: Readonly<Record<ProgressSeverity, number>>;
  readonly items: readonly FoundIssue[];
}

export interface TokensSoFar {
  /** Reported input and output tokens of every recorded model call. */
  readonly used: number;
  /** Recorded calls whose provider reported no usage; `used` leaves them out. */
  readonly callsWithoutUsage: number;
  /** The run's token limit, when it has one. */
  readonly limit: number | null;
}

export interface RestartedCalls {
  /** Model calls that ran past their time limit and were started again. */
  readonly afterTimeout: number;
  readonly timeoutMs: number | null;
  /** The activity of each such call. */
  readonly activities: readonly string[];
}

export interface RunProgress {
  readonly runId: string;
  readonly state: string;
  /** Whether this control plane is executing the run. */
  readonly live: boolean;
  /** When this was read, by the server's clock. */
  readonly readAt: string;
  readonly run: ProgressTime;
  /** One entry per node of the run's graph, in the graph's order. */
  readonly stages: readonly StageProgress[];
  readonly auditors: readonly AuditorProgress[];
  readonly found: FoundSoFar;
  readonly tokens: TokensSoFar;
  readonly restarted: RestartedCalls;
}
