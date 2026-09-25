import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Orchestrator } from "@arbitra/runtime/orchestrator.js";
import { orchestratorCore } from "@arbitra/runtime/cli-core.js";
import { ModelActivities } from "@arbitra/runtime/model-activities.js";
import { RunStore } from "@arbitra/runtime/run-store.js";
import { runCli } from "../src/main.js";

const BASE = "https://fixture.example/v1/";
type HttpResponse = { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: unknown };
const io = { writeStdout: () => undefined, writeStderr: () => undefined };

/** The OpenAI Batch API over injected HTTP: every creation loses its acknowledgment and the listing never shows it. */
class FakeOpenAi {
  readonly routes: string[] = [];
  async send(request: { readonly url: string; readonly method?: "GET" | "POST" }): Promise<HttpResponse> {
    const route = `${request.method ?? "POST"} ${request.url.slice(BASE.length)}`;
    this.routes.push(route);
    if (route === "POST files") return { status: 200, headers: {}, body: { id: "file-in" } };
    if (route === "POST batches") return { status: 502, headers: {}, body: { error: { message: "bad gateway" } } };
    if (route.startsWith("GET batches?")) return { status: 200, headers: {}, body: { data: [], has_more: false } };
    return { status: 404, headers: {}, body: { error: { message: `unknown ${route}` } } };
  }
}

it("lists uncertain batch submissions with exit 3 and abandons one by explicit, versioned decision without resubmitting", async () => {
  const root = await mkdtemp(join(tmpdir(), "batch-cli-"));
  try {
    const validate = (value: unknown) => new Orchestrator({ repository: root, stateDirectory: join(root, "state") }).configurations.validate(value);
    const original = validate(JSON.parse(await readFile(new URL("../../../examples/audit-balanced.json", import.meta.url), "utf8")));
    const model = original.models["auditor-a"];
    if (model === undefined) throw new Error("FIXTURE_MODEL_ABSENT");
    const cheap = { ...model, transport: "openai-responses", supports: { ...model.supports, tools: false, batch: true } };
    const config = validate({ ...original, models: { cheap }, workflow: { modelExecution: {
      endpoints: [{ id: "primary", providerId: cheap.provider, transport: "openai-responses", endpoint: "https://fixture.example/v1", apiKeyEnvVar: "FIXTURE_KEY" }],
      modelEndpoints: { cheap: "primary" }, maximumOutputTokens: 10, maximumTokens: 100_000, maximumRetries: 0, timeoutMs: 1_000, rateLimits: { [cheap.provider]: { rpm: 100, tpm: 100_000, maxConcurrent: 4 } },
      batch: { lanes: [{ modelProfileId: "cheap", activityGroups: ["semantic-clustering"], pollIntervalMs: 1_000, maximumWaitMs: 60_000, maximumItemsPerSubmission: 10, collectWindowMs: 0 }] },
    } } });
    const openai = new FakeOpenAi();
    const providerOptions = { client: openai, credential: () => "fixture-credential" };
    const store = new RunStore(join(root, "state", "runs"), "run-1");
    await store.saveContext({ repository: root, repositoryDigest: "a".repeat(64), scope: { kind: "repository" }, consensusPolicy: "minimal", maximumRounds: 1, criticEnabled: false, modelConfiguration: config });
    const invoke = () => new ModelActivities(store, config, providerOptions).invoke({ activityId: "semantic-clustering/pair-1", modelProfileId: "cheap", protocol: "clustering@1",
      messages: [{ role: "user", content: "pair" }], signal: new AbortController().signal, schema: { parse: (value: unknown) => value } });
    // Every command is a fresh process over the same state directory.
    const cli = () => orchestratorCore(new Orchestrator({ repository: root, stateDirectory: join(root, "state"), providerOptions }));
    await expect(invoke()).rejects.toMatchObject({ code: "BATCH_SUBMISSION_UNCERTAIN" });

    const listed = await runCli(["batches", "run-1", "--json"], cli(), io);
    expect(listed.exit).toBe(3);
    const view = listed.output.result as { submissions: { id: string; version: string }[] };
    const { id, version } = view.submissions[0] ?? { id: "", version: "" };
    expect(listed.output.policy.reasons).toEqual([`batch_submission_uncertain:${id}`]);
    expect(view).toMatchObject({ configured: true, submissions: [{ state: "uncertain", resolvable: true, error: { code: expect.any(String) }, reconciliation: { lastResult: "not_found" }, items: [{ activityId: "semantic-clustering/pair-1", state: "queued" }] }] });

    for (const argv of [["resolve-batch", "run-1", id, version, "abandon"], ["resolve-batch", "run-1", id, version, "provider_job", "--by=operator"], ["resolve-batch", "run-1", id, version, "abandon", "batch_1", "--by=operator"],
      ["resolve-batch", "run-1", id, version, "resubmit", "--by=operator"], ["resolve-batch", "run-1", id, version, "abandon", "--by=a", "--by=b"], ["batches"]]) {
      expect((await runCli([...argv, "--json"], cli(), io)).exit, argv.join(" ")).toBe(2);
    }
    const stale = await runCli(["resolve-batch", "run-1", id, "0".repeat(64), "abandon", "--by=operator", "--json"], cli(), io);
    expect(stale.exit).toBe(2);
    expect(stale.output.result).toMatchObject({ message: `BATCH_SUBMISSION_VERSION_STALE:${id}` });
    const abandoned = await runCli(["resolve-batch", "run-1", id, version, "abandon", "--by=operator", "--json"], cli(), io);
    expect(abandoned.exit).toBe(0);
    expect(abandoned.output.result).toMatchObject({ accepted: true, submission: { id, state: "abandoned", resolution: { kind: "abandoned", by: "operator", version }, items: [{ state: "errored", usage: null, error: { code: "BATCH_ABANDONED_BY_OPERATOR" } }] } });
    const double = await runCli(["resolve-batch", "run-1", id, version, "abandon", "--by=operator", "--json"], cli(), io);
    expect(double.exit).toBe(2);
    expect(double.output.result).toMatchObject({ message: `BATCH_SUBMISSION_NOT_UNCERTAIN:${id}:abandoned` });
    expect((await runCli(["batches", "run-1", "--json"], cli(), io)).exit).toBe(0);

    // The abandoned item fails explicitly on resume; nothing billable is sent again.
    await expect(invoke()).rejects.toThrow("BATCH_ABANDONED_BY_OPERATOR");
    expect(openai.routes.filter((route) => route === "POST batches")).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
