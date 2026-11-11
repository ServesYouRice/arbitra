import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunEvent } from "@arbitra/core/runner/events.js";
import { readFailure, readResumeRefusal, type FailureKind, type FailureReading } from "./failure-kinds.js";
import type { RunObserver } from "./orchestrator.js";
import { RunStore, runsDirectoryOf } from "./run-store.js";
import { readUsageWindows, type UsageWindow, type UsageWindows, type VendorUsage } from "./usage-windows.js";

/**
 * The run helper (WORK-REMAINING, "Run helper", step 2): it follows each run this process starts or resumes, and when
 * one stops on a `resume-now` failure (failure-kinds.ts) it waits, then resumes it. Plain code, no model call:
 *
 * - a usage limit waits until its reset (a minute after it), and with no reset given, until the vendor's usage
 *   window has room (usage-windows.ts); a window that cannot be read is left to the owner;
 * - a time-out or a provider failure waits a few minutes;
 * - at most two automatic resumes per run, none for a stop that came back after one, and none for a run the owner
 *   cancelled;
 * - on by default, off for a run with `workflow.autoResume: false` and for all runs with `helper.autoResume: false`
 *   in `<state directory>/settings.json`.
 *
 * Every other kind is left to the owner, with the words the run page shows. Each action is recorded in the run's store
 * (`helper-actions.json`: time, reason read, action, result) and emitted on its event stream as a `helper_action`
 * event, so the run page shows "resumed by the helper at 14:02, because …". The wait is in that record, not only in
 * memory, so a restart of arbitra picks it up. Observed live (memoria, November 2026): a restart dropped the
 * orchestrator's in-memory wake-up, and the run had to be resumed by hand.
 */

/** What the helper needs of the orchestrator (`Orchestrator` gives all of it). */
export interface HelperOrchestrator {
  readonly stateDirectory: string;
  runIds(): Promise<readonly string[]>;
  status(runId: string): Promise<{ readonly state: string }>;
  events(runId: string): AsyncIterable<RunEvent>;
  resume(runId: string): Promise<unknown>;
  observe(observer: RunObserver): () => void;
}

/** The helper's clock, injected by its tests. */
export interface HelperClock {
  now(): number;
  setTimer(callback: () => void, milliseconds: number): unknown;
  clearTimer(timer: unknown): void;
}

export const SYSTEM_CLOCK: HelperClock = {
  // arbitra-determinism: allow -- a wait is wall-clock scheduling at the composition boundary, outside any run
  now: () => Date.now(),
  setTimer: (callback, milliseconds) => {
    // A pending wait never keeps the process alive on its own.
    const timer = setTimeout(callback, Math.min(Math.max(0, milliseconds), MAXIMUM_TIMER_MS));
    timer.unref();
    return timer;
  },
  clearTimer: (timer) => { clearTimeout(timer as ReturnType<typeof setTimeout>); },
};

/** The global switch, `helper.autoResume` in settings; on unless set to false. */
export interface HelperSettings { autoResume(): Promise<boolean> }

/**
 * `<state directory>/settings.json`, read at each decision so a change counts without a restart. A missing file, or
 * one that does not say `"helper": { "autoResume": false }`, leaves the helper on.
 */
export function settingsFile(stateDirectory: string): HelperSettings {
  return {
    autoResume: async () => {
      try {
        const settings = JSON.parse(await readFile(join(stateDirectory, "settings.json"), "utf8")) as { readonly helper?: { readonly autoResume?: unknown } } | null;
        return settings?.helper?.autoResume !== false;
      } catch { return true; }
    },
  };
}

/**
 * A model's reading of a stop no rule names, from the reason and the run's state only. Left for later: without one,
 * such a stop is `unknown`, and an unknown stop is never resumed.
 */
export interface StopReader { read(facts: { readonly reason: string; readonly state: string }): Promise<FailureKind | "unknown"> }

export type HelperActionName = "wait" | "resume" | "leave" | "resume-refused" | "wait-ended";
export interface HelperAction {
  readonly at: string;
  /** The failure reason the helper read, as the run recorded it. */
  readonly reason: string;
  readonly kind: FailureKind | "unknown";
  readonly rule: string;
  readonly action: HelperActionName;
  /** Why, in words: what it waits for, or why it did not resume. */
  readonly result: string;
  readonly until?: string;
}
export interface HelperWait {
  readonly until: string;
  /** Resume at `until`, or read the usage window again then. */
  readonly then: "resume" | "check-window";
  /** The stop it waits on, by the position of its transition in the run's events. */
  readonly stopIndex: number;
  readonly stop: string;
  readonly reason: string;
  readonly kind: FailureKind | "unknown";
  readonly rule: string;
  readonly vendor?: "codex" | "claude";
}
/** The helper's record of one run, in `helper-actions.json` beside its events. */
export interface HelperRecord {
  readonly version: 1;
  readonly actions: readonly HelperAction[];
  readonly wait: HelperWait | null;
  readonly resumes: number;
  /** The stops the helper resumed after (`<rule>:<provider>`); one that comes back is not resumed again. */
  readonly resumedFor: readonly string[];
  readonly cancelled: boolean;
  /** The last stop decided on, by the position of its transition in the run's events; -1 before any. */
  readonly handledStop: number;
}

const EMPTY: HelperRecord = Object.freeze({ version: 1, actions: [], wait: null, resumes: 0, resumedFor: [], cancelled: false, handledStop: -1 });

/** At most this many automatic resumes per run. */
export const MAXIMUM_AUTOMATIC_RESUMES = 2;
/** A time-out or a provider failure is resumed this long after it. */
export const RETRY_WAIT_MS = 5 * 60_000;
/** A usage limit is resumed this long after its reset. */
export const AFTER_RESET_MS = 60_000;
/** How often a full usage window with no reset time is read again. */
export const WINDOW_RECHECK_MS = 30 * 60_000;
/** Seven days covers a weekly allowance; a reset further away is left to the owner. */
export const MAXIMUM_WAIT_MS = 7 * 24 * 3_600_000;
const MAXIMUM_TIMER_MS = 2_147_483_647;
/** A reason is recorded at this length at most; the run's events keep it whole. */
const REASON_CHARACTERS = 2_000;
/** The states the helper acts on: a failed run, and one paused on a usage limit. */
const STOPS = new Set(["FAILED", "SUSPENDED_RATE_LIMIT"]);

export interface RunHelperOptions {
  readonly orchestrator: HelperOrchestrator;
  readonly clock?: HelperClock;
  /** The global switch; `settingsFile(orchestrator.stateDirectory)` by default. */
  readonly settings?: HelperSettings;
  /** What the vendors' usage windows say now; `readUsageWindows` by default. */
  readonly windows?: () => Promise<UsageWindows>;
  /** Reads a stop no rule names; none is built yet, so such a stop is unknown. */
  readonly reader?: StopReader;
}

export class RunHelper {
  readonly #orchestrator: HelperOrchestrator;
  readonly #clock: HelperClock;
  readonly #settings: HelperSettings;
  readonly #windows: () => Promise<UsageWindows>;
  readonly #reader: StopReader | undefined;
  readonly #runs: string;
  readonly #timers = new Map<string, unknown>();
  /** Runs being followed, and whether one went live again while its following was ending. */
  readonly #following = new Map<string, boolean>();
  /** Runs the helper is resuming itself, which are not the owner's resume. */
  readonly #resuming = new Set<string>();
  /** Each run's work is done one piece at a time. */
  readonly #queues = new Map<string, Promise<unknown>>();
  #unobserve: (() => void) | null = null;

  constructor(options: RunHelperOptions) {
    this.#orchestrator = options.orchestrator;
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#settings = options.settings ?? settingsFile(options.orchestrator.stateDirectory);
    this.#windows = options.windows ?? (() => readUsageWindows());
    this.#reader = options.reader;
    this.#runs = runsDirectoryOf(options.orchestrator.stateDirectory);
  }

  /**
   * Starts following runs, and takes up the waits recorded before a restart. Stops recorded before it started are not
   * decided on again: only the waits it had set.
   */
  async start(): Promise<void> {
    if (this.#unobserve !== null) return;
    this.#unobserve = this.#orchestrator.observe({
      live: (runId) => { this.#live(runId); },
      cancelled: async (runId) => await this.#serial(runId, () => this.#cancelled(runId)),
    });
    for (const runId of await this.#orchestrator.runIds()) {
      const record = await this.#load(runId).catch(() => null);
      if (record !== null && record.wait !== null && !record.cancelled) this.#schedule(runId, record.wait.until);
    }
  }

  /** Stops following runs; the waits stay recorded for the next start. */
  stop(): void {
    this.#unobserve?.(); this.#unobserve = null;
    for (const timer of this.#timers.values()) this.#clock.clearTimer(timer);
    this.#timers.clear();
  }

  /** The helper's record of a run; an empty one before it has done anything there. */
  async record(runId: string): Promise<HelperRecord> { return await this.#load(runId); }

  /** Settles once every piece of work already queued for the run is done (for tests and shutdown). */
  async idle(runId: string): Promise<void> {
    for (let queued = this.#queues.get(runId); queued !== undefined; queued = this.#queues.get(runId)) {
      await queued.catch(() => undefined);
      if (this.#queues.get(runId) === queued) return;
    }
  }

  #live(runId: string): void {
    if (!this.#resuming.has(runId)) {
      // The owner resumed it: a wait for it ends here.
      const timer = this.#timers.get(runId);
      if (timer !== undefined) { this.#clock.clearTimer(timer); this.#timers.delete(runId); }
      void this.#serial(runId, () => this.#ownerResumed(runId)).catch(() => undefined);
    }
    if (this.#following.has(runId)) { this.#following.set(runId, true); return; }
    this.#follow(runId);
  }

  #follow(runId: string): void {
    this.#following.set(runId, false);
    void (async () => {
      try { for await (const event of this.#orchestrator.events(runId)) void event; }
      catch { /* a run whose events cannot be read is not the helper's to decide */ }
      await this.#serial(runId, () => this.#settled(runId)).catch(() => undefined);
    })().finally(() => {
      const again = this.#following.get(runId) === true;
      this.#following.delete(runId);
      if (again) this.#follow(runId);
    });
  }

  async #serial<T>(runId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(runId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.#queues.set(runId, next);
    try { return await next; }
    finally { if (this.#queues.get(runId) === next) this.#queues.delete(runId); }
  }

  /** The run's last stop, if it is stopped where the helper acts: its reason and the position of its transition. */
  async #stop(runId: string): Promise<{ readonly state: string; readonly reason: string; readonly index: number } | null> {
    const { state } = await this.#orchestrator.status(runId);
    if (!STOPS.has(state)) return null;
    const events = await this.#store(runId).loadEvents();
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.t === "run_transition") return event.state === state ? { state, reason: event.reason ?? "", index } : null;
    }
    return null;
  }

  async #settled(runId: string): Promise<void> {
    const stop = await this.#stop(runId);
    if (stop === null) return;
    const record = await this.#load(runId);
    if (stop.index <= record.handledStop) return;
    const reading = readFailure(stop.reason);
    const kind = reading.kind === "inside-arbitra" && reading.rule === "unnamed" ? await this.#readUnnamed(stop) : reading.kind;
    const read = { reason: stop.reason.slice(0, REASON_CHARACTERS), kind, rule: reading.rule };
    const handled: HelperRecord = { ...record, handledStop: stop.index, wait: null };
    const leave = async (result: string): Promise<void> => { await this.#act(runId, handled, { ...read, action: "leave", result }); };
    if (record.cancelled) return await leave("The owner cancelled this run, so the helper does not resume it.");
    if (kind !== "resume-now") return await leave(LEFT[kind]);
    if (!await this.#enabled(runId)) return await leave("Automatic resume is off for this run, so it waits for you.");
    if (record.resumes >= MAXIMUM_AUTOMATIC_RESUMES) return await leave(`The helper has resumed this run ${MAXIMUM_AUTOMATIC_RESUMES} times already, so it waits for you.`);
    const key = stopKey(reading);
    if (record.resumedFor.includes(key)) return await leave("The same stop came back after the helper resumed the run, so another resume would likely repeat it.");
    const plan = await this.#waitFor(reading);
    if ("leave" in plan) return await leave(plan.leave);
    const wait: HelperWait = { ...read, until: plan.until, then: plan.then, stopIndex: stop.index, stop: key, ...(plan.vendor === undefined ? {} : { vendor: plan.vendor }) };
    await this.#act(runId, { ...handled, wait }, { ...read, action: "wait", result: plan.result, until: plan.until });
    this.#schedule(runId, plan.until);
  }

  async #readUnnamed(stop: { readonly state: string; readonly reason: string }): Promise<FailureKind | "unknown"> {
    if (this.#reader === undefined) return "unknown";
    try { return await this.#reader.read({ reason: stop.reason, state: stop.state }); } catch { return "unknown"; }
  }

  async #enabled(runId: string): Promise<boolean> {
    if (!await this.#settings.autoResume().catch(() => true)) return false;
    const context = await this.#store(runId).loadContext().catch(() => null);
    return context?.modelConfiguration?.workflow["autoResume"] !== false;
  }

  /** How long a `resume-now` stop waits, and what then; or why it is left to the owner. */
  async #waitFor(reading: FailureReading): Promise<{ readonly until: string; readonly then: HelperWait["then"]; readonly result: string; readonly vendor?: HelperWait["vendor"] } | { readonly leave: string }> {
    const now = this.#clock.now();
    if (reading.rule !== "usage-limit") return { until: iso(now + RETRY_WAIT_MS), then: "resume", result: `The helper resumes the run ${RETRY_WAIT_MS / 60_000} minutes after it stopped.` };
    if (reading.resetsAt !== null) {
      const until = Date.parse(reading.resetsAt) + AFTER_RESET_MS;
      if (until - now > MAXIMUM_WAIT_MS) return { leave: "The limit resets more than a week from now, so the run waits for you." };
      return { until: iso(until), then: "resume", result: "The helper resumes the run a minute after the limit resets." };
    }
    const vendor = vendorOf(reading.cli);
    if (vendor === null) return { leave: "The provider gave no reset time, and arbitra cannot read this limit's usage window, so the run waits for you: resume it once the limit has reset." };
    const window = await this.#window(vendor, now);
    return "leave" in window ? window : { ...window, vendor };
  }

  /** When a vendor's usage window has room again, as its meter says now. */
  async #window(vendor: "codex" | "claude", now: number): Promise<{ readonly until: string; readonly then: HelperWait["then"]; readonly result: string } | { readonly leave: string }> {
    const usage: VendorUsage = await this.#windows().then((windows) => windows[vendor], () => ({ state: "not_read" as const, reason: "the usage windows could not be read" }));
    if (usage.state !== "read") return { leave: `The provider gave no reset time, and the usage window was not read (${usage.reason}), so the run waits for you: resume it once the limit has reset.` };
    const full = [usage.fiveHour, usage.week].filter((window): window is UsageWindow => window !== null && window.usedPercent >= 100);
    if (full.length === 0) return { until: iso(now + RETRY_WAIT_MS), then: "resume", result: "The usage window has room again, so the helper resumes the run in a few minutes." };
    const resets = full.map(({ resetsAt }) => resetsAt === null ? Number.NaN : Date.parse(resetsAt));
    if (resets.every(Number.isFinite)) {
      const until = Math.max(...resets) + AFTER_RESET_MS;
      if (until - now > MAXIMUM_WAIT_MS) return { leave: "The usage window resets more than a week from now, so the run waits for you." };
      return { until: iso(Math.max(now, until)), then: "resume", result: "The helper resumes the run a minute after the usage window resets." };
    }
    return { until: iso(now + WINDOW_RECHECK_MS), then: "check-window", result: "The usage window is full and gives no reset time, so the helper reads it again in half an hour." };
  }

  #schedule(runId: string, until: string): void {
    const previous = this.#timers.get(runId);
    if (previous !== undefined) this.#clock.clearTimer(previous);
    const timer = this.#clock.setTimer(() => {
      if (this.#timers.get(runId) === timer) this.#timers.delete(runId);
      void this.#serial(runId, () => this.#wake(runId)).catch(() => undefined);
    }, Date.parse(until) - this.#clock.now());
    this.#timers.set(runId, timer);
  }

  async #wake(runId: string): Promise<void> {
    const record = await this.#load(runId);
    const wait = record.wait;
    if (wait === null || record.cancelled) return;
    const read = { reason: wait.reason, kind: wait.kind, rule: wait.rule };
    const ended = { ...record, wait: null };
    const stop = await this.#stop(runId);
    // The run went on, or stopped again since, before the wait ended: the wait is for a stop that is no longer there.
    if (stop === null || stop.index !== wait.stopIndex) return await this.#save(runId, { ...ended, actions: [...record.actions, { ...read, at: iso(this.#clock.now()), action: "wait-ended", result: "The run was no longer stopped where the helper was waiting." }] });
    if (!await this.#enabled(runId)) return await this.#act(runId, ended, { ...read, action: "leave", result: "Automatic resume was turned off during the wait, so the run waits for you." });
    if (wait.then === "check-window" && wait.vendor !== undefined) {
      const window = await this.#window(wait.vendor, this.#clock.now());
      if ("leave" in window) return await this.#act(runId, ended, { ...read, action: "leave", result: window.leave });
      if (window.then === "check-window" || Date.parse(window.until) > this.#clock.now() + RETRY_WAIT_MS) {
        await this.#act(runId, { ...record, wait: { ...wait, until: window.until, then: window.then } }, { ...read, action: "wait", result: window.result, until: window.until });
        return this.#schedule(runId, window.until);
      }
    }
    await this.#act(runId, { ...ended, resumes: record.resumes + 1, resumedFor: [...record.resumedFor, wait.stop] }, { ...read, action: "resume", result: "The helper resumed the run." });
    this.#resuming.add(runId);
    try { await this.#orchestrator.resume(runId); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const refusal = readResumeRefusal(message);
      const after = await this.#load(runId);
      // A run already live again records the refusal only: its events belong to the run that is working.
      const action: Omit<HelperAction, "at"> = { ...read, action: "resume-refused", result: `The resume was refused: ${message.slice(0, REASON_CHARACTERS)}` };
      if (refusal.rule === "run-already-live") await this.#save(runId, { ...after, actions: [...after.actions, { ...action, at: iso(this.#clock.now()) }] });
      else await this.#act(runId, after, action);
    } finally { this.#resuming.delete(runId); }
  }

  async #ownerResumed(runId: string): Promise<void> {
    const record = await this.#load(runId);
    if (record.wait === null) return;
    // The run is live again, so this is recorded in the helper's record only, not on the run's events.
    await this.#save(runId, { ...record, wait: null, actions: [...record.actions, { reason: record.wait.reason, kind: record.wait.kind, rule: record.wait.rule, at: iso(this.#clock.now()), action: "wait-ended", result: "The run was resumed before the wait ended." }] });
  }

  async #cancelled(runId: string): Promise<boolean> {
    const timer = this.#timers.get(runId);
    if (timer !== undefined) { this.#clock.clearTimer(timer); this.#timers.delete(runId); }
    const record = await this.#load(runId).catch(() => null);
    if (record === null) return false;
    const wait = record.wait;
    const cancelled: HelperRecord = { ...record, cancelled: true, wait: null };
    if (wait === null) { await this.#save(runId, cancelled); return false; }
    await this.#act(runId, cancelled, { reason: wait.reason, kind: wait.kind, rule: wait.rule, action: "wait-ended", result: "The owner cancelled the run, so the helper no longer resumes it." });
    return true;
  }

  /** Records an action in the helper's record, then on the run's events (the run is stopped whenever this is called). */
  async #act(runId: string, record: HelperRecord, action: Omit<HelperAction, "at">): Promise<void> {
    const at = iso(this.#clock.now());
    await this.#save(runId, { ...record, actions: [...record.actions, { ...action, at }] });
    await this.#store(runId).appendEvent({ t: "helper_action", runId, action: action.action, reason: action.reason, kind: action.kind, result: action.result, ...(action.until === undefined ? {} : { until: action.until }), at }, "expensive");
  }

  #store(runId: string): RunStore { return new RunStore(this.#runs, runId); }

  async #load(runId: string): Promise<HelperRecord> {
    const value = await this.#store(runId).loadHelperActions();
    return isRecord(value) ? value : EMPTY;
  }

  async #save(runId: string, record: HelperRecord): Promise<void> { await this.#store(runId).saveHelperActions(record); }
}

/** Why the helper leaves a stop of each kind other than `resume-now` to the owner. */
const LEFT: Readonly<Record<Exclude<FailureKind, "resume-now"> | "unknown", string>> = Object.freeze({
  "fix-computer": "Something on this computer needs fixing first, so the run waits for you.",
  "start-again": "A resume would stop the same way, so the run waits for you.",
  "inside-arbitra": "The run stopped inside arbitra, so the run waits for you.",
  unknown: "No rule names this stop, so the run waits for you.",
});

/** A stop, as the helper tells one from another: its rule and the provider it names. */
function stopKey(reading: FailureReading): string {
  return `${reading.rule}:${"provider" in reading ? reading.provider ?? "" : ""}`;
}

/** The vendor whose usage window a subscription's limit is, from the CLI the reason names; an API's credit has none. */
function vendorOf(cli: string | null): "codex" | "claude" | null {
  if (cli === null) return null;
  return /codex/iu.test(cli) ? "codex" : /claude/iu.test(cli) ? "claude" : null;
}

const iso = (time: number): string => new Date(time).toISOString();

function isRecord(value: unknown): value is HelperRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<HelperRecord>;
  return record.version === 1 && Array.isArray(record.actions) && typeof record.resumes === "number" && Array.isArray(record.resumedFor) && typeof record.cancelled === "boolean" && typeof record.handledStop === "number";
}
