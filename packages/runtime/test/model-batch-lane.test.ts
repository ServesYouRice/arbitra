import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runConfigSchema, type RunConfig } from "@arbitra/schemas/config.js";
import type { HttpClient, HttpRequest, HttpResponse } from "@arbitra/providers/transport-contract.js";
import { ModelActivities } from "../src/model-activities.js";
import { validateBatchLanes } from "../src/model-batch-lane.js";
import { RunStore } from "../src/run-store.js";
import { Orchestrator } from "../src/orchestrator.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const BASE = "https://fixture.example/v1/";

async function fixture(options: { transport?: string; batch?: boolean; tools?: boolean; itemsPerSubmission?: number; collectWindowMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "arbitra-model-batch-"));
  directories.push(root);
  const example = JSON.parse(await readFile(new URL("../../../examples/audit-balanced.json", import.meta.url), "utf8")) as Record<string, unknown>;
  const original = runConfigSchema.parse(example);
  const model = original.models["auditor-a"];
  if (model === undefined) throw new Error("FIXTURE_MODEL_ABSENT");
  const cheap = { ...model, transport: options.transport ?? model.transport, supports: { ...model.supports, tools: options.tools ?? false, batch: options.batch ?? true } };
  const config: RunConfig = runConfigSchema.parse({ ...original, models: { cheap }, workflow: {
    modelExecution: {
      endpoints: [{ id: "primary", providerId: cheap.provider, transport: cheap.transport, endpoint: "https://fixture.example/v1", apiKeyEnvVar: "FIXTURE_KEY" }],
      modelEndpoints: { cheap: "primary" }, maximumOutputTokens: 10, maximumTokens: 100_000,
      maximumRetries: 0, timeoutMs: 1_000, rateLimits: { [cheap.provider]: { rpm: 100, tpm: 100_000, maxConcurrent: 4 } },
      batch: { lanes: [{ modelProfileId: "cheap", activityGroups: ["semantic-clustering"], pollIntervalMs: 1_000, maximumWaitMs: 60_000, maximumItemsPerSubmission: options.itemsPerSubmission ?? 10, collectWindowMs: options.collectWindowMs ?? 250 }] },
    },
  } });
  const state = join(root, "state");
  const store = new RunStore(join(state, "runs"), "run-1");
  const openai = new FakeOpenAi();
  const providerOptions = { client: openai, credential: () => "fixture-credential" };
  const create = () => new ModelActivities(store, config, providerOptions);
  // A restarted process: a new orchestrator over the same state directory.
  const orchestrator = () => new Orchestrator({ repository: root, stateDirectory: state, providerOptions });
  const saveContext = () => store.saveContext({ repository: root, repositoryDigest: "a".repeat(64), scope: { kind: "repository" }, consensusPolicy: "minimal", maximumRounds: 1, criticEnabled: false, modelConfiguration: config });
  return { store, openai, create, config, orchestrator, saveContext };
}

/** OpenAI Batch and Responses APIs as documented, over injected HTTP. */
class FakeOpenAi implements HttpClient {
  readonly requests: HttpRequest[] = [];
  uploads: string[] = [];
  createBatch: () => Promise<HttpResponse> = async () => ({ status: 200, headers: {}, body: { id: "batch_1", status: "validating" } });
  listing: unknown[] = [];

  async send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const route = `${request.method ?? "POST"} ${request.url.slice(BASE.length)}`;
    if (route === "POST responses") return ok({ id: "resp-1", output_text: '{"answer":"interactive"}', usage: { input_tokens: 2, output_tokens: 3 } });
    if (route === "POST files") {
      this.uploads.push((request.body as { file: { content: string } }).file.content);
      return ok({ id: `file-in-${this.uploads.length}` });
    }
    if (route === "POST batches") return this.createBatch();
    if (route.startsWith("GET batches?")) return ok({ data: this.listing, has_more: false });
    if (route === "GET batches/batch_1") return ok({ id: "batch_1", status: "completed", output_file_id: "file-out" });
    if (route === "GET files/file-out/content") {
      const lines = (this.uploads.at(-1) ?? "").trim().split("\n").map((line) => JSON.parse(line) as { custom_id: string; body: { input: { content: string }[] } });
      // Reverse order: results are matched by custom_id, never by position.
      return ok(lines.reverse().map(({ custom_id, body }) => JSON.stringify({ custom_id, response: { status_code: 200, request_id: `req-${custom_id}`,
        body: { output_text: JSON.stringify({ answer: body.input[0]?.content }), usage: { input_tokens: 4, output_tokens: 6 } } }, error: null })).join("\n"));
    }
    throw new Error(`UNROUTED:${route}`);
  }
}
const ok = (body: unknown): HttpResponse => ({ status: 200, headers: {}, body });

function request(activityId: string, content = activityId) {
  return { activityId, modelProfileId: "cheap", protocol: "clustering@1", messages: [{ role: "user" as const, content }], signal: new AbortController().signal,
    responseMode: "harness_turn" as const, tools: [],
    schema: { parse(value: unknown): { answer: string } {
      // Stored results are re-parsed on reuse, so accept the already-parsed shape too.
      if (typeof (value as { answer?: unknown }).answer === "string") return value as { answer: string };
      const text = (value as { text?: unknown }).text;
      if (typeof text !== "string") throw new Error("INVALID_TURN");
      return JSON.parse(text) as { answer: string };
    } },
  };
}
async function artifact(store: RunStore, kind: (value: string) => boolean): Promise<unknown[]> {
  const matches = (await store.listArtifacts()).filter((item) => kind(item.kind));
  return Promise.all(matches.map(async (item) => JSON.parse((await store.readArtifact(item.artifactId)).content) as unknown));
}

describe("model activities on an explicit batch lane", () => {
  it("batches only configured activity groups, keeps others interactive, records provenance and reuses results after restart", async () => {
    // The lane flushes as soon as a group is full, so two items form exactly one submission
    // however slowly they arrive; a timing window alone split them on a loaded machine.
    const { create, openai, store } = await fixture({ itemsPerSubmission: 2, collectWindowMs: 60_000 });
    const activities = create();
    const [first, second, interactive] = await Promise.all([
      activities.invoke(request("semantic-clustering/pair-1")), activities.invoke(request("semantic-clustering/pair-2")), activities.invoke(request("critic/review")),
    ]);
    expect(first).toEqual({ answer: "semantic-clustering/pair-1" });
    expect(second).toEqual({ answer: "semantic-clustering/pair-2" });
    expect(interactive).toEqual({ answer: "interactive" });
    const routes = openai.requests.map(({ method, url }) => `${method ?? "POST"} ${url.slice(BASE.length)}`);
    expect(routes.filter((route) => route === "POST responses")).toHaveLength(1);
    expect(routes.filter((route) => route === "POST batches")).toHaveLength(1);
    expect(openai.uploads[0]?.trim().split("\n")).toHaveLength(2);

    const traces = await artifact(store, (kind) => kind.endsWith("-trace")) as { activityId: string; provenance: Record<string, unknown> }[];
    const batchTrace = traces.find(({ activityId }) => activityId === "semantic-clustering/pair-2");
    expect(batchTrace?.provenance).toMatchObject({ lane: "batch", usage: { inputTokens: 4, outputTokens: 6 }, batch: {
      lane: "batch", driverId: "openai-batch", providerJobId: "batch_1", late: false, capability: { status: "declared_unverified", liveValidation: null },
    } });
    expect(traces.find(({ activityId }) => activityId === "critic/review")?.provenance).toMatchObject({ lane: "interactive" });
    expect(traces.find(({ activityId }) => activityId === "critic/review")?.provenance).not.toHaveProperty("batch");
    const [budget] = await artifact(store, (kind) => kind === "model-token-budget") as { reservations: { activityId: string; usage: unknown }[] }[];
    expect(budget?.reservations.filter(({ activityId }) => activityId.startsWith("semantic-clustering/")).map(({ usage }) => usage)).toEqual([
      { inputTokens: 4, outputTokens: 6, cacheReadTokens: null, cacheWriteTokens: null }, { inputTokens: 4, outputTokens: 6, cacheReadTokens: null, cacheWriteTokens: null },
    ]);

    const before = openai.requests.length;
    expect(await create().invoke(request("semantic-clustering/pair-1"))).toEqual({ answer: "semantic-clustering/pair-1" });
    expect(openai.requests).toHaveLength(before);
    expect(await create().batchSubmissions()).toMatchObject([{ state: "ended", driverId: "openai-batch", capabilityStatus: "declared_unverified" }]);
  });

  it("surfaces a lost submission acknowledgment to the operator instead of resubmitting after restart", async () => {
    const { create, openai } = await fixture();
    openai.createBatch = async () => { throw new Error("connection reset after write"); };
    await expect(create().invoke(request("semantic-clustering/pair-1"))).rejects.toMatchObject({ code: "BATCH_SUBMISSION_UNCERTAIN" });
    openai.createBatch = async () => ok({ id: "batch_2" });
    await expect(create().invoke(request("semantic-clustering/pair-1"))).rejects.toMatchObject({ code: "BATCH_SUBMISSION_UNCERTAIN" });
    const creations = () => openai.requests.filter(({ method, url }) => (method ?? "POST") === "POST" && url === `${BASE}batches`).length;
    expect(creations()).toBe(1);
    const [submission] = await create().batchView();
    expect(submission).toMatchObject({ state: "uncertain", reconciliation: { lastResult: "not_found" } });

    // The operator confirms the job exists in the provider console.
    await create().resolveBatchSubmission(submission?.id ?? "", submission?.version ?? "", { decision: "provider_job", providerJobId: "batch_1" }, "operator");
    await expect(create().invoke(request("semantic-clustering/pair-1"))).resolves.toEqual({ answer: "semantic-clustering/pair-1" });
    expect(creations()).toBe(1);
  });

  it("lists uncertain submissions through the orchestrator and records one versioned operator decision that survives restart", async () => {
    const { create, openai, orchestrator, saveContext, store } = await fixture();
    await expect(orchestrator().batchSubmissions("run-1")).rejects.toMatchObject({ statusCode: 404 });
    await saveContext();
    expect(await orchestrator().batchSubmissions("run-1")).toEqual({ runId: "run-1", configured: true, live: false, submissions: [] });
    openai.createBatch = async () => ({ status: 503, headers: {}, body: { error: { message: "overloaded" } } });
    await expect(create().invoke(request("semantic-clustering/pair-1"))).rejects.toMatchObject({ code: "BATCH_SUBMISSION_UNCERTAIN" });
    const creations = () => openai.requests.filter(({ method, url }) => (method ?? "POST") === "POST" && url === `${BASE}batches`).length;

    const listed = await orchestrator().batchSubmissions("run-1");
    const [uncertain] = listed.submissions;
    const traceId = uncertain?.items[0]?.traceId;
    expect(uncertain).toMatchObject({ state: "uncertain", resolvable: true, driverId: "openai-batch", capabilityStatus: "declared_unverified", reconciliationSupport: "metadata_listing",
      providerJobId: null, sentAt: expect.any(Number), error: { code: expect.any(String) }, reconciliation: { attempts: 1, lastResult: "not_found" }, resolution: null,
      items: [{ activityId: "semantic-clustering/pair-1", traceId: expect.any(String), attempt: 1, state: "queued", usage: null }] });
    const id = uncertain?.id ?? ""; const version = uncertain?.version ?? "";
    const [budget] = await artifact(store, (kind) => kind === "model-token-budget") as { reservations: unknown[] }[];

    await expect(orchestrator().resolveBatchSubmission("run-1", id, { version: "0".repeat(64), decision: "not_submitted", by: "operator" })).rejects.toMatchObject({ statusCode: 409, message: `BATCH_SUBMISSION_VERSION_STALE:${id}` });
    await expect(orchestrator().resolveBatchSubmission("run-1", "f".repeat(32), { version, decision: "not_submitted", by: "operator" })).rejects.toMatchObject({ statusCode: 404 });
    await expect(orchestrator().resolveBatchSubmission("run-1", id, { version, decision: "not_submitted" })).rejects.toThrow();
    const accepted = await orchestrator().resolveBatchSubmission("run-1", id, { version, decision: "not_submitted", by: "operator" });
    expect(accepted).toMatchObject({ accepted: true, runId: "run-1", submission: { id, state: "abandoned", resolvable: false, resolution: { kind: "not_submitted", by: "operator", version },
      items: [{ state: "not_submitted", reservationTransferred: false }] } });
    await expect(orchestrator().resolveBatchSubmission("run-1", id, { version, decision: "abandon", by: "operator" })).rejects.toMatchObject({ statusCode: 409, message: `BATCH_SUBMISSION_NOT_UNCERTAIN:${id}:abandoned` });
    expect(creations()).toBe(1);
    // Declaring it absent refunds nothing: the reservation is unchanged until the next attempt takes it over.
    expect(await artifact(store, (kind) => kind === "model-token-budget")).toEqual([budget]);

    openai.createBatch = async () => ok({ id: "batch_1", status: "validating" });
    await expect(create().invoke(request("semantic-clustering/pair-1"))).resolves.toEqual({ answer: "semantic-clustering/pair-1" });
    expect(creations()).toBe(2);
    const resumed = await orchestrator().batchSubmissions("run-1");
    const summary = resumed.submissions.map(({ state, items }) => ({ state, items: items.map(({ attempt, state: itemState, traceId: itemTrace, reservationTransferred }) => ({ attempt, itemState, itemTrace, reservationTransferred })) }));
    expect(summary.sort((a, b) => a.state.localeCompare(b.state))).toEqual([
      { state: "abandoned", items: [{ attempt: 1, itemState: "not_submitted", itemTrace: traceId, reservationTransferred: true }] },
      { state: "ended", items: [{ attempt: 2, itemState: "succeeded", itemTrace: traceId, reservationTransferred: false }] },
    ]);
    const [after] = await artifact(store, (kind) => kind === "model-token-budget") as { reservations: { activityId: string }[] }[];
    expect(after?.reservations.filter(({ activityId }) => activityId === "semantic-clustering/pair-1")).toHaveLength(1);
  });

  it("rejects unsupported batch lanes at preflight with an actionable error", async () => {
    const chat = await fixture({ transport: "openai-chat" });
    expect(() => validateBatchLanes(chat.config)).toThrow(/BATCH_LANE_UNSUPPORTED_ENDPOINT:primary: transport "openai-chat" has no batch driver/u);
    expect(() => chat.create()).toThrow("BATCH_LANE_UNSUPPORTED_ENDPOINT");
    const undeclared = await fixture({ batch: false });
    expect(() => validateBatchLanes(undeclared.config)).toThrow("BATCH_LANE_MODEL_UNSUPPORTED:cheap");
    const interactive = await fixture({ tools: true });
    expect(() => validateBatchLanes(interactive.config)).toThrow("BATCH_LANE_INTERACTIVE_PROFILE:cheap");
    expect(chat.openai.requests).toEqual([]);
  });
});
