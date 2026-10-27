import { describe, expect, it } from "vitest";
import { AWAKE_SETTLE_MS, SUSPEND_HEARTBEAT_MS, SuspendMonitor, type HostSuspend, type SuspendClock } from "../src/suspend.js";

/**
 * A clock the test moves: `awake` moves both clocks and beats the heartbeat; `sleep` moves the wall clock, and the
 * monotonic one too where it counts sleep (darwin's mach_continuous_time, win32's QueryPerformanceCounter), and does
 * not beat: a suspended process runs no timer.
 */
function host(start = Date.parse("2026-10-26T10:00:00Z")) {
  let wall = start; let monotonic = 0; const ticks: (() => void)[] = [];
  const clock: SuspendClock = { wall: () => wall, monotonic: () => monotonic, every: (_milliseconds, tick) => { ticks.push(tick); return () => {}; } };
  const beat = (): void => { for (const tick of ticks) tick(); };
  return {
    clock, beat, at: () => wall,
    awake(milliseconds: number): void { for (let left = milliseconds; left > 0; left -= SUSPEND_HEARTBEAT_MS) { const step = Math.min(left, SUSPEND_HEARTBEAT_MS); wall += step; monotonic += step; beat(); } },
    sleep(milliseconds: number, monotonicCounts: boolean): void { wall += milliseconds; if (monotonicCounts) monotonic += milliseconds; },
  };
}

describe("the computer's suspends", () => {
  it("sees a suspend on the wall clock alone, as on Linux, and on both clocks, as on macOS and Windows; a short stall is none", () => {
    for (const monotonicCounts of [false, true]) {
      const h = host(); const monitor = new SuspendMonitor(h.clock); const seen: HostSuspend[] = [];
      monitor.onSuspend((suspend) => seen.push(suspend));
      h.awake(60_000);
      // A stall of the event loop under the gap is not a suspend.
      h.sleep(20_000, true); h.beat();
      expect(seen).toEqual([]);
      const asleep = h.at(); h.sleep(3_600_000, monotonicCounts); h.beat();
      expect(seen).toEqual([{ from: asleep, to: asleep + 3_600_000 }]);
      expect(monitor.suspendsSince(asleep - 1)).toEqual(seen);
      expect(monitor.suspendsSince(asleep + 3_600_000)).toEqual([]);
    }
  });

  it("sees a wake at the first question after it, before its heartbeat beats", () => {
    // On macOS a stage timeout due during the sleep fires in the same loop turn as the heartbeat, possibly first.
    const h = host(); const monitor = new SuspendMonitor(h.clock);
    h.awake(10_000); const asleep = h.at();
    h.sleep(900_000, true);
    expect(monitor.suspendsSince(asleep - 1)).toEqual([{ from: asleep, to: asleep + 900_000 }]);
    h.beat();
    expect(monitor.suspendsSince(0)).toHaveLength(1);
  });

  it("lets a call start only once the computer has been awake two minutes since its last sleep, and not in a dark wake", async () => {
    // Observed live (October 26, 2026, macOS, pmset): dark wakes of 10–60 s about every 15 minutes, each with a retry in it.
    const h = host(); const monitor = new SuspendMonitor(h.clock); const signal = new AbortController().signal;
    await expect(monitor.awake(signal)).resolves.toBeUndefined();
    h.sleep(900_000, true); h.beat();
    let woke = false; const waiting = monitor.awake(signal).then(() => { woke = true; });
    // A 30-second dark wake, then sleep again: still waiting.
    h.awake(30_000); await Promise.resolve(); expect(woke).toBe(false);
    h.sleep(900_000, true); h.beat(); h.awake(AWAKE_SETTLE_MS - SUSPEND_HEARTBEAT_MS); await Promise.resolve();
    expect(woke).toBe(false);
    h.awake(SUSPEND_HEARTBEAT_MS); await waiting;
    expect(woke).toBe(true);
    expect(monitor.suspendsSince(0)).toHaveLength(2);
  });

  it("stops waiting when the call is cancelled", async () => {
    const h = host(); const monitor = new SuspendMonitor(h.clock); const controller = new AbortController();
    h.sleep(900_000, false); h.beat();
    const waiting = monitor.awake(controller.signal);
    controller.abort(new Error("cancelled by the operator"));
    await expect(waiting).rejects.toThrow("cancelled by the operator");
  });
});
