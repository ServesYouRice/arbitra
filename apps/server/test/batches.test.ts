import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runConfigSchema } from "@arbitra/schemas/config.js";
import { HTTP_ROUTE_SCHEMAS } from "@arbitra/schemas/http-control-plane";
import { Orchestrator } from "@arbitra/runtime/orchestrator.js";
import { controlPlaneCore } from "@arbitra/runtime/control-plane-core.js";
import { orchestratorCore } from "@arbitra/runtime/cli-core.js";
import { ModelActivities } from "@arbitra/runtime/model-activities.js";
import { RunStore } from "@arbitra/runtime/run-store.js";
import { buildServer } from "../src/main.js";
import { BATCH_ROUTE_INVENTORY } from "../src/routes/batches.js";

const BASE = "https://fixture.example/v1/";
type HttpResponse = { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: unknown };
const ok = (body: unknown): HttpResponse => ({ status: 200, headers: {}, body });

/** The OpenAI Batch API over injected HTTP: every creation loses its acknowledgment. */
class FakeOpenAi {
  readonly routes: string[] = [];
  uploads: string[] = [];
  async send(request: { readonly url: string; readonly body: unknown; readonly method?: "GET" | "POST" }): Promise<HttpResponse> {
    const route = `${request.method ?? "POST"} ${request.url.slice(BASE.length)}`;
    this.routes.push(route);
    if (route === "POST files") { this.uploads.push((request.body as { file: { content: string } }).file.content); return ok({ id: "file-in" }); }
    if (route === "POST batches") throw new Error("connection reset after write");
    if (route.startsWith("GET batches?")) return ok({ data: [], has_more: false });
    if (route === "GET batches/batch_console") return ok({ id: "batch_console", status: "completed", output_file_id: "file-out" });
    if (route === "GET files/file-out/content") {
      const [line] = (this.uploads[0] ?? "").trim().split("\n").map((text) => JSON.parse(text) as { custom_id: string });
      return ok(JSON.stringify({ custom_id: line?.custom_id, response: { status_code: 200, body: { output_text: '{"answer":"from console job"}', usage: { input_tokens: 4, output_tokens: 6 } } }, error: null }));
    }
    return { status: 404, headers: {}, body: { error: { message: `unknown ${route}` } } };
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "batch-http-"));
  const original = runConfigSchema.parse(JSON.parse(await readFile(new URL("../../../examples/audit-balanced.json", import.meta.url), "utf8")));
  const model = original.models["auditor-a"];
  if (model === undefined) throw new Error("FIXTURE_MODEL_ABSENT");
  const cheap = { ...model, transport: "openai-responses", supports: { ...model.supports, tools: false, batch: true } };
  const config = runConfigSchema.parse({ ...original, models: { cheap }, workflow: { modelExecution: {
    endpoints: [{ id: "primary", providerId: cheap.provider, transport: "openai-responses", endpoint: "https://fixture.example/v1", apiKeyEnvVar: "FIXTURE_KEY" }],
    modelEndpoints: { cheap: "primary" }, maximumOutputTokens: 10, maximumTokens: 100_000, maximumRetries: 0, timeoutMs: 1_000, rateLimits: { [cheap.provider]: { rpm: 100, tpm: 100_000, maxConcurrent: 4 } },
    batch: { lanes: [{ modelProfileId: "cheap", activityGroups: ["semantic-clustering"], pollIntervalMs: 1_000, maximumWaitMs: 60_000, maximumItemsPerSubmission: 10, collectWindowMs: 0 }] },
  } } });
  const openai = new FakeOpenAi();
  const providerOptions = { client: openai, credential: () => "fixture-credential" };
  const store = new RunStore(join(root, "state", "runs"), "run-1");
  await store.saveContext({ repository: root, repositoryDigest: "a".repeat(64), scope: { kind: "repository" }, consensusPolicy: "minimal", maximumRounds: 1, criticEnabled: false, modelConfiguration: config });
  const invoke = () => new ModelActivities(store, config, providerOptions).invoke({ activityId: "semantic-clustering/pair-1", modelProfileId: "cheap", protocol: "clustering@1",
    messages: [{ role: "user", content: "pair" }], signal: new AbortController().signal, schema: { parse: (value: unknown) => value as { answer: string } } });
  return { root, openai, invoke, orchestrator: () => new Orchestrator({ repository: root, stateDirectory: join(root, "state"), providerOptions }) };
}

it("lists uncertain batch submissions and records one versioned resolution over HTTP, in parity with the CLI port and across a restart", async () => {
  const { root, openai, invoke, orchestrator } = await fixture();
  expect(BATCH_ROUTE_INVENTORY.every(([method, url]) => `${method} ${url}` in HTTP_ROUTE_SCHEMAS)).toBe(true);
  let app = buildServer(controlPlaneCore(orchestrator()));
  try {
    await expect(invoke()).rejects.toMatchObject({ code: "BATCH_SUBMISSION_UNCERTAIN" });
    const listed = await app.inject({ method: "GET", url: "/runs/run-1/batches" });
    expect(listed.statusCode, listed.body).toBe(200);
    const view = listed.json<{ submissions: { id: string; version: string; state: string; resolvable: boolean; error: unknown; reconciliation: unknown; items: { activityId: string; traceId: string }[] }[] }>();
    expect(view).toMatchObject({ runId: "run-1", configured: true, live: false, submissions: [{ state: "uncertain", resolvable: true, providerJobId: null, reconciliationSupport: "metadata_listing",
      error: { code: expect.any(String), message: expect.stringContaining("connection reset") }, reconciliation: { attempts: 1, lastResult: "not_found" }, items: [{ activityId: "semantic-clustering/pair-1", state: "queued", usage: null }] }] });
    // One run, one view: the CLI port returns exactly what the route serves, and flags the pending decision.
    const cli = await orchestratorCore(orchestrator()).batches("run-1");
    expect(cli.value).toEqual(view);
    expect(cli).toMatchObject({ disposition: "suspended", reasons: [`batch_submission_uncertain:${view.submissions[0]?.id}`] });
    const { id, version } = view.submissions[0] ?? { id: "", version: "" };
    const url = `/runs/run-1/batches/${id}/resolve`;

    for (const payload of [{ version, decision: "provider_job", by: "operator" }, { version, decision: "provider_job", providerJobId: "batch_console", by: "operator", extra: true }, { version, decision: "resubmit", by: "operator" }, { version: "short", decision: "abandon", by: "operator" }, { version, decision: "abandon", by: "" }]) {
      expect((await app.inject({ method: "POST", url, payload })).statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await app.inject({ method: "POST", url: "/runs/run-1/batches/not-an-id/resolve", payload: { version, decision: "abandon", by: "operator" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/runs/run-1/batches/${"f".repeat(32)}/resolve`, payload: { version, decision: "abandon", by: "operator" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/runs/run-absent/batches" })).statusCode).toBe(404);
    const stale = await app.inject({ method: "POST", url, payload: { version: "0".repeat(64), decision: "abandon", by: "operator" } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json<{ message: string }>().message).toBe(`BATCH_SUBMISSION_VERSION_STALE:${id}`);
    const unverified = await app.inject({ method: "POST", url, payload: { version, decision: "provider_job", providerJobId: "batch_typo", by: "operator" } });
    expect(unverified.statusCode).toBe(409);
    expect(unverified.json<{ message: string }>().message).toMatch(/^BATCH_PROVIDER_JOB_UNVERIFIED:batch_typo: /u);

    // The server restarts; the decision is recorded against the version the operator saw.
    await app.close();
    app = buildServer(controlPlaneCore(orchestrator()));
    const bound = await app.inject({ method: "POST", url, payload: { version, decision: "provider_job", providerJobId: "batch_console", by: "operator@example" } });
    expect(bound.statusCode, bound.body).toBe(200);
    expect(bound.json()).toMatchObject({ accepted: true, runId: "run-1", submission: { id, state: "submitted", resolvable: false, providerJobId: "batch_console", providerStatus: "completed",
      resolution: { kind: "provider_job", by: "operator@example", version, providerJobId: "batch_console" }, items: [{ state: "submitted" }] } });
    const double = await app.inject({ method: "POST", url, payload: { version, decision: "provider_job", providerJobId: "batch_console", by: "operator@example" } });
    expect(double.statusCode).toBe(409);
    expect(double.json<{ message: string }>().message).toBe(`BATCH_SUBMISSION_NOT_UNCERTAIN:${id}:submitted`);
    expect((await orchestratorCore(orchestrator()).batches("run-1")).disposition).toBe("passed");

    // The bound job is polled and collected; nothing billable is created again.
    await expect(invoke()).resolves.toEqual({ answer: "from console job" });
    expect(openai.routes.filter((route) => route === "POST batches")).toHaveLength(1);
    const collected = (await app.inject({ method: "GET", url: "/runs/run-1/batches" })).json<{ submissions: unknown[] }>();
    expect(collected.submissions).toMatchObject([{ id, state: "ended", items: [{ activityId: "semantic-clustering/pair-1", traceId: view.submissions[0]?.items[0]?.traceId, state: "succeeded", usage: { inputTokens: 4, outputTokens: 6 } }] }]);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
