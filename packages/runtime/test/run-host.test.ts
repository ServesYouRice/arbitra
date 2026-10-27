import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runConfigSchema } from "@arbitra/schemas/config.js";
import type { HttpClient } from "@arbitra/providers/transport-contract.js";
import type { HostSuspend, SuspendWatch } from "@arbitra/providers/suspend.js";
import { keepAwakeCommand, ProcessKeepAwake, type KeepAwake, type KeepAwakeHost } from "../src/keep-awake.js";
import { ModelActivities } from "../src/model-activities.js";
import { Orchestrator } from "../src/orchestrator.js";
import { sleptSpans, withHostSuspends, type RunHost } from "../src/run-host.js";
import { runReport } from "../src/run-report.js";
import { digestArtifact, timeline } from "../src/run-progress.js";
import { RunStore } from "../src/run-store.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

/** A holder process that never starts: it records how it was spawned and how it was ended. */
class FakeChild extends EventEmitter {
  killed = 0; stdinEnded = 0;
  readonly stdin: { end(): void; unref(): void } | null;
  constructor(piped: boolean) { super(); this.stdin = piped ? { end: () => { this.stdinEnded += 1; }, unref() {} } : null; }
  readonly stderr = Object.assign(new EventEmitter(), { setEncoding() {}, unref() {} });
  kill(): boolean { this.killed += 1; return true; }
  unref(): void {}
}
function fakeHost(platform: NodeJS.Platform, found: Readonly<Record<string, string>> = { caffeinate: "/usr/bin/caffeinate", "systemd-inhibit": "/usr/bin/systemd-inhibit" }) {
  const children: FakeChild[] = []; const spawned: { command: string; args: readonly string[]; windowsHide: unknown; stdio: unknown }[] = []; const exits: (() => void)[] = [];
  let fail: Error | null = null;
  const host: KeepAwakeHost = {
    platform, pid: 4321, find: (command) => found[command] ?? null, onExit: (listener) => { exits.push(listener); },
    spawn: (command, args, options) => {
      if (fail !== null) throw fail;
      spawned.push({ command, args, windowsHide: options.windowsHide, stdio: options.stdio });
      const child = new FakeChild(Array.isArray(options.stdio) && options.stdio[0] === "pipe"); children.push(child); return child as unknown as ChildProcess;
    },
  };
  return { host, children, spawned, exit: () => { for (const listener of exits) listener(); }, failWith: (error: Error) => { fail = error; } };
}

describe("keeping the computer awake while a run is live", () => {
  it("uses each platform's own holder, tied to arbitra's process", () => {
    // Observed live (October 26, 2026, macOS, pmset sleep 1): the Mac went to idle sleep an hour into a run.
    expect(keepAwakeCommand("darwin", 4321, () => "/usr/bin/caffeinate")).toEqual({ command: "/usr/bin/caffeinate", args: ["-i", "-w", "4321"], tool: "caffeinate -i", stdin: false });
    expect(keepAwakeCommand("linux", 4321, () => "/usr/bin/systemd-inhibit")).toEqual({ command: "/usr/bin/systemd-inhibit",
      args: ["--what=idle:sleep", "--who=arbitra", "--why=an arbitra run is live", "--mode=block", "sh", "-c", "read -r _ || true"], tool: "systemd-inhibit", stdin: true });
    const windows = keepAwakeCommand("win32", 4321, () => null);
    expect(windows).toMatchObject({ command: "powershell.exe", tool: "SetThreadExecutionState", stdin: false });
    const script = "args" in windows ? windows.args.at(-1) ?? "" : "";
    expect(script).toContain("SetThreadExecutionState([uint32]2147483649)");
    expect(script).toContain("Wait-Process -Id 4321");
    expect(keepAwakeCommand("linux", 4321, () => null)).toEqual({ unavailable: expect.stringContaining("systemd-inhibit was not found") as unknown });
  });

  it("holds one hidden holder for every live run, releases it with the last, and when arbitra exits", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const fake = fakeHost(platform); const awake = new ProcessKeepAwake(fake.host);
      expect(awake.status().state).toBe("ready");
      const first = awake.hold(); const second = awake.hold();
      expect(fake.spawned).toHaveLength(1);
      expect(fake.spawned[0]).toMatchObject({ windowsHide: true });
      expect(awake.status()).toMatchObject({ state: "held" });
      first(); first();
      expect(fake.children[0]?.killed).toBe(0);
      second();
      expect(fake.children[0]?.killed).toBe(1);
      expect(fake.children[0]?.stdinEnded).toBe(platform === "linux" ? 1 : 0);
      expect(awake.status().state).toBe("ready");
      const again = awake.hold(); expect(fake.spawned).toHaveLength(2);
      fake.exit(); expect(fake.children[1]?.killed).toBe(1);
      again();
    }
  });

  it("never fails a run when the computer cannot be kept awake, and says so", () => {
    const missing = new ProcessKeepAwake(fakeHost("linux", {}).host);
    expect(() => missing.hold()()).not.toThrow();
    expect(missing.status()).toMatchObject({ state: "unavailable", tool: null, detail: expect.stringContaining("systemd-inhibit was not found") as unknown });
    const refused = fakeHost("darwin"); refused.failWith(new Error("spawn EACCES"));
    const failed = new ProcessKeepAwake(refused.host);
    const release = failed.hold();
    expect(failed.status()).toMatchObject({ state: "failed", detail: expect.stringContaining("spawn EACCES") as unknown });
    release();
    // A holder that stops while a run is live is named, with what it said.
    const stopping = fakeHost("linux"); const stopped = new ProcessKeepAwake(stopping.host);
    stopped.hold();
    stopping.children[0]?.stderr.emit("data", "Failed to inhibit: Access denied\n");
    stopping.children[0]?.emit("exit", 1, null);
    expect(stopped.status()).toMatchObject({ state: "failed", detail: "could not keep this computer awake: systemd-inhibit stopped (status 1): Failed to inhibit: Access denied" });
  });
});

/** A host that records holds and lets the test say when the computer slept. */
function runHost() {
  const holds = { taken: 0, released: 0 }; const listeners = new Set<(suspend: HostSuspend) => void>();
  const keepAwake: KeepAwake = { hold: () => { holds.taken += 1; return () => { holds.released += 1; }; }, status: () => ({ state: "held", tool: "caffeinate -i", detail: "kept awake while a run works (caffeinate -i)" }) };
  const suspends = { now: () => Date.now(), suspendsSince: () => [], awake: () => Promise.resolve(),
    onSuspend: (listener: (suspend: HostSuspend) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const host: RunHost = { keepAwake, suspends };
  return { host, holds, sleep: (suspend: HostSuspend) => { for (const listener of [...listeners]) listener(suspend); }, listening: () => listeners.size };
}
const scripted = Object.freeze({ schemaVersion: 1, mode: "audit", scope: { kind: "repository" }, auditDepth: "balanced", consensusPolicy: "risk_weighted", maxConsensusRounds: 2,
  verification: {}, models: {}, harness: { mode: "canonical" }, workflow: { preset: "audit-two-finders" }, budgets: {}, security: {}, protocols: {}, promptOverrides: {}, contextPolicies: {} });

describe("a run on a host", () => {
  it("keeps the computer awake from its start until it settles, and records each sleep it lives through in its events and report", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arbitra-run-host-")); directories.push(directory);
    await writeFile(join(directory, "a.ts"), "export const value = 1;\n", "utf8");
    const fake = runHost();
    const orchestrator = new Orchestrator({ repository: directory, stateDirectory: join(directory, ".runs"), host: fake.host });
    const started = await orchestrator.start(orchestrator.configurations.validate(scripted as never));
    expect(fake.holds).toEqual({ taken: 1, released: 0 });
    // Two suspends a 40-second dark wake apart are one sleep; one an hour later is another.
    const at = (time: string) => Date.parse(`2026-10-26T${time}Z`);
    fake.sleep({ from: at("10:37:05"), to: at("10:52:10") }); fake.sleep({ from: at("10:52:50"), to: at("11:56:00") }); fake.sleep({ from: at("13:00:00"), to: at("13:30:00") });
    await orchestrator.wait(started.runId);
    await vi.waitFor(() => { expect(fake.holds.released).toBe(1); });
    expect(fake.listening()).toBe(0);
    await vi.waitFor(async () => { expect(await orchestrator.slept(started.runId)).toEqual([{ from: "2026-10-26T10:37:05.000Z", to: "2026-10-26T11:56:00.000Z" }, { from: "2026-10-26T13:00:00.000Z", to: "2026-10-26T13:30:00.000Z" }]); });
    expect((await orchestrator.status(started.runId)).state).toBe("COMPLETED");
    expect((await orchestrator.progress(started.runId)).state).toBe("COMPLETED");
    const report = await runReport(orchestrator, started.runId, null, "test-build");
    expect(report).toContain("  keep awake: held · kept awake while a run works (caffeinate -i)");
    expect(report).toContain("  the computer slept from 2026-10-26T10:37:05.000Z to 2026-10-26T11:56:00.000Z (79 min); calls in flight were sent again");
  });

  it("does not count a call a sleep cut among the calls that ran past their time limit, and times a run that slept", () => {
    const trace = (suspended: boolean) => digestArtifact(`model-activity-${"a".repeat(64)}-trace`, { activityId: "auditor-a/discovery/scope-1", attempts: [
      { attempt: 1, outcome: "retry", errorCode: "TIMEOUT", ...(suspended ? { suspended: { from: "2026-10-26T10:37:05.000Z", to: "2026-10-26T11:52:10.000Z" } } : {}) }, { attempt: 1, outcome: "completed", errorCode: null }] }, null);
    expect(trace(true)).toMatchObject({ kind: "trace", timedOutAndRetried: false });
    expect(trace(false)).toMatchObject({ kind: "trace", timedOutAndRetried: true });
    const run = timeline([{ t: "run_transition", runId: "r", state: "CREATED", at: "2026-10-26T10:00:00.000Z" }, { t: "node_dispatched", runId: "r", nodeId: "auditor-a", activityId: "x", at: "2026-10-26T10:00:01.000Z" },
      { t: "host_suspended", runId: "r", from: "2026-10-26T10:37:05.000Z", to: "2026-10-26T11:52:10.000Z", at: "2026-10-26T11:52:10.000Z" },
      { t: "node_completed", runId: "r", nodeId: "auditor-a", activityId: "x", replayed: false, at: "2026-10-26T12:00:01.000Z" }], ["auditor-a"], "DISCOVERY_COMPLETE", true);
    expect(run.stages).toEqual([expect.objectContaining({ nodeId: "auditor-a", status: "done", elapsedMs: 7_200_000 })]);
  });

  it("holds nothing without a host, and gives its suspends to every model call", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arbitra-run-host-")); directories.push(directory);
    expect(new Orchestrator({ repository: directory, stateDirectory: join(directory, ".runs") }).keepAwake()).toBeNull();
    const fake = runHost();
    expect(withHostSuspends({ credential: () => "x" }, fake.host).suspends).toBe(fake.host.suspends);
    const own: SuspendWatch = { now: () => 0, suspendsSince: () => [], awake: () => Promise.resolve() };
    expect(withHostSuspends({ suspends: own }, fake.host).suspends).toBe(own);
    expect(withHostSuspends({}, undefined).suspends).toBeUndefined();
  });

  it("starts no model call until the computer has been awake a while", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbitra-run-host-")); directories.push(root);
    const example = runConfigSchema.parse(JSON.parse(await readFile(new URL("../../../examples/audit-balanced.json", import.meta.url), "utf8")));
    const model = example.models["auditor-a"];
    if (model === undefined) throw new Error("FIXTURE_MODEL_ABSENT");
    const config = runConfigSchema.parse({ ...example, models: { "auditor-a": model }, workflow: { modelExecution: {
      endpoints: [{ id: "primary", providerId: model.provider, transport: model.transport, endpoint: "https://fixture.example/v1", apiKeyEnvVar: "FIXTURE_KEY" }],
      modelEndpoints: { "auditor-a": "primary" }, maximumOutputTokens: 10, maximumTokens: 10_000, maximumRetries: 0, timeoutMs: 1_000, rateLimits: { [model.provider]: { rpm: 100, tpm: 100_000, maxConcurrent: 4 } },
    } } });
    const send = vi.fn<HttpClient["send"]>(async () => ({ status: 200, headers: {}, body: { id: "response-1", output_text: "{\"answer\":\"ok\"}", usage: { input_tokens: 2, output_tokens: 3 } } }));
    let settle: () => void = () => {};
    const awake = new Promise<void>((resolve) => { settle = resolve; });
    const suspends: SuspendWatch = { now: () => Date.now(), suspendsSince: () => [], awake: () => awake };
    const activities = new ModelActivities(new RunStore(root, "run-1"), config, { client: { send }, credential: () => "fixture-credential", suspends });
    const answered = activities.invoke({ activityId: "auditor-a/discovery", modelProfileId: "auditor-a", protocol: "discovery@1", messages: [{ role: "user", content: "Return a JSON answer." }],
      signal: new AbortController().signal, schema: { parse: (value: unknown) => value as { answer: string } } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(send).not.toHaveBeenCalled();
    settle();
    await expect(answered).resolves.toEqual({ answer: "ok" });
    expect(sleptSpans([])).toEqual([]);
  });
});
