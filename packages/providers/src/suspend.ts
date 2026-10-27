/**
 * Whether the computer slept (suspended) while calls were in flight, and whether it has been awake long enough since.
 *
 * What a suspend does to this process's clocks, read from libuv 1.49.2 (Node 22.14) and the platforms' documentation
 * (October 27, 2026). Node's timers run on libuv's loop clock and `performance.now()` on `uv_hrtime()`, which read one
 * source; `Date.now()` is the wall clock, which moves on across a suspend everywhere.
 *
 * - darwin: `mach_continuous_time()`, which counts sleep. kqueue's wait does not, but the first time the loop runs in a
 *   wake (any I/O, any short timer) every timer due by then fires at once. A 15-minute stage timeout started before an
 *   idle sleep therefore runs out in a 10–60 s dark wake. Observed live (October 26, 2026, macOS, pmset): calls in
 *   flight timed out in dark wakes, each retry was sent in another, and the run failed as provider timeouts.
 * - win32: `QueryPerformanceCounter()`, which Microsoft documents as counting standby, hibernate and connected standby.
 *   The completion-port wait does not count low-power time (Windows 8 and later), so a due timer fires at the first
 *   wake, as on macOS.
 * - linux: `CLOCK_MONOTONIC` (or its coarse twin), which stops while suspended: neither the timers nor
 *   `performance.now()` count the suspend, a 15-minute timer fires its remaining awake time after the resume, and only
 *   `Date.now()` jumps. A call's stream can still break across it.
 *
 * So a suspend shows as a gap between two looks far longer than the heartbeat: on the wall clock on every platform, and
 * on the monotonic clock as well on darwin and win32. arbitra never stalls its event loop that long (its longest
 * synchronous wait, taskkill, is bounded at 10 s). A wall clock set forward by hand reads as a suspend too, which costs
 * at most a call sent again and a short wait.
 */

/** A span the computer was suspended, in wall-clock milliseconds: from the last look before it to the first after. */
export interface HostSuspend { readonly from: number; readonly to: number }

/** What the provider runtime asks of the host: the time, the suspends an attempt lived through, and whether to dispatch yet. */
export interface SuspendWatch {
  /** The wall clock, in milliseconds. */
  now(): number;
  /** The suspends that ended after `since`, including one in evidence now that the heartbeat has not seen yet. */
  suspendsSince(since: number): readonly HostSuspend[];
  /** Resolves once the computer has been awake for `AWAKE_SETTLE_MS` since its last suspend (at once when it has); rejects when `signal` aborts. */
  awake(signal: AbortSignal): Promise<void>;
}

/** A host that never sleeps: the default where nothing watches. */
export const NO_SUSPENDS: SuspendWatch = Object.freeze({ now: () => Date.now(), suspendsSince: () => [], awake: () => Promise.resolve() });

export interface SuspendClock {
  readonly wall: () => number;
  readonly monotonic: () => number;
  /** Calls `tick` every `milliseconds` until the returned function is called; it never keeps the process alive. */
  readonly every: (milliseconds: number, tick: () => void) => () => void;
}

/** How often the monitor looks at the clocks. */
export const SUSPEND_HEARTBEAT_MS = 5_000;
/** How much longer than the heartbeat a gap must be to be a suspend. */
export const SUSPEND_GAP_MS = 30_000;
/**
 * How long the computer must be awake after a suspend before a call starts. A Mac asleep on AC power wakes in the dark
 * for 10–60 s about every 15 minutes (pmset -g log, October 26, 2026): a call started there is cut by the next sleep.
 * Two minutes is twice the longest of those.
 */
export const AWAKE_SETTLE_MS = 120_000;
/** Suspends kept for `suspendsSince`; an attempt lasts minutes, so the last few are all that is ever asked about. */
const KEPT_SUSPENDS = 256;

const systemClock: SuspendClock = {
  wall: () => Date.now(),
  monotonic: () => performance.now(),
  every: (milliseconds, tick) => { const handle = setInterval(tick, milliseconds); handle.unref(); return () => clearInterval(handle); },
};

/** The process's watch on its clocks: a heartbeat, and a look at every question, so a wake is seen before a due timer is read as a timeout. */
export class SuspendMonitor implements SuspendWatch {
  readonly #clock: SuspendClock;
  #wall: number;
  #monotonic: number;
  readonly #suspends: HostSuspend[] = [];
  readonly #listeners = new Set<(suspend: HostSuspend) => void>();
  readonly #waiters = new Set<() => void>();
  readonly #stop: () => void;

  constructor(clock: SuspendClock = systemClock) {
    this.#clock = clock;
    this.#wall = clock.wall(); this.#monotonic = clock.monotonic();
    this.#stop = clock.every(SUSPEND_HEARTBEAT_MS, () => this.#look());
  }

  now(): number { return this.#clock.wall(); }

  suspendsSince(since: number): readonly HostSuspend[] { this.#look(); return this.#suspends.filter(({ to }) => to > since); }

  awake(signal: AbortSignal): Promise<void> {
    this.#look();
    if (this.#settled()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const abort = (): void => { this.#waiters.delete(wake); reject(signal.reason instanceof Error ? signal.reason : new Error("SUSPEND_WAIT_CANCELLED")); };
      const wake = (): void => { this.#waiters.delete(wake); signal.removeEventListener("abort", abort); resolve(); };
      if (signal.aborted) { abort(); return; }
      this.#waiters.add(wake);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  /** Calls `listener` with each suspend as it is seen; the returned function stops it. */
  onSuspend(listener: (suspend: HostSuspend) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  close(): void { this.#stop(); }

  #look(): void {
    const wall = this.#clock.wall(); const monotonic = this.#clock.monotonic();
    const gap = Math.max(wall - this.#wall, monotonic - this.#monotonic);
    const from = this.#wall;
    this.#wall = wall; this.#monotonic = monotonic;
    if (gap > SUSPEND_HEARTBEAT_MS + SUSPEND_GAP_MS) {
      const suspend: HostSuspend = Object.freeze({ from, to: wall });
      this.#suspends.push(suspend);
      if (this.#suspends.length > KEPT_SUSPENDS) this.#suspends.shift();
      for (const listener of [...this.#listeners]) try { listener(suspend); } catch { /* a listener's failure is its own */ }
    }
    if (this.#settled()) for (const wake of [...this.#waiters]) wake();
  }

  #settled(): boolean {
    const last = this.#suspends.at(-1);
    return last === undefined || this.#wall - last.to >= AWAKE_SETTLE_MS;
  }
}
