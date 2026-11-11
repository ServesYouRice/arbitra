import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEvent, RunState } from "@arbitra/core/runner/events.js";
import { runConfigSchema } from "@arbitra/schemas/config.js";
import type { RunObserver } from "../src/orchestrator.js";
import { AFTER_RESET_MS, RETRY_WAIT_MS, RunHelper, WINDOW_RECHECK_MS, type HelperClock, type HelperOrchestrator } from "../src/run-helper.js";
import { listRunIds, RunStore, runsDirectoryOf } from "../src/run-store.js";
import type { UsageWindows, VendorUsage } from "../src/usage-windows.js";

const START = Date.parse("2026-11-11T12:00:00.000Z");
const MINUTE = 60_000;
const at = (offset: number): string => new Date(START + offset).toISOString();
const usage = (until: string | null, cli = "Codex CLI"): string =>
  `ProviderUsageLimitError: Provider openai reached its usage limit (QUOTA: CLI_USAGE_LIMIT_REACHED: the ${cli} subscription's usage allowance is exhausted${until === null ? "" : ` until ${until}`}); the run pauses with its completed work kept and goes on when resumed after the reset.`;
const TIMEOUT = "ProviderInvocationFailure: Provider openai failed after 3 attempts (TIMEOUT: Provider stage timed out after 900000ms)";
const UPSTREAM = "ProviderInvocationFailure: Provider anthropic failed after 1 attempt (HTTP: CLI_UPSTREAM_ERROR: Claude Code could not reach its service); completed artifacts are preserved and the run may resume with degraded completeness.";

/** A clock whose time moves only when a test moves it, firing the timers that come due on the way. */
class FakeClock implements HelperClock {
  time = START;
  #timers: { readonly due: number; readonly fire: () => void }[] = [];
  now(): number { return this.time; }
  setTimer(fire: () => void, milliseconds: number): unknown { const timer = { due: this.time + Math.max(0, milliseconds), fire }; this.#timers.push(timer); return timer; }
  clearTimer(timer: unknown): void { this.#timers = this.#timers.filter((each) => each !== timer); }
  pending(): number { return this.#timers.length; }
  advance(milliseconds: number): void {
    this.time += milliseconds;
    for (const timer of this.#timers.filter(({ due }) => due <= this.time).sort((a, b) => a.due - b.due)) { this.clearTimer(timer); timer.fire(); }
  }
}

/**
 * The orchestrator as the helper sees it, over a real run store: a run goes live, records its transitions, and stops
 * where the test says. A resume starts it again, and `afterResume` says how it ends (completed, unless set).
 */
class FakeOrchestrator implements HelperOrchestrator {
  readonly resumed: string[] = [];
  afterResume: (runId: string) => Promise<void> = async (runId) => { await this.end(runId, "COMPLETED"); };
  readonly #observers = new Set<RunObserver>();
  readonly #live = new Map<string, () => void>();
  constructor(readonly stateDirectory: string) {}
  store(runId: string): RunStore { return new RunStore(runsDirectoryOf(this.stateDirectory), runId); }
  async runIds(): Promise<readonly string[]> { return await listRunIds(runsDirectoryOf(this.stateDirectory)); }
  async status(runId: string): Promise<{ readonly state: string }> {
    if (this.#live.has(runId)) return { state: "DISCOVERY_RUNNING" };
    const last = [...await this.store(runId).loadEvents()].reverse().find((event) => event.t === "run_transition");
    return { state: last?.t === "run_transition" ? last.state : "CREATED" };
  }
  async *events(runId: string): AsyncIterable<RunEvent> {
    let cursor = 0;
    while (true) {
      const settled = this.#live.has(runId) ? new Promise<void>((resolve) => { const previous = this.#live.get(runId); this.#live.set(runId, () => { previous?.(); resolve(); }); }) : null;
      const history = await this.store(runId).loadEvents();
      for (const event of history.slice(cursor)) yield event;
      cursor = history.length;
      if (settled === null) return;
      await settled;
    }
  }
  async resume(runId: string): Promise<unknown> {
    if (this.#live.has(runId)) throw new Error(`RUN_ALREADY_LIVE:${runId}`);
    this.resumed.push(runId);
    await this.begin(runId, "resumed");
    void Promise.resolve().then(() => this.afterResume(runId));
    return {};
  }
  observe(observer: RunObserver): () => void { this.#observers.add(observer); return () => { this.#observers.delete(observer); }; }
  /** The owner's cancel, as `Orchestrator.cancel` tells its observers. */
  async cancel(runId: string): Promise<boolean> {
    let waited = false;
    for (const observer of this.#observers) if (await observer.cancelled?.(runId) === true) waited = true;
    return waited;
  }
  async begin(runId: string, reason?: string): Promise<void> {
    await this.store(runId).appendEvent({ t: "run_transition", runId, state: "CREATED", ...(reason === undefined ? {} : { reason }) });
    this.#live.set(runId, () => undefined);
    for (const observer of this.#observers) observer.live?.(runId);
  }
  async end(runId: string, state: RunState, reason?: string): Promise<void> {
    await this.store(runId).appendEvent({ t: "run_transition", runId, state, ...(reason === undefined ? {} : { reason }) });
    const settle = this.#live.get(runId);
    this.#live.delete(runId);
    settle?.();
  }
  /** A run that starts and stops at once, as the helper sees one. */
  async stops(runId: string, state: RunState, reason: string): Promise<void> { await this.begin(runId); await this.end(runId, state, reason); }
}

const codex = (reading: VendorUsage): (() => Promise<UsageWindows>) => async () => ({ checkedAt: at(0), codex: reading, claude: { state: "not_read", reason: "Claude Code shows its usage windows only in a model call" } });
const full = (resetsAt: string | null): VendorUsage => ({ state: "read", fiveHour: { usedPercent: 100, resetsAt }, week: { usedPercent: 40, resetsAt: at(3 * 24 * 60 * MINUTE) }, plan: "plus" });
const room: VendorUsage = { state: "read", fiveHour: { usedPercent: 12, resetsAt: at(4 * 60 * MINUTE) }, week: { usedPercent: 40, resetsAt: null }, plan: "plus" };

describe("the run helper", () => {
  let directory: string;
  let clock: FakeClock;
  let orchestrator: FakeOrchestrator;
  let helpers: RunHelper[];
  const helper = async (options: Partial<ConstructorParameters<typeof RunHelper>[0]> = {}, on = orchestrator): Promise<RunHelper> => {
    const made = new RunHelper({ orchestrator: on, clock, windows: codex(room), ...options });
    helpers.push(made); await made.start(); return made;
  };
  const actions = async (runId: string, on = orchestrator) => (await on.store(runId).loadEvents()).flatMap((event) => event.t === "helper_action" ? [event] : []);
  const waiting = async (made: RunHelper, runId: string) => { await vi.waitFor(async () => { expect((await made.record(runId)).handledStop).toBeGreaterThanOrEqual(0); }); return await made.record(runId); };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "arbitra-helper-"));
    clock = new FakeClock(); orchestrator = new FakeOrchestrator(directory); helpers = [];
  });
  afterEach(async () => { for (const made of helpers) made.stop(); await rm(directory, { recursive: true, force: true }); });

  it("resumes a run paused on a usage limit a minute after the reset the provider gave", async () => {
    const made = await helper();
    await orchestrator.stops("run-1", "SUSPENDED_RATE_LIMIT", usage(at(60 * MINUTE)));
    const record = await waiting(made, "run-1");
    expect(record.wait).toMatchObject({ until: at(60 * MINUTE + AFTER_RESET_MS), then: "resume", kind: "resume-now", rule: "usage-limit" });
    expect(await actions("run-1")).toMatchObject([{ action: "wait", kind: "resume-now", until: at(60 * MINUTE + AFTER_RESET_MS), reason: usage(at(60 * MINUTE)) }]);
    clock.advance(60 * MINUTE);
    await made.idle("run-1");
    expect(orchestrator.resumed).toEqual([]);
    clock.advance(AFTER_RESET_MS);
    await vi.waitFor(() => { expect(orchestrator.resumed).toEqual(["run-1"]); });
    await vi.waitFor(async () => { expect((await orchestrator.status("run-1")).state).toBe("COMPLETED"); });
    expect((await actions("run-1")).map(({ action }) => action)).toEqual(["wait", "resume"]);
    // The resume is recorded before the run goes on, so the page reads "resumed by the helper at …, because …".
    const events = await orchestrator.store("run-1").loadEvents();
    expect(events.findIndex((event) => event.t === "helper_action" && event.action === "resume")).toBeLessThan(events.findIndex((event) => event.t === "run_transition" && event.reason === "resumed"));
    expect((await made.record("run-1")).actions.at(-1)).toMatchObject({ action: "resume", at: at(61 * MINUTE) });
  });

  it("waits for a usage window with no reset given until its meter says it resets, or reads it again until it has room", async () => {
    const made = await helper({ windows: codex(full(at(90 * MINUTE))) });
    await orchestrator.stops("run-1", "SUSPENDED_RATE_LIMIT", usage(null));
    expect((await waiting(made, "run-1")).wait).toMatchObject({ until: at(90 * MINUTE + AFTER_RESET_MS), then: "resume", vendor: "codex" });

    made.stop();
    let meter: VendorUsage = full(null);
    const reading = await helper({ windows: async () => await codex(meter)() });
    await orchestrator.stops("run-2", "SUSPENDED_RATE_LIMIT", usage(null));
    expect((await waiting(reading, "run-2")).wait).toMatchObject({ until: at(WINDOW_RECHECK_MS), then: "check-window" });
    clock.advance(WINDOW_RECHECK_MS);
    await vi.waitFor(async () => { expect((await reading.record("run-2")).actions).toHaveLength(2); });
    expect(orchestrator.resumed).toEqual([]);
    meter = room;
    clock.advance(WINDOW_RECHECK_MS);
    await vi.waitFor(() => { expect(orchestrator.resumed).toEqual(["run-2"]); });
    expect((await actions("run-2")).map(({ action }) => action)).toEqual(["wait", "wait", "resume"]);
  });

  it("leaves a usage limit to the owner when no reset was given and the window cannot be read", async () => {
    const made = await helper();
    await orchestrator.stops("run-1", "SUSPENDED_RATE_LIMIT", usage(null, "Claude Code"));
    await orchestrator.stops("run-2", "SUSPENDED_RATE_LIMIT", "ProviderUsageLimitError: Provider anthropic reached its usage limit (QUOTA: credit balance is too low)");
    for (const runId of ["run-1", "run-2"]) expect((await waiting(made, runId)).wait).toBeNull();
    expect((await actions("run-1"))[0]).toMatchObject({ action: "leave", kind: "resume-now", result: expect.stringContaining("the usage window was not read (Claude Code shows its usage windows only in a model call)") as unknown });
    expect((await actions("run-2"))[0]?.result).toMatch(/cannot read this limit's usage window/u);
    clock.advance(24 * 60 * MINUTE);
    expect(orchestrator.resumed).toEqual([]);
  });

  it.each([["a time-out", TIMEOUT, "time-limit"], ["a provider failure", UPSTREAM, "provider-failure"]])("resumes a run stopped by %s a few minutes later", async (_name, reason, rule) => {
    const made = await helper();
    await orchestrator.stops("run-1", "FAILED", reason);
    expect((await waiting(made, "run-1")).wait).toMatchObject({ until: at(RETRY_WAIT_MS), rule });
    clock.advance(RETRY_WAIT_MS - 1);
    await made.idle("run-1");
    expect(orchestrator.resumed).toEqual([]);
    clock.advance(1);
    await vi.waitFor(() => { expect(orchestrator.resumed).toEqual(["run-1"]); });
  });

  it.each([
    ["fix-computer", "ProviderInvocationFailure: Provider openai failed after 1 attempt (AUTH: Credential environment variable OPENAI_API_KEY is not set)"],
    ["start-again", "Error: MODEL_IDENTITY_PLACEHOLDER:auditor-a"],
    // A stop no rule names would go to the helper's model, which is not built yet: it is unknown, and never resumed.
    ["unknown", "TypeError: Cannot read properties of undefined (reading 'tasks')"],
  ])("leaves a %s stop to the owner, and says so on the run's events", async (kind, reason) => {
    const made = await helper();
    await orchestrator.stops("run-1", "FAILED", reason);
    expect((await waiting(made, "run-1")).wait).toBeNull();
    expect(await actions("run-1")).toMatchObject([{ action: "leave", kind, reason }]);
    expect(clock.pending()).toBe(0);
    expect(orchestrator.resumed).toEqual([]);
  });

  it("takes a model's reading of a stop no rule names, once one is given", async () => {
    const read = vi.fn(async () => "resume-now" as const);
    const made = await helper({ reader: { read } });
    await orchestrator.stops("run-1", "FAILED", "Error: something new");
    expect((await waiting(made, "run-1")).wait).toMatchObject({ kind: "resume-now", rule: "unnamed", until: at(RETRY_WAIT_MS) });
    expect(read).toHaveBeenCalledWith({ reason: "Error: something new", state: "FAILED" });
  });

  it("resumes a run at most twice, and not for a stop that came back after a resume", async () => {
    const made = await helper();
    // The first resume stops again on a time-out, the second on a provider failure, which is then left to the owner.
    const after = [TIMEOUT, UPSTREAM];
    orchestrator.afterResume = async (runId) => { await orchestrator.end(runId, "FAILED", after.shift() ?? TIMEOUT); };
    await orchestrator.stops("run-1", "SUSPENDED_RATE_LIMIT", usage(at(0)));
    await waiting(made, "run-1");
    clock.advance(AFTER_RESET_MS);
    await vi.waitFor(async () => { expect((await made.record("run-1")).wait?.rule).toBe("time-limit"); });
    clock.advance(RETRY_WAIT_MS);
    await vi.waitFor(async () => { expect((await actions("run-1")).at(-1)?.action).toBe("leave"); });
    expect(orchestrator.resumed).toEqual(["run-1", "run-1"]);
    expect((await made.record("run-1")).actions.map(({ action, rule }) => `${action}:${rule}`)).toEqual(["wait:usage-limit", "resume:usage-limit", "wait:time-limit", "resume:time-limit", "leave:provider-failure"]);
    expect((await actions("run-1")).at(-1)?.result).toBe("The helper has resumed this run 2 times already, so it waits for you.");

    // A time-out resumed once that comes back is not resumed again.
    orchestrator.afterResume = async (runId) => { await orchestrator.end(runId, "FAILED", TIMEOUT); };
    await orchestrator.stops("run-2", "FAILED", TIMEOUT);
    await waiting(made, "run-2");
    clock.advance(RETRY_WAIT_MS);
    await vi.waitFor(async () => { expect((await actions("run-2")).at(-1)?.action).toBe("leave"); });
    expect((await actions("run-2")).map(({ action }) => action)).toEqual(["wait", "resume", "leave"]);
    expect((await actions("run-2")).at(-1)?.result).toMatch(/^The same stop came back after the helper resumed the run/u);
  });

  it("never resumes a run the owner cancels during the wait, nor after", async () => {
    const made = await helper();
    await orchestrator.stops("run-1", "FAILED", TIMEOUT);
    await waiting(made, "run-1");
    expect(await orchestrator.cancel("run-1")).toBe(true);
    clock.advance(RETRY_WAIT_MS * 10);
    await made.idle("run-1");
    expect(orchestrator.resumed).toEqual([]);
    expect(await made.record("run-1")).toMatchObject({ cancelled: true, wait: null });
    expect((await actions("run-1")).map(({ action }) => action)).toEqual(["wait", "wait-ended"]);
    // Resumed by the owner later, it stops on a time-out again: the helper leaves it.
    await orchestrator.begin("run-1", "resumed"); await orchestrator.end("run-1", "FAILED", TIMEOUT);
    await vi.waitFor(async () => { expect((await actions("run-1")).at(-1)?.action).toBe("leave"); });
    expect(clock.pending()).toBe(0);
  });

  it("takes up a recorded wait after a restart of arbitra", async () => {
    const before = await helper();
    await orchestrator.stops("run-1", "SUSPENDED_RATE_LIMIT", usage(at(30 * MINUTE)));
    await waiting(before, "run-1");
    // The server stops: its timers go with it; the wait stays on disk.
    before.stop();
    clock.advance(10 * MINUTE);
    const restarted = new FakeOrchestrator(directory);
    await helper({}, restarted);
    expect(clock.pending()).toBe(1);
    clock.advance(21 * MINUTE);
    await vi.waitFor(() => { expect(restarted.resumed).toEqual(["run-1"]); });
    expect(orchestrator.resumed).toEqual([]);
  });

  it("ends its wait when the owner resumes the run first", async () => {
    const made = await helper();
    await orchestrator.stops("run-1", "FAILED", TIMEOUT);
    await waiting(made, "run-1");
    orchestrator.afterResume = async () => undefined;
    await orchestrator.begin("run-1", "resumed");
    await vi.waitFor(async () => { expect((await made.record("run-1")).wait).toBeNull(); });
    clock.advance(RETRY_WAIT_MS);
    expect(orchestrator.resumed).toEqual([]);
    expect((await made.record("run-1")).actions.map(({ action }) => action)).toEqual(["wait", "wait-ended"]);
  });

  it("is off for a run with workflow.autoResume false, and for all runs with helper.autoResume false in settings", async () => {
    const config = runConfigSchema.parse({ ...JSON.parse(readFileSync(new URL("../../schemas/test/golden/run-config.valid.json", import.meta.url), "utf8")) as object, workflow: { autoResume: false } });
    await orchestrator.store("run-1").saveContext({ repository: directory, repositoryDigest: "a".repeat(64), scope: { kind: "repository" }, consensusPolicy: "minimal", maximumRounds: 1, criticEnabled: false, modelConfiguration: config });
    const made = await helper();
    await orchestrator.stops("run-1", "FAILED", TIMEOUT);
    expect((await waiting(made, "run-1")).wait).toBeNull();
    expect((await actions("run-1"))[0]?.result).toBe("Automatic resume is off for this run, so it waits for you.");

    await writeFile(join(directory, "settings.json"), JSON.stringify({ helper: { autoResume: false } }));
    await orchestrator.stops("run-2", "FAILED", TIMEOUT);
    expect((await waiting(made, "run-2")).wait).toBeNull();
    // Turned off during a wait, the wait ends without a resume.
    await writeFile(join(directory, "settings.json"), JSON.stringify({ helper: { autoResume: true } }));
    await orchestrator.stops("run-3", "FAILED", TIMEOUT);
    await waiting(made, "run-3");
    await writeFile(join(directory, "settings.json"), JSON.stringify({ helper: { autoResume: false } }));
    clock.advance(RETRY_WAIT_MS);
    await vi.waitFor(async () => { expect((await actions("run-3")).at(-1)?.result).toBe("Automatic resume was turned off during the wait, so the run waits for you."); });
    expect(orchestrator.resumed).toEqual([]);
  });

  it("records a resume the orchestrator refuses, and does not try again", async () => {
    const made = await helper();
    await orchestrator.stops("run-1", "FAILED", TIMEOUT);
    await waiting(made, "run-1");
    orchestrator.resume = async () => { throw new Error("RUN_REPOSITORY_CHANGED:run-1: the repository no longer holds the files the run read."); };
    clock.advance(RETRY_WAIT_MS);
    await vi.waitFor(async () => { expect((await actions("run-1")).map(({ action }) => action)).toEqual(["wait", "resume", "resume-refused"]); });
    expect(await made.record("run-1")).toMatchObject({ wait: null, resumes: 1 });
    expect(clock.pending()).toBe(0);
  });
});
