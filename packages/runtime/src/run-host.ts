import type { RunEvent } from "@arbitra/core/runner/events.js";
import type { TransportFactoryOptions } from "@arbitra/providers/registry.js";
import { AWAKE_SETTLE_MS, SuspendMonitor, type HostSuspend, type SuspendWatch } from "@arbitra/providers/suspend.js";
import { ProcessKeepAwake, type KeepAwake } from "./keep-awake.js";

/** What a live run takes from the computer it runs on: kept awake, and its sleeps watched and recorded. */
export interface RunHost {
  readonly keepAwake: KeepAwake;
  readonly suspends: SuspendWatch & { onSuspend(listener: (suspend: HostSuspend) => void): () => void };
}

/** Where a held run's sleeps are recorded: the run's own store, the one its runner appends to. */
export interface HostEventSink { readonly runId: string; appendEvent(event: RunEvent): Promise<void> }

let processWide: RunHost | undefined;

/**
 * This process's host, shared by every orchestrator in it: one keep-awake holder counted by live runs, and one suspend
 * monitor. The CLI and the server pass it to their orchestrator; tests pass a fake, so no real holder starts.
 */
export function processHost(): RunHost {
  return processWide ??= Object.freeze({ keepAwake: new ProcessKeepAwake(), suspends: new SuspendMonitor() });
}

/**
 * The provider options every stage passes on to its model calls, with the host's suspends, so each call waits for the
 * computer to be awake and is sent again when a sleep cuts it. Suspends the options name already (a test's) are kept.
 */
export function withHostSuspends(options: TransportFactoryOptions, host: RunHost | undefined): TransportFactoryOptions {
  return host === undefined || options.suspends !== undefined ? options : { ...options, suspends: host.suspends };
}

/**
 * Holds the computer for one live run until `result` settles (completed, failed, paused, cancelled): keeps it awake,
 * and records each suspend seen meanwhile as a `host_suspended` run event. Neither ever fails the run.
 */
export function holdForRun(host: RunHost, store: HostEventSink, result: Promise<unknown>): void {
  let release: () => void = () => {};
  try { release = host.keepAwake.hold(); } catch { /* a computer that cannot be kept awake still runs */ }
  const stop = host.suspends.onSuspend((suspend) => {
    void store.appendEvent({ t: "host_suspended", runId: store.runId, from: new Date(suspend.from).toISOString(), to: new Date(suspend.to).toISOString() }).catch(() => undefined);
  });
  void result.finally(() => { stop(); release(); }).catch(() => undefined);
}

/**
 * When the computer slept during a run, from its `host_suspended` events. A Mac asleep wakes in the dark for 10–60 s
 * about every 15 minutes, and each wake ends one recorded suspend, so suspends apart by less than the time a call waits
 * for the computer to be awake read as one sleep.
 */
export function sleptSpans(events: readonly RunEvent[]): readonly { readonly from: string; readonly to: string }[] {
  const spans: { from: number; to: number }[] = [];
  const suspends = events.flatMap((event) => event.t === "host_suspended" ? [{ from: Date.parse(event.from), to: Date.parse(event.to) }] : []).sort((a, b) => a.from - b.from);
  for (const suspend of suspends) {
    const last = spans.at(-1);
    if (last !== undefined && suspend.from - last.to < AWAKE_SETTLE_MS) last.to = Math.max(last.to, suspend.to);
    else spans.push({ ...suspend });
  }
  return spans.map(({ from, to }) => Object.freeze({ from: new Date(from).toISOString(), to: new Date(to).toISOString() }));
}
