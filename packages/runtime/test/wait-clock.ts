import type { WaitClock } from "../src/limit-waits.js";

/**
 * A clock for calls that wait in place for a usage limit, whose time moves only when a test moves it. A sleep ends when
 * `advance` passes its time, and is refused as soon as its signal aborts. A test moves the clock only once the sleeps it
 * means to end are `pending`: one begun after the move would wait for the next (a run helper test learned that on a
 * loaded machine, November 21, 2026).
 */
export class FakeWaitClock implements WaitClock {
  time: number;
  #sleeps: { readonly due: number; readonly wake: () => void }[] = [];

  /** Starts at 11:20 UTC on November 21, 2026: when a real-project audit's Sol met Codex's limit, seven minutes before its reset. */
  constructor(start = Date.parse("2026-11-21T11:20:00.000Z")) { this.time = start; }

  now(): number { return this.time; }

  sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason as Error); return; }
      const sleep = { due: this.time + milliseconds, wake: () => { signal.removeEventListener("abort", abort); resolve(); } };
      const abort = (): void => { this.#sleeps = this.#sleeps.filter((each) => each !== sleep); reject(signal.reason as Error); };
      signal.addEventListener("abort", abort, { once: true });
      this.#sleeps.push(sleep);
    });
  }

  /** How long each pending sleep has left, in the order they began. */
  get pending(): readonly number[] { return this.#sleeps.map(({ due }) => due - this.time); }

  advance(milliseconds: number): void {
    this.time += milliseconds;
    const due = this.#sleeps.filter((sleep) => sleep.due <= this.time).sort((a, b) => a.due - b.due);
    this.#sleeps = this.#sleeps.filter((sleep) => !due.includes(sleep));
    for (const sleep of due) sleep.wake();
  }
}
