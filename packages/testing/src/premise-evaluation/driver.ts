import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { Orchestrator } from "@arbitra/runtime/orchestrator.js";
import type { TransportFactoryOptions } from "@arbitra/providers/registry.js";
import type { RunConfig } from "@arbitra/schemas/config.js";

import type { PremiseGroundTruth } from "../metrics/premise.js";
import { collectRun, type RecordedRun } from "./collect.js";
import { loadGroundTruth, scheduledRunKey, type EvaluationProtocol, type FixtureSpec, type ScheduledRun } from "./protocol.js";

/**
 * The P06 evaluation driver. It runs the public Orchestrator in Audit mode over fresh
 * checkouts that contain only fixture source (never ground truth or rubric), records each
 * run in a resumable ledger, stops before a budget is exceeded, and saves what the run
 * published for scoring. A run that does not complete stays in the ledger and is resumed
 * with `Orchestrator.resume` by the next invocation (a fresh process), never restarted.
 */
export interface DriverOptions {
  /** Repository root that protocol paths are relative to. */
  readonly root: string;
  readonly protocol: EvaluationProtocol;
  /** Checkouts, run state and the ledger. Never inside a fixture source. */
  readonly stateRoot: string;
  /** Where each completed run's record is written (`runs/<key>.json`). */
  readonly evidenceDirectory: string;
  readonly providerOptions?: TransportFactoryOptions;
  /** Wall clock for latency; injected so tests are deterministic. */
  readonly clock?: () => number;
  readonly now?: () => string;
  readonly log?: (line: string) => void;
  /** Run at most this many scheduled runs (including resumes) in this invocation. */
  readonly maximumRunsThisInvocation?: number;
}

export interface LedgerEntry {
  readonly key: string;
  readonly fixtureId: string;
  readonly condition: ScheduledRun["condition"];
  readonly repetition: number;
  runId: string;
  status: "running" | "incomplete" | "completed" | "abandoned";
  state: string;
  segments: { startedAt: string; endedAt: string | null; wallClockMs: number | null; state: string | null; kind: "start" | "resume" }[];
  failures: string[];
}

export interface Ledger {
  schemaVersion: 1;
  protocolId: string;
  protocolVersion: string;
  runs: Record<string, LedgerEntry>;
  stoppedReason: string | null;
}

export interface BudgetUse { readonly requests: number; readonly knownTokens: number; readonly unknownUsageRequests: number; readonly wallClockMs: number }

export interface DriverResult { readonly ledger: Ledger; readonly budget: BudgetUse; readonly completed: readonly string[]; readonly stoppedReason: string | null }

export const LEDGER_FILE = "ledger.json";

export async function executeProtocol(options: DriverOptions): Promise<DriverResult> {
  const { protocol, root } = options;
  const clock = options.clock ?? Date.now; const now = options.now ?? ((): string => new Date().toISOString()); const log = options.log ?? ((): void => undefined);
  if (isInside(resolve(options.stateRoot), resolve(root, "packages")) || protocol.fixtures.some((fixture) => isInside(resolve(options.stateRoot), resolve(root, fixture.source)))) throw new Error("P06_STATE_ROOT_INSIDE_SOURCES");
  const heterogeneous = readConfiguration(root, protocol);
  const configurations = { heterogeneous, single: singleAuditorConfiguration(heterogeneous, protocol.singleAuditor.auditorId) } as const;
  const truths = new Map(protocol.fixtures.map((fixture) => [fixture.id, loadGroundTruth(root, fixture)]));
  const ledgerPath = join(options.stateRoot, LEDGER_FILE);
  const ledger = readLedger(ledgerPath, protocol);
  mkdirSync(join(options.evidenceDirectory, "runs"), { recursive: true });
  const completed: string[] = [];
  let invocations = 0;
  for (const scheduled of protocol.schedule) {
    const key = scheduledRunKey(scheduled);
    const existing = ledger.runs[key];
    if (existing?.status === "completed" || existing?.status === "abandoned") continue;
    if (options.maximumRunsThisInvocation !== undefined && invocations >= options.maximumRunsThisInvocation) { ledger.stoppedReason = "invocation_run_limit"; break; }
    const used = await budgetUse(options.stateRoot, ledger);
    const exhausted = budgetExhausted(protocol, used);
    if (exhausted !== null) { ledger.stoppedReason = exhausted; log(`budget exhausted before ${key}: ${exhausted}`); break; }
    const fixture = protocol.fixtures.find(({ id }) => id === scheduled.fixtureId);
    const truth = truths.get(scheduled.fixtureId);
    if (fixture === undefined || truth === undefined) throw new Error(`P06_FIXTURE_ABSENT:${scheduled.fixtureId}`);
    const config = configurations[scheduled.condition];
    const paths = runPaths(options.stateRoot, key);
    invocations += 1;
    const segment: LedgerEntry["segments"][number] = { startedAt: now(), endedAt: null, wallClockMs: null, state: null, kind: existing === undefined ? "start" : "resume" };
    const started = clock();
    let entry: LedgerEntry;
    let orchestrator: Orchestrator;
    try {
      if (existing === undefined) {
        prepareCheckout(root, fixture, truth, paths.checkout);
        orchestrator = new Orchestrator({ repository: paths.checkout, stateDirectory: paths.state, ...(options.providerOptions === undefined ? {} : { providerOptions: options.providerOptions }) });
        const resource = await orchestrator.start(config);
        entry = { key, fixtureId: scheduled.fixtureId, condition: scheduled.condition, repetition: scheduled.repetition, runId: resource.runId, status: "running", state: resource.state, segments: [segment], failures: [] };
      } else {
        assertNoLeak(paths.checkout, truth);
        orchestrator = new Orchestrator({ repository: paths.checkout, stateDirectory: paths.state, ...(options.providerOptions === undefined ? {} : { providerOptions: options.providerOptions }) });
        entry = existing; entry.segments.push(segment); entry.status = "running";
        await orchestrator.resume(entry.runId);
      }
    } catch (error) {
      ledger.stoppedReason = `start_failed:${key}:${message(error)}`;
      writeLedger(ledgerPath, ledger);
      throw error;
    }
    ledger.runs[key] = entry;
    writeLedger(ledgerPath, ledger);
    log(`${segment.kind} ${key} ${entry.runId}`);
    const final = await orchestrator.wait(entry.runId);
    segment.endedAt = now(); segment.wallClockMs = clock() - started; segment.state = final.state; entry.state = final.state;
    if (final.state === "COMPLETED") {
      const record = await collectRun(orchestrator, entry.runId, config.models, auditorIdsOf(config));
      writeJson(join(options.evidenceDirectory, "runs", `${fileKey(key)}.json`), { schemaVersion: 1, status: "completed", key, fixtureId: scheduled.fixtureId, condition: scheduled.condition, repetition: scheduled.repetition,
        protocolId: protocol.protocolId, protocolVersion: protocol.version, wallClockMs: entry.segments.reduce((sum, { wallClockMs }) => sum + (wallClockMs ?? 0), 0), segments: entry.segments, record });
      entry.status = "completed"; completed.push(key);
      log(`completed ${key}: ${record.usage.requests} requests`);
    } else {
      entry.status = "incomplete";
      entry.failures.push(...failureCodes(await orchestrator.modelTraces(entry.runId)).filter((code) => !entry.failures.includes(code)));
      ledger.stoppedReason = `run_incomplete:${key}:${final.state}`;
      writeLedger(ledgerPath, ledger);
      log(`incomplete ${key} (${final.state}); resume from a fresh process`);
      break;
    }
    writeLedger(ledgerPath, ledger);
  }
  if (protocol.schedule.every((run) => ["completed", "abandoned"].includes(ledger.runs[scheduledRunKey(run)]?.status ?? ""))) ledger.stoppedReason = null;
  writeLedger(ledgerPath, ledger);
  return Object.freeze({ ledger, budget: await budgetUse(options.stateRoot, ledger), completed: Object.freeze(completed), stoppedReason: ledger.stoppedReason });
}

/**
 * Retire a run that can no longer be resumed (for example MODEL_ACTIVITY_INPUT_CHANGED after a
 * runtime fix altered a durable repair prompt). It is never restarted or deleted: whatever it
 * published is saved as an `abandoned` record with the reason, so a pipeline failure stays
 * visible as an adverse result, and the schedule continues past it.
 */
export async function abandonRun(options: Pick<DriverOptions, "root" | "protocol" | "stateRoot" | "evidenceDirectory">, key: string, reason: string): Promise<LedgerEntry> {
  if (reason.trim() === "") throw new Error("P06_ABANDON_REASON_REQUIRED");
  const ledgerPath = join(options.stateRoot, LEDGER_FILE);
  const ledger = readLedger(ledgerPath, options.protocol);
  const entry = ledger.runs[key];
  if (entry === undefined || entry.status !== "incomplete") throw new Error(`P06_ABANDON_REQUIRES_INCOMPLETE_RUN:${key}:${entry?.status ?? "absent"}`);
  const heterogeneous = readConfiguration(options.root, options.protocol);
  const config = entry.condition === "single" ? singleAuditorConfiguration(heterogeneous, options.protocol.singleAuditor.auditorId) : heterogeneous;
  const paths = runPaths(options.stateRoot, key);
  const orchestrator = new Orchestrator({ repository: paths.checkout, stateDirectory: paths.state });
  let record: RecordedRun | null = null; let collectionError: string | null = null;
  try { record = await collectRun(orchestrator, entry.runId, config.models, auditorIdsOf(config)); } catch (error) { collectionError = message(error); }
  entry.status = "abandoned";
  entry.failures.push(`abandoned:${reason}`);
  writeJson(join(options.evidenceDirectory, "runs", `${fileKey(key)}.json`), { schemaVersion: 1, status: "abandoned", abandonReason: reason, collectionError, key, fixtureId: entry.fixtureId, condition: entry.condition, repetition: entry.repetition,
    protocolId: options.protocol.protocolId, protocolVersion: options.protocol.version, wallClockMs: entry.segments.reduce((sum, { wallClockMs }) => sum + (wallClockMs ?? 0), 0), segments: entry.segments, failures: entry.failures, record });
  writeLedger(ledgerPath, ledger);
  return entry;
}

/** Load the materialized heterogeneous configuration. It names environment variables only. */
export function readConfiguration(root: string, protocol: EvaluationProtocol): RunConfig {
  return JSON.parse(readFileSync(resolve(root, protocol.configuration), "utf8")) as RunConfig;
}

/**
 * The single-auditor baseline: the same auditor profile, endpoint, depth, verification and
 * execution limits as the heterogeneous configuration, on the shipped single-auditor preset.
 * Its planner and verifier are that auditor, so no second model is involved.
 */
export function singleAuditorConfiguration(config: RunConfig, auditorId: string): RunConfig {
  const profile = config.models[auditorId];
  const execution = config.workflow["modelExecution"] as { endpoints: readonly { id: string; providerId: string }[]; modelEndpoints: Record<string, string>; rateLimits: Record<string, unknown>; roles?: unknown } | undefined;
  if (profile === undefined || execution === undefined) throw new Error(`P06_SINGLE_AUDITOR_ABSENT:${auditorId}`);
  const endpointId = execution.modelEndpoints[auditorId];
  const endpoints = execution.endpoints.filter(({ id }) => id === endpointId);
  if (endpoints.length !== 1) throw new Error(`P06_SINGLE_AUDITOR_ENDPOINT_ABSENT:${auditorId}`);
  const providers = new Set(endpoints.map(({ providerId }) => providerId));
  return { ...config, models: { [auditorId]: profile }, workflow: { ...config.workflow, preset: "diff-fast", modelExecution: { ...execution, endpoints, modelEndpoints: { [auditorId]: endpointId },
    rateLimits: Object.fromEntries(Object.entries(execution.rateLimits).filter(([provider]) => providers.has(provider))), roles: { planner: auditorId, verifier: auditorId } } } } as RunConfig;
}

export function auditorIdsOf(config: RunConfig): readonly string[] {
  return Object.keys(config.models).filter((id) => /^auditor-[a-z]$/u.test(id)).sort();
}

/**
 * A fresh checkout holding only the fixture's source files, committed with a fixed identity
 * and date so every repetition audits the same commit. It fails if any answer text is present.
 */
export function prepareCheckout(root: string, fixture: FixtureSpec, truth: PremiseGroundTruth, checkout: string): void {
  if (existsSync(checkout)) throw new Error(`P06_CHECKOUT_EXISTS:${checkout}`);
  const source = resolve(root, fixture.source);
  const excluded = new Set(fixture.exclude.map((path) => resolve(source, path)));
  mkdirSync(checkout, { recursive: true });
  cpSync(source, checkout, { recursive: true, filter: (path) => !excluded.has(resolve(path)) && !path.split(sep).includes(".git") && !path.split(sep).includes(".runs") && !path.split(sep).includes("node_modules") });
  assertNoLeak(checkout, truth);
  const environment = { ...process.env, GIT_AUTHOR_NAME: "p06", GIT_AUTHOR_EMAIL: "p06@arbitra.invalid", GIT_COMMITTER_NAME: "p06", GIT_COMMITTER_EMAIL: "p06@arbitra.invalid", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
  execFileSync("git", ["-C", checkout, "init", "-q"], { env: environment });
  execFileSync("git", ["-C", checkout, "add", "-A"], { env: environment });
  execFileSync("git", ["-C", checkout, "-c", "commit.gpgsign=false", "commit", "-qm", `fixture ${fixture.id}`], { env: environment });
}

/** No ground-truth file, item id, detection criterion or rationale may be readable in a checkout. */
export function assertNoLeak(checkout: string, truth: PremiseGroundTruth): void {
  const needles = [...new Set(truth.items.flatMap(({ id, detectionCriteria, rationale }) => [id, detectionCriteria, rationale]))];
  for (const path of files(checkout)) {
    const name = relative(checkout, path);
    if (/ground[-_ ]?truth|rubric/iu.test(name)) throw new Error(`P06_GROUND_TRUTH_LEAK:${name}`);
    const text = readFileSync(path, "utf8");
    const leaked = needles.find((needle) => text.includes(needle));
    if (leaked !== undefined) throw new Error(`P06_GROUND_TRUTH_LEAK:${name}`);
  }
}

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    if (name === ".git") return [];
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

/** Budget use across every run the ledger started, from their durable traces. */
export async function budgetUse(stateRoot: string, ledger: Ledger): Promise<BudgetUse> {
  let requests = 0; let knownTokens = 0; let unknown = 0; let wall = 0;
  for (const entry of Object.values(ledger.runs)) {
    const paths = runPaths(stateRoot, entry.key);
    const traces = await new Orchestrator({ repository: paths.checkout, stateDirectory: paths.state }).modelTraces(entry.runId).catch(() => []);
    for (const trace of traces) {
      requests += 1;
      if (trace.tokenUsage?.inputTokens == null || trace.tokenUsage.outputTokens == null) unknown += 1;
      else knownTokens += trace.tokenUsage.inputTokens + trace.tokenUsage.outputTokens;
    }
    wall += entry.segments.reduce((sum, { wallClockMs }) => sum + (wallClockMs ?? 0), 0);
  }
  return Object.freeze({ requests, knownTokens, unknownUsageRequests: unknown, wallClockMs: wall });
}

export function budgetExhausted(protocol: EvaluationProtocol, used: BudgetUse): string | null {
  if (used.requests >= protocol.budget.maximumModelRequests) return `maximum_model_requests:${used.requests}/${protocol.budget.maximumModelRequests}`;
  if (used.knownTokens >= protocol.budget.maximumTokens) return `maximum_tokens:${used.knownTokens}/${protocol.budget.maximumTokens}`;
  if (used.wallClockMs >= protocol.budget.maximumWallClockMs) return `maximum_wall_clock_ms:${used.wallClockMs}/${protocol.budget.maximumWallClockMs}`;
  return null;
}

export function runPaths(stateRoot: string, key: string): { readonly checkout: string; readonly state: string } {
  const base = join(stateRoot, "runs", fileKey(key));
  return { checkout: join(base, "repo"), state: join(base, "state") };
}

export function fileKey(key: string): string { return key.replaceAll("/", "__"); }

function failureCodes(traces: readonly { readonly error: { readonly code: string } | null }[]): string[] {
  return [...new Set(traces.flatMap(({ error }) => error === null ? [] : [error.code]))].sort();
}

function readLedger(path: string, protocol: EvaluationProtocol): Ledger {
  if (!existsSync(path)) return { schemaVersion: 1, protocolId: protocol.protocolId, protocolVersion: protocol.version, runs: {}, stoppedReason: null };
  const ledger = JSON.parse(readFileSync(path, "utf8")) as Ledger;
  if (ledger.protocolId !== protocol.protocolId || ledger.protocolVersion !== protocol.version) throw new Error(`P06_LEDGER_PROTOCOL_MISMATCH:${ledger.protocolId}@${ledger.protocolVersion}`);
  return ledger;
}

function writeLedger(path: string, ledger: Ledger): void { writeJson(path, ledger); }

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

function isInside(path: string, parent: string): boolean { return path === parent || path.startsWith(`${parent}${sep}`); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export type { RecordedRun };
