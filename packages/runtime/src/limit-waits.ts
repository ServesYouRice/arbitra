import { setTimeout as delay } from "node:timers/promises";
import type { ModelWaitOutcome } from "@arbitra/core/runner/events.js";
import { redactSecrets } from "@arbitra/security/redaction";
import type { RunStore } from "./run-store.js";

/** What a call that waits for a usage limit reads of the clock. Injected by tests, whose time moves only when they move it. */
export interface WaitClock {
  now(): number;
  /** Resolves once `milliseconds` have passed; rejects as soon as `signal` aborts. */
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

/** The computer's clock. A pending wait keeps the process alive as a call in flight does, so a command-line run that only waits goes on. */
export const SYSTEM_WAIT_CLOCK: WaitClock = Object.freeze({
  now: () => Date.now(),
  sleep: async (milliseconds: number, signal: AbortSignal) => { await delay(milliseconds, undefined, { signal }); },
});

/** One reset the calls of a profile wait for: the provider's reset, and when they are sent again (a minute after it). */
export interface LimitReset { readonly resetsAt: number; readonly until: number }

/** How one call's wait ended, and how long it waited. */
export interface WaitOutcome { readonly outcome: ModelWaitOutcome; readonly waitedMs: number }

/**
 * A later reset is recorded again when it is more than this much later: calls refused together reckon the same reset
 * from the provider's time a few milliseconds apart.
 */
const SAME_RESET_MS = 1_000;

/**
 * The calls of each model profile that wait in place for its subscription's usage limit to reset (ModelActivities), as
 * the run records them: a `model_waiting` event when the first starts to wait, or one waits for a later reset, and a
 * `model_wait_ended` event when the last stops. A call of the profile made meanwhile waits with them, unsent, rather than
 * be refused again: each refused CLI call starts a process, and keeps its estimate charged to the run's token budget
 * when it cannot show it read nothing. Nothing here holds a budget reservation or a provider's scheduler slot; a waiting
 * call holds only its own place in its stage.
 */
export class LimitWaits {
  readonly #waits = new Map<string, { resetsAt: number; until: number; calls: number }>();

  constructor(private readonly store: RunStore, private readonly clock: WaitClock) {}

  /** The reset the calls of `profile` wait for now; undefined when none waits, or the wait is over. */
  pending(profile: string): LimitReset | undefined {
    const wait = this.#waits.get(profile);
    return wait === undefined || wait.until <= this.clock.now() ? undefined : { resetsAt: wait.resetsAt, until: wait.until };
  }

  /**
   * Waits until `reset.until` for a call of `profile`. The wait ends early when `cancelled` aborts (the run is cancelled
   * or stopped) or `leftOut` does (the finder was left out of the run, so its answer is no longer needed), with that
   * outcome; a failure to record the wait fails the call.
   */
  async wait(profile: string, reset: LimitReset & { readonly detail: string }, signals: { readonly cancelled: AbortSignal; readonly leftOut: AbortSignal }): Promise<WaitOutcome> {
    const started = this.clock.now();
    let wait = this.#waits.get(profile);
    const announce = wait === undefined || reset.until > wait.until + SAME_RESET_MS;
    if (wait === undefined) { wait = { resetsAt: reset.resetsAt, until: reset.until, calls: 0 }; this.#waits.set(profile, wait); }
    else if (announce) { wait.resetsAt = reset.resetsAt; wait.until = reset.until; }
    wait.calls += 1;
    let outcome: ModelWaitOutcome | null = null;
    try {
      if (announce) {
        const detail = redactSecrets(reset.detail).text.slice(0, 300);
        await this.store.appendEvent({ t: "model_waiting", runId: this.store.runId, profile, resetsAt: iso(reset.resetsAt), until: iso(reset.until), ...(detail === "" ? {} : { detail }) }, "expensive");
      }
      try { await this.clock.sleep(Math.max(0, reset.until - this.clock.now()), AbortSignal.any([signals.cancelled, signals.leftOut])); outcome = "went_on"; }
      catch (error) {
        if (signals.cancelled.aborted) outcome = "cancelled";
        else if (signals.leftOut.aborted) outcome = "left_out";
        else throw error;
      }
    } finally {
      wait.calls -= 1;
      const last = wait.calls === 0 && this.#waits.get(profile) === wait;
      if (last) this.#waits.delete(profile);
      if (last && outcome !== null) {
        const ended = this.store.appendEvent({ t: "model_wait_ended", runId: this.store.runId, profile, outcome }, "expensive");
        // A call that stops waiting because it is not needed fails for that reason, even when the record of it fails.
        await (outcome === "went_on" ? ended : ended.catch(() => undefined));
      }
    }
    return { outcome, waitedMs: Math.max(0, this.clock.now() - started) };
  }
}

function iso(time: number): string { return new Date(time).toISOString(); }
