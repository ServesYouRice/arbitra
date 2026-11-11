import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runConfigSchema } from "@arbitra/schemas/config.js";
import { TransportError, type HttpClient, type HttpRequest, type ProviderTransport, type TransportResponse } from "@arbitra/providers/transport-contract.js";
import { ProviderBudgetSuspendedError, ProviderUsageLimitError } from "@arbitra/providers/runtime.js";
import type { TransportFactory } from "@arbitra/providers/registry.js";
import { ModelActivities } from "../src/model-activities.js";
import { MODEL_ROUTES_KIND, type ModelRouteState } from "../src/model-routes.js";
import { RunStore } from "../src/run-store.js";
import { loadActivityTraces } from "@arbitra/persistence/trace.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

/** Usage worth $1.80 on Opus 5.5: 100K uncached input ($0.40), 200K cache writes ($1.00), 1M cache reads ($0.20), 10K output ($0.20). */
const PRICED_USAGE = { input_tokens: 100_000, cache_creation_input_tokens: 200_000, cache_read_input_tokens: 1_000_000, output_tokens: 10_000 };

type CliReply = { readonly text: string } | { readonly quotaInMs: number | null };

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
      throw new TransportError("QUOTA", `CLI_USAGE_LIMIT_REACHED: the Claude Code subscription's usage allowance is exhausted${reply.quotaInMs === null ? "" : ` until ${new Date(Date.now() + reply.quotaInMs).toISOString()}`}`, false, reply.quotaInMs);
    }
    return { text: JSON.stringify({ answer: `cc:${user}` }), structured: null, toolCalls: [], refusal: null, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      continuation: null, structuredOutputTier: "prompt_json", providerRequestId: null };
  } } satisfies ProviderTransport);
  const options = { client: { send }, credential: () => "fixture-credential", factories: { "claude-code-cli": subscription } };
  const create = () => new ModelActivities(store, config, options);
  const routes = async (): Promise<ModelRouteState | null> => {
    const artifact = (await store.listArtifacts()).find(({ kind }) => kind === MODEL_ROUTES_KIND);
    return artifact === undefined ? null : JSON.parse((await store.readArtifact(artifact.artifactId)).content) as ModelRouteState;
  };
  const answer = async (activityId: string) => {
    const kind = `model-activity-${createHash("sha256").update(JSON.stringify(activityId)).digest("hex")}`;
    const artifact = (await store.listArtifacts()).find((item) => item.kind === kind);
    return artifact === undefined ? null : JSON.parse((await store.readArtifact(artifact.artifactId)).content) as { replayIdentity: string; answeredBy?: string; value: unknown };
  };
  const switches = async () => (await store.loadEvents()).filter((event) => event.t === "model_route_switched");
  return { directory, store, send, cli, cliCalls, create, routes, answer, switches, setApiOut: (value: boolean) => { apiOut = value; } };
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
    const f = await fixture({ fallbacks: { "opus-api": "opus-cc", "opus-cc": "opus-api" }, fallbackWaitMs: 100 });
    f.cli.push({ quotaInMs: 300 }, { text: "unused" });
    const activities = f.create();
    expect(await activities.invoke(request("critic/1", "opus-cc"))).toEqual({ answer: "api:critic/1" });
    const [switched] = await f.switches();
    expect(switched).toMatchObject({ from: "opus-cc", to: "opus-api", reason: "usage_limit", spentUsd: null });
    expect(Date.parse(switched?.resetsAt ?? "")).toBeGreaterThan(Date.now());
    expect(await activities.invoke(request("critic/2", "opus-cc"))).toEqual({ answer: "api:critic/2" });
    // Once the window has reset, the subscription answers again, and the run says so.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await activities.invoke(request("critic/3", "opus-cc"))).toEqual({ answer: "cc:critic/3" });
    expect((await f.switches()).map(({ from, to, reason }) => `${from}>${to}:${reason}`)).toEqual(["opus-cc>opus-api:usage_limit", "opus-api>opus-cc:reset"]);
  });

  it("waits for a subscription's limit that resets soon, and pauses as rate limited rather than pay for the API", async () => {
    const f = await fixture({ fallbacks: { "opus-cc": "opus-api" } });
    f.cli.push({ quotaInMs: 10 * 60_000 });
    await expect(f.create().invoke(request("critic/1", "opus-cc"))).rejects.toBeInstanceOf(ProviderUsageLimitError);
    expect(f.send).not.toHaveBeenCalled();
    expect(await f.switches()).toEqual([]);
    // A limit with no reset time given, like a weekly one hours away, switches.
    f.cli.splice(0, f.cli.length, { quotaInMs: null });
    expect(await f.create().invoke(request("critic/2", "opus-cc"))).toEqual({ answer: "api:critic/2" });
    expect(await f.switches()).toMatchObject([{ from: "opus-cc", to: "opus-api", reason: "usage_limit" }]);
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
