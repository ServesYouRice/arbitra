import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runConfigSchema } from "@arbitra/schemas/config.js";
import { TransportError, type HttpClient, type HttpRequest, type ProviderTransport, type TransportResponse } from "@arbitra/providers/transport-contract.js";
import { ProviderBudgetSuspendedError, ProviderInvocationFailure, ProviderUsageLimitError } from "@arbitra/providers/runtime.js";
import type { TransportFactory } from "@arbitra/providers/registry.js";
import { redactSecrets } from "@arbitra/security/redaction";
import { FINDER_LEFT_OUT, MAXIMUM_LIMIT_WAITS, ModelActivities, UsageLimitAfterWaitError } from "../src/model-activities.js";
import type { WaitClock } from "../src/limit-waits.js";
import { MODEL_ROUTES_KIND, type ModelRouteState } from "../src/model-routes.js";
import { RunStore } from "../src/run-store.js";
import { loadActivityTraces } from "@arbitra/persistence/trace.js";
import { FakeWaitClock } from "./wait-clock.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

/** Usage worth $1.80 on Opus 5.5: 100K uncached input ($0.40), 200K cache writes ($1.00), 1M cache reads ($0.20), 10K output ($0.20). */
const PRICED_USAGE = { input_tokens: 100_000, cache_creation_input_tokens: 200_000, cache_read_input_tokens: 1_000_000, output_tokens: 10_000 };

/** A reply of the stand-in CLI: an answer, or its usage limit resetting in `quotaInMs` (null: no reset given), with `detail` in its words. */
type CliReply = { readonly text: string } | { readonly quotaInMs: number | null; readonly detail?: string };

/**
 * Opus 5.5 two ways: through an API key (`opus-api`, the Anthropic Messages API answered by `send`) and through Claude
 * Code on a subscription (`opus-cc`, a stand-in transport that answers in order from `cli`).
 */
async function fixture(execution: Record<string, unknown> = {}, root?: string) {
  const directory = root ?? await mkdtemp(join(tmpdir(), "arbitra-model-routes-"));
  if (root === undefined) directories.push(directory);
  const example = JSON.parse(await readFile(new URL("../../../examples/audit-balanced.json", import.meta.url), "utf8")) as Record<string, unknown>;
  const original = runConfigSchema.parse(example);
  const template = original.models["auditor-a"];
  if (template === undefined) throw new Error("FIXTURE_MODEL_ABSENT");
  const opus = { ...template, provider: "anthropic", modelId: "claude-opus-5-5", family: "claude", independenceGroup: "anthropic", effort: { supported: ["low", "medium", "high", "xhigh", "max"], collapse: {}, params: {} } };
  const config = runConfigSchema.parse({ ...original, models: { "opus-api": { ...opus, transport: "anthropic-messages" }, "opus-cc": { ...opus, transport: "claude-code-cli" } }, workflow: {
    modelExecution: {
      endpoints: [{ id: "anthropic-api", providerId: "anthropic", transport: "anthropic-messages", endpoint: "https://api.anthropic.example/v1", apiKeyEnvVar: "FIXTURE_KEY" },
        { id: "claude-code", providerId: "anthropic", transport: "claude-code-cli", endpoint: "cli://claude-code", auth: "subscription_login" }],
      modelEndpoints: { "opus-api": "anthropic-api", "opus-cc": "claude-code" }, maximumOutputTokens: 10, maximumTokens: 10_000_000,
      maximumRetries: 0, timeoutMs: 5_000, rateLimits: { anthropic: { rpm: 1000, tpm: 100_000_000, maxConcurrent: 8 } }, ...execution,
    },
  } });
  const store = new RunStore(directory, "run-1");
  let apiOut = false;
  const send = vi.fn<HttpClient["send"]>(async (request: HttpRequest) => {
    if (apiOut) return { status: 400, headers: {}, body: { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } } };
    const user = (request.body as { messages: { content: string }[] }).messages[0]?.content ?? "";
    return { status: 200, headers: {}, body: { id: "msg-1", content: [{ type: "text", text: JSON.stringify({ answer: `api:${user}` }) }], usage: PRICED_USAGE } };
  });
  const cli: CliReply[] = [];
  const cliCalls: string[] = [];
  const subscription: TransportFactory = () => ({ id: "claude-code-cli", async send(request): Promise<TransportResponse> {
    const user = request.messages.find(({ role }) => role === "user")?.content ?? "";
    cliCalls.push(user);
    const reply = cli.length > 1 ? cli.shift() : cli[0];
    if (reply !== undefined && "quotaInMs" in reply) {
      throw new TransportError("QUOTA", `CLI_USAGE_LIMIT_REACHED: the Claude Code subscription's usage allowance is exhausted${reply.quotaInMs === null ? "" : ` until ${new Date(Date.now() + reply.quotaInMs).toISOString()}`}${reply.detail === undefined ? "" : `: ${reply.detail}`}`, false, reply.quotaInMs);
    }
    return { text: JSON.stringify({ answer: `cc:${user}` }), structured: null, toolCalls: [], refusal: null, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      continuation: null, structuredOutputTier: "prompt_json", providerRequestId: null };
  } } satisfies ProviderTransport);
  const options = { client: { send }, credential: () => "fixture-credential", factories: { "claude-code-cli": subscription } };
  // A clock for the calls that wait in place for a usage limit; the computer's when none is given.
  const create = (waitClock?: WaitClock) => new ModelActivities(store, config, waitClock === undefined ? options : { ...options, waitClock });
  const routes = async (): Promise<ModelRouteState | null> => {
    const artifact = (await store.listArtifacts()).find(({ kind }) => kind === MODEL_ROUTES_KIND);
    return artifact === undefined ? null : JSON.parse((await store.readArtifact(artifact.artifactId)).content) as ModelRouteState;
  };
  const recorded = async (activityId: string, suffix = "") => {
    const kind = `model-activity-${createHash("sha256").update(JSON.stringify(activityId)).digest("hex")}${suffix}`;
    const artifact = (await store.listArtifacts()).find((item) => item.kind === kind);
    return artifact === undefined ? null : JSON.parse((await store.readArtifact(artifact.artifactId)).content) as Record<string, unknown>;
  };
  const answer = async (activityId: string) => await recorded(activityId) as { replayIdentity: string; answeredBy?: string; value: unknown } | null;
  const switches = async () => (await store.loadEvents()).filter((event) => event.t === "model_route_switched");
  const waits = async () => (await store.loadEvents()).filter((event) => event.t === "model_waiting" || event.t === "model_wait_ended");
  return { directory, store, send, cli, cliCalls, create, routes, answer, recorded, switches, waits, setApiOut: (value: boolean) => { apiOut = value; } };
}

function request(activityId: string, modelProfileId = "opus-api") {
  return { activityId, modelProfileId, protocol: "targeted-verification@1", effort: "xhigh" as const, messages: [{ role: "user" as const, content: activityId }], signal: new AbortController().signal,
    schema: { parse(value: unknown) {
      if (typeof value !== "object" || value === null || !("answer" in value) || typeof value.answer !== "string") throw new Error("INVALID_ANSWER");
      return { answer: value.answer };
    } } };
}

describe("fallbacks between an API profile and a subscription profile of one model", () => {
  it("sends the rest of a stage already running to the subscription when the API credit runs out, calls in flight included", async () => {
    const f = await fixture({ fallbacks: { "opus-api": "opus-cc", "opus-cc": "opus-api" } });
    const activities = f.create();
    expect(await activities.invoke(request("verification/1"))).toEqual({ answer: "api:verification/1" });
    f.setApiOut(true);
    // Two calls in flight when the credit runs out: both are answered through Claude Code, and the switch is made once.
    expect(await Promise.all([activities.invoke(request("verification/2")), activities.invoke(request("verification/3"))])).toEqual([{ answer: "cc:verification/2" }, { answer: "cc:verification/3" }]);
    const asked = f.send.mock.calls.length;
    expect(await activities.invoke(request("verification/4"))).toEqual({ answer: "cc:verification/4" });
    expect(f.send).toHaveBeenCalledTimes(asked);
    const events = await f.switches();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ t: "model_route_switched", from: "opus-api", to: "opus-cc", reason: "credit_out", spentUsd: 1.8, effort: "xhigh" });
    expect(typeof events[0]?.at).toBe("string");
    expect(await f.routes()).toMatchObject({ spentUsd: { "opus-api": 1.8 }, out: { "opus-api": { reason: "credit_out", until: null } }, switches: [{ from: "opus-api", to: "opus-cc", reason: "credit_out" }] });
    expect((await f.answer("verification/2"))?.answeredBy).toBe("opus-cc");
    expect((await f.answer("verification/1"))?.answeredBy).toBeUndefined();
    // The run's trace says which model and transport answered, and what the API call cost.
    const traces = await loadActivityTraces(f.directory, "run-1");
    expect(traces.find(({ activityId }) => activityId === "verification/1")).toMatchObject({ transportId: "anthropic-messages", modelId: "claude-opus-5-5", costUsd: 1.8 });
    expect(traces.find(({ activityId }) => activityId === "verification/4")).toMatchObject({ transportId: "claude-code-cli", modelId: "claude-opus-5-5", costUsd: null });
  });

  it("goes on through the API key when the subscription's limit resets later than the run waits, and back once it has reset", async () => {
    // The clock moves only when the test moves it, so a slow machine cannot let the window reset between the first two
    // calls (it did once under a full parallel suite).
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    try {
      const f = await fixture({ fallbacks: { "opus-api": "opus-cc", "opus-cc": "opus-api" }, fallbackWaitMs: 100 });
      f.cli.push({ quotaInMs: 300 }, { text: "unused" });
      const activities = f.create();
      expect(await activities.invoke(request("critic/1", "opus-cc"))).toEqual({ answer: "api:critic/1" });
      const [switched] = await f.switches();
      expect(switched).toMatchObject({ from: "opus-cc", to: "opus-api", reason: "usage_limit", spentUsd: null });
      expect(Date.parse(switched?.resetsAt ?? "")).toBeGreaterThan(Date.now());
      expect(await activities.invoke(request("critic/2", "opus-cc"))).toEqual({ answer: "api:critic/2" });
      // Once the window has reset, the subscription answers again, and the run says so.
      vi.setSystemTime(Date.now() + 400);
      expect(await activities.invoke(request("critic/3", "opus-cc"))).toEqual({ answer: "cc:critic/3" });
      expect((await f.switches()).map(({ from, to, reason }) => `${from}>${to}:${reason}`)).toEqual(["opus-cc>opus-api:usage_limit", "opus-api>opus-cc:reset"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits in place for a subscription's limit that resets soon rather than pay for the API", async () => {
    const f = await fixture({ fallbacks: { "opus-cc": "opus-api" } });
    f.cli.push({ quotaInMs: 10 * 60_000 }, { text: "unused" });
    const clock = new FakeWaitClock();
    const answered = f.create(clock).invoke(request("critic/1", "opus-cc"));
    // Until a minute after the reset, and then the subscription answers.
    await vi.waitFor(() => { expect(clock.pending).toEqual([11 * 60_000]); });
    clock.advance(11 * 60_000);
    expect(await answered).toEqual({ answer: "cc:critic/1" });
    expect(f.send).not.toHaveBeenCalled();
    expect(await f.switches()).toEqual([]);
    // A limit with no reset time given, like a weekly one hours away, switches.
    f.cli.splice(0, f.cli.length, { quotaInMs: null });
    expect(await f.create().invoke(request("critic/2", "opus-cc"))).toEqual({ answer: "api:critic/2" });
    expect(await f.switches()).toMatchObject([{ from: "opus-cc", to: "opus-api", reason: "usage_limit" }]);
  });

  it("tells an optional step to wait only for a subscription's limit that resets within the wait, its own or its fallback's", async () => {
    // An optional step goes on without its model unless the run would wait for that model anyway (optional-steps.ts).
    // A call waits for such a limit in place, so a step meets one only from a call that could not wait for it.
    const f = await fixture({ fallbacks: { "opus-api": "opus-cc" }, fallbackWaitMs: 60_000 });
    const clock = new FakeWaitClock();
    const activities = f.create(clock);
    let asked = 0;
    const refused = async (profile: string): Promise<ProviderUsageLimitError> => {
      asked += 1;
      const error: unknown = await activities.invoke(request(`second-opinion/${asked}`, profile)).then(() => null, (failure: unknown) => failure);
      if (!(error instanceof ProviderUsageLimitError)) throw new Error("FIXTURE_NOT_REFUSED");
      return error;
    };
    const limit = (retryAfterMs: number | null) => new ProviderUsageLimitError("Provider anthropic reached its usage limit (QUOTA: CLI_USAGE_LIMIT_REACHED)", 1, retryAfterMs);
    expect(activities.waitsFor("opus-cc", limit(30_000))).toBe(true);
    // Out for longer than the run waits, or with no reset given: the step goes on without it, and no call waited.
    f.cli.splice(0, f.cli.length, { quotaInMs: 120_000 });
    expect(activities.waitsFor("opus-cc", await refused("opus-cc"))).toBe(false);
    f.cli.splice(0, f.cli.length, { quotaInMs: null });
    expect(activities.waitsFor("opus-cc", await refused("opus-cc"))).toBe(false);
    expect(clock.pending).toEqual([]);
    // The API key's credit is out and its fallback, the subscription, resets within the wait: the run waits for that.
    expect(activities.waitsFor("opus-api", limit(30_000))).toBe(true);
    // Met again after the call had waited as long as the run waits: not waited for again.
    expect(activities.waitsFor("opus-cc", new UsageLimitAfterWaitError(limit(30_000), 60_000))).toBe(false);
    // An API key with no fallback gives no reset, and is never waited for.
    const alone = await fixture();
    alone.setApiOut(true);
    const credit: unknown = await alone.create().invoke(request("second-opinion/api")).then(() => null, (failure: unknown) => failure);
    expect(credit).toBeInstanceOf(ProviderUsageLimitError);
    expect(alone.create().waitsFor("opus-api", credit as ProviderUsageLimitError)).toBe(false);
  });

  it("switches off the API at its dollar cap, counting cache writes and reads at their own prices", async () => {
    const f = await fixture({ fallbacks: { "opus-api": "opus-cc" }, maximumCostUsd: { "opus-api": 1.5 } });
    const activities = f.create();
    expect(await activities.invoke(request("planner/1"))).toEqual({ answer: "api:planner/1" });
    // $1.80 by the price of each kind of token; the same tokens at the plain input price would be $5.40.
    expect(await f.switches()).toMatchObject([{ from: "opus-api", to: "opus-cc", reason: "cost_cap", spentUsd: 1.8 }]);
    expect(await activities.invoke(request("planner/2"))).toEqual({ answer: "cc:planner/2" });
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("pauses the run with a clear reason at the cap when there is no fallback, and goes on when a resume raises it", async () => {
    const f = await fixture({ maximumCostUsd: { "opus-api": 1.5 } });
    expect(await f.create().invoke(request("planner/1"))).toEqual({ answer: "api:planner/1" });
    expect(await f.switches()).toMatchObject([{ from: "opus-api", to: null, reason: "cost_cap", spentUsd: 1.8 }]);
    const paused = f.create().invoke(request("planner/2"));
    await expect(paused).rejects.toBeInstanceOf(ProviderBudgetSuspendedError);
    await expect(paused).rejects.toThrow(/^MODEL_COST_CAP_REACHED:opus-api: opus-api has spent \$1\.80 of its \$1\.50 cap and has no fallback\. The run pauses with its work kept; resume it with a higher cap/u);
    expect(f.send).toHaveBeenCalledTimes(1);
    // A resume with a higher cap: the same store, the cap raised. The answer already made is kept.
    const raised = await fixture({ maximumCostUsd: { "opus-api": 10 } }, f.directory);
    expect(await raised.create().invoke(request("planner/1"))).toEqual({ answer: "api:planner/1" });
    expect(raised.send).not.toHaveBeenCalled();
    expect(await raised.create().invoke(request("planner/2"))).toEqual({ answer: "api:planner/2" });
    expect((await raised.switches()).map(({ reason, to }) => `${reason}>${to}`)).toEqual(["cost_cap>null", "reset>opus-api"]);
  });

  it("goes on through the fallback after a resume, with every answer recorded before and after the switch kept", async () => {
    const f = await fixture({ fallbacks: { "opus-api": "opus-cc", "opus-cc": "opus-api" } });
    expect(await f.create().invoke(request("verification/1"))).toEqual({ answer: "api:verification/1" });
    f.setApiOut(true);
    expect(await f.create().invoke(request("verification/2"))).toEqual({ answer: "cc:verification/2" });
    const sent = f.send.mock.calls.length; const asked = f.cliCalls.length;
    // A resume builds its activities afresh: the switch is read from the run, and the API is not asked again.
    const resumed = f.create();
    expect(await resumed.invoke(request("verification/1"))).toEqual({ answer: "api:verification/1" });
    expect(await resumed.invoke(request("verification/2"))).toEqual({ answer: "cc:verification/2" });
    expect(f.send).toHaveBeenCalledTimes(sent); expect(f.cliCalls).toHaveLength(asked);
    expect(await resumed.invoke(request("verification/3"))).toEqual({ answer: "cc:verification/3" });
    expect(f.send).toHaveBeenCalledTimes(sent);
    expect(await f.switches()).toHaveLength(1);
  });

  it("keeps each call's replay identity whichever route answered it", async () => {
    const switched = await fixture({ fallbacks: { "opus-api": "opus-cc" } });
    switched.setApiOut(true);
    expect(await switched.create().invoke(request("verification/1"))).toEqual({ answer: "cc:verification/1" });
    const direct = await fixture();
    expect(await direct.create().invoke(request("verification/1"))).toEqual({ answer: "api:verification/1" });
    const [through, plain] = [await switched.answer("verification/1"), await direct.answer("verification/1")];
    expect(through?.answeredBy).toBe("opus-cc");
    expect(through?.replayIdentity).toBe(plain?.replayIdentity);
  });

  it("refuses a dollar cap on a model it has no price for, and on a subscription", async () => {
    await expect(fixture({ maximumCostUsd: { "opus-cc": 5 } })).rejects.toThrow("only a model on an API endpoint takes a cost cap");
    const f = await fixture();
    const example = runConfigSchema.parse(JSON.parse(await readFile(new URL("../../../examples/audit-balanced.json", import.meta.url), "utf8")));
    const unpriced = runConfigSchema.parse({ ...example, models: { "opus-api": { ...example.models["auditor-a"], provider: "anthropic", transport: "anthropic-messages", modelId: "claude-unreleased" } }, workflow: { modelExecution: {
      endpoints: [{ id: "anthropic-api", providerId: "anthropic", transport: "anthropic-messages", endpoint: "https://api.anthropic.example/v1", apiKeyEnvVar: "FIXTURE_KEY" }],
      modelEndpoints: { "opus-api": "anthropic-api" }, maximumCostUsd: { "opus-api": 5 }, maximumOutputTokens: 10, maximumTokens: 1_000, maximumRetries: 0, timeoutMs: 1_000, rateLimits: { anthropic: { rpm: 1, tpm: 1_000, maxConcurrent: 1 } } } } });
    expect(() => new ModelActivities(f.store, unpriced, {})).toThrow(/^MODEL_COST_CAP_UNPRICED:opus-api/u);
  });
});

const MINUTE = 60_000;
const START = Date.parse("2026-11-21T11:20:00.000Z");
const iso = (time: number): string => new Date(time).toISOString();

// Observed live (a real-project audit, November 21, 2026): Sol met Codex's five-hour limit at 12:20 with its reset at 12:27.
// The limit failed Sol's discovery, and Sol sat idle for two hours, until Opus's discovery ended and the run could pause
// and be resumed. A call met by a subscription's limit that resets within `fallbackWaitMs` now waits for it in place.
describe("a call that waits in place for its subscription's usage limit to reset", () => {
  it("waits until a minute after the reset, then sends the same call again and answers, and the run says so", async () => {
    const f = await fixture();
    f.cli.push({ quotaInMs: 7 * MINUTE, detail: "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstu" }, { text: "unused" });
    const clock = new FakeWaitClock();
    const answered = f.create(clock).invoke(request("auditor-b/discovery/1", "opus-cc"));
    await vi.waitFor(() => { expect(clock.pending).toEqual([8 * MINUTE]); });
    // Recorded once for the profile while it waits, in words with no secret in them; nothing was switched.
    const [waiting] = await f.waits();
    expect(waiting).toMatchObject({ t: "model_waiting", runId: "run-1", profile: "opus-cc", resetsAt: iso(START + 7 * MINUTE), until: iso(START + 8 * MINUTE) });
    expect(waiting?.t === "model_waiting" ? waiting.detail : "").toMatch(/^Provider anthropic reached its usage limit \(QUOTA: CLI_USAGE_LIMIT_REACHED: .*\[REDACTED:api_token\]/u);
    expect(redactSecrets(JSON.stringify(await f.waits())).redactions).toEqual([]);
    clock.advance(8 * MINUTE);
    expect(await answered).toEqual({ answer: "cc:auditor-b/discovery/1" });
    expect((await f.waits()).map((event) => event.t === "model_wait_ended" ? `${event.t}:${event.outcome}` : event.t)).toEqual(["model_waiting", "model_wait_ended:went_on"]);
    // The same call: one activity and one request, sent twice, traced once, its wait not counted as its own time.
    expect(f.cliCalls).toEqual(["auditor-b/discovery/1", "auditor-b/discovery/1"]);
    expect((await loadActivityTraces(f.directory, "run-1")).filter(({ activityId }) => activityId === "auditor-b/discovery/1")).toMatchObject([{ attempt: 1, outcome: "success" }]);
    expect(await f.recorded("auditor-b/discovery/1", "-trace")).toMatchObject({ waitedForLimit: { waits: 1, ms: 8 * MINUTE }, attempts: [{ outcome: "failed", errorCode: "QUOTA" }, { outcome: "completed" }] });
    expect(await f.switches()).toEqual([]);
    // Its answer is identified as one made without a wait, so a resume and a replay find it.
    const plain = await fixture();
    plain.cli.push({ text: "unused" });
    await plain.create().invoke(request("auditor-b/discovery/1", "opus-cc"));
    expect((await f.answer("auditor-b/discovery/1"))?.replayIdentity).toBe((await plain.answer("auditor-b/discovery/1"))?.replayIdentity);
  });

  it("lets the run's other calls go on during the wait, and holds a later call of the waiting profile with it, unsent", async () => {
    const f = await fixture();
    f.cli.push({ quotaInMs: 7 * MINUTE }, { text: "unused" });
    const clock = new FakeWaitClock();
    const activities = f.create(clock);
    const first = activities.invoke(request("auditor-b/discovery/1", "opus-cc"));
    await vi.waitFor(() => { expect(clock.pending).toHaveLength(1); });
    // Another finder's calls are sent and answered while Sol's waits.
    expect(await Promise.all([activities.invoke(request("auditor-a/discovery/1")), activities.invoke(request("auditor-a/discovery/2"))]))
      .toEqual([{ answer: "api:auditor-a/discovery/1" }, { answer: "api:auditor-a/discovery/2" }]);
    // A call of the waiting profile made meanwhile is not sent to be refused again: it waits for the same reset.
    const second = activities.invoke(request("auditor-b/discovery/2", "opus-cc"));
    await vi.waitFor(() => { expect(clock.pending).toEqual([8 * MINUTE, 8 * MINUTE]); });
    expect(f.cliCalls).toEqual(["auditor-b/discovery/1"]);
    clock.advance(8 * MINUTE);
    expect(await Promise.all([first, second])).toEqual([{ answer: "cc:auditor-b/discovery/1" }, { answer: "cc:auditor-b/discovery/2" }]);
    expect([...f.cliCalls].sort()).toEqual(["auditor-b/discovery/1", "auditor-b/discovery/1", "auditor-b/discovery/2"]);
    // One wait of the profile, from its first call to its last.
    expect((await f.waits()).map(({ t }) => t)).toEqual(["model_waiting", "model_wait_ended"]);
  });

  it("stops waiting at once when the run is cancelled, or when the finder is left out, without sending the call again", async () => {
    const f = await fixture();
    f.cli.push({ quotaInMs: 7 * MINUTE });
    const clock = new FakeWaitClock();
    const activities = f.create(clock);
    const cancel = new AbortController();
    const cancelled = activities.invoke({ ...request("auditor-b/discovery/1", "opus-cc"), signal: cancel.signal });
    await vi.waitFor(() => { expect(clock.pending).toHaveLength(1); });
    cancel.abort();
    // The clock has not moved: the wait ended because the run was cancelled, not because the reset came.
    await expect(cancelled).rejects.toMatchObject({ causeCode: "CANCELLED" });
    expect(clock.pending).toEqual([]);
    expect(f.cliCalls).toHaveLength(1);
    expect((await loadActivityTraces(f.directory, "run-1")).find(({ activityId }) => activityId === "auditor-b/discovery/1")?.outcome).toBe("cancelled");
    // A finder left out while its call waits: its answer is no longer needed, and the call fails as left out.
    const left = activities.invoke(request("auditor-b/discovery/2", "opus-cc"));
    await vi.waitFor(() => { expect(clock.pending).toHaveLength(1); });
    activities.leaveOut("opus-cc");
    const error: unknown = await left.then(() => null, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(ProviderInvocationFailure);
    expect(error).toMatchObject({ transportCode: FINDER_LEFT_OUT });
    expect(clock.pending).toEqual([]);
    expect(f.cliCalls).toHaveLength(2);
    expect((await f.waits()).map((event) => event.t === "model_wait_ended" ? event.outcome : event.t)).toEqual(["model_waiting", "cancelled", "model_waiting", "left_out"]);
  });

  it("does not wait for a limit that resets later than the run waits: it fails as before, and the run pauses", async () => {
    const f = await fixture();
    f.cli.push({ quotaInMs: 31 * MINUTE });
    const clock = new FakeWaitClock();
    const activities = f.create(clock);
    const error: unknown = await activities.invoke(request("verification/1", "opus-cc")).then(() => null, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(ProviderUsageLimitError);
    expect(error).not.toBeInstanceOf(UsageLimitAfterWaitError);
    expect(error).toMatchObject({ state: "SUSPENDED_RATE_LIMIT", retryAfterMs: 31 * MINUTE });
    expect(activities.waitsFor("opus-cc", error as ProviderUsageLimitError)).toBe(false);
    expect(clock.pending).toEqual([]);
    expect(await f.waits()).toEqual([]);
  });

  it("fails as before when the limit comes back after the reset past what the run waits, or with a fallback switches to it", async () => {
    const f = await fixture();
    // The reset moved: seven minutes, then twenty-five more, past the 30 minutes the run waits.
    f.cli.push({ quotaInMs: 7 * MINUTE }, { quotaInMs: 25 * MINUTE }, { text: "unused" });
    const clock = new FakeWaitClock();
    const activities = f.create(clock);
    const failed = activities.invoke(request("verification/1", "opus-cc")).then(() => null, (failure: unknown) => failure);
    await vi.waitFor(() => { expect(clock.pending).toHaveLength(1); });
    clock.advance(8 * MINUTE);
    const error = await failed;
    expect(error).toBeInstanceOf(UsageLimitAfterWaitError);
    // Still a usage limit, as the run pauses on it and the run helper reads it, saying how long the call had waited.
    expect(error).toMatchObject({ name: "ProviderUsageLimitError", state: "SUSPENDED_RATE_LIMIT", retryAfterMs: 25 * MINUTE, waitedMs: 8 * MINUTE });
    expect((error as Error).message).toMatch(/exhausted until \S+.*The call had already waited 8 minutes in place for its limit to reset\.$/u);
    // An optional step goes on without its model rather than hold the run again.
    expect(activities.waitsFor("opus-cc", error as ProviderUsageLimitError)).toBe(false);
    expect(clock.pending).toEqual([]);
    expect(f.cliCalls).toHaveLength(2);
    // With a fallback, the call that may not wait again goes to it, and the subscription is out until its reset.
    const fallback = await fixture({ fallbacks: { "opus-cc": "opus-api" } });
    fallback.cli.push({ quotaInMs: 7 * MINUTE }, { quotaInMs: 25 * MINUTE }, { text: "unused" });
    const routed = new FakeWaitClock();
    const answered = fallback.create(routed).invoke(request("verification/1", "opus-cc"));
    await vi.waitFor(() => { expect(routed.pending).toHaveLength(1); });
    routed.advance(8 * MINUTE);
    expect(await answered).toEqual({ answer: "api:verification/1" });
    expect(await fallback.switches()).toMatchObject([{ from: "opus-cc", to: "opus-api", reason: "usage_limit" }]);
  });

  it(`waits again for a reset that moved, at most ${MAXIMUM_LIMIT_WAITS} times`, async () => {
    const f = await fixture();
    // A window that resets every two minutes and is full again at once: it never answers.
    f.cli.push({ quotaInMs: 2 * MINUTE });
    const clock = new FakeWaitClock();
    const failed = f.create(clock).invoke(request("verification/1", "opus-cc")).then(() => null, (failure: unknown) => failure);
    for (let wait = 1; wait <= MAXIMUM_LIMIT_WAITS; wait += 1) {
      await vi.waitFor(() => { expect(clock.pending).toEqual([3 * MINUTE]); });
      clock.advance(3 * MINUTE);
    }
    expect(await failed).toBeInstanceOf(UsageLimitAfterWaitError);
    expect(f.cliCalls).toHaveLength(MAXIMUM_LIMIT_WAITS + 1);
    expect(clock.pending).toEqual([]);
  });
});
