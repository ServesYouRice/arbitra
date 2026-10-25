import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runConfigSchema } from "@arbitra/schemas/config.js";
import type { HttpClient } from "@arbitra/providers/transport-contract.js";
import { IncrementalSeed, type IncrementalContract } from "../src/incremental-audit.js";
import { ModelActivities, parsePromptJson } from "../src/model-activities.js";
import { RunStore } from "../src/run-store.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture(maximumTokens = 10_000, maximumRetries = 0) {
  const root = await mkdtemp(join(tmpdir(), "arbitra-model-activities-"));
  directories.push(root);
  const example = JSON.parse(await readFile(new URL("../../../examples/audit-balanced.json", import.meta.url), "utf8")) as Record<string, unknown>;
  const original = runConfigSchema.parse(example);
  const model = original.models["auditor-a"];
  if (model === undefined) throw new Error("FIXTURE_MODEL_ABSENT");
  const config = runConfigSchema.parse({ ...original, models: { "auditor-a": model }, workflow: {
    modelExecution: {
      endpoints: [{ id: "primary", providerId: model.provider, transport: model.transport, endpoint: "https://fixture.example/v1", apiKeyEnvVar: "FIXTURE_KEY" }],
      modelEndpoints: { "auditor-a": "primary" }, maximumOutputTokens: 10, maximumTokens,
      maximumRetries, timeoutMs: 1_000, rateLimits: { [model.provider]: { rpm: 100, tpm: 100_000, maxConcurrent: 4 } },
    },
  } });
  const store = new RunStore(root, "run-1");
  const send = vi.fn<HttpClient["send"]>(async () => ({ status: 200, headers: {}, body: {
    id: "response-1", output_text: '{"answer":"ok"}', usage: { input_tokens: 2, output_tokens: 3 },
  } }));
  const client = { client: { send }, credential: () => "fixture-credential" };
  const create = () => new ModelActivities(store, config, client);
  return { store, send, create, root, config, client };
}
function request(activityId = "auditor-a/discovery") {
  return { activityId, modelProfileId: "auditor-a", protocol: "discovery@1", messages: [{ role: "user" as const, content: "Return a JSON answer." }], signal: new AbortController().signal,
    schema: { parse(value: unknown) {
      if (typeof value !== "object" || value === null || !("answer" in value) || typeof value.answer !== "string") throw new Error("INVALID_ANSWER");
      return { answer: value.answer };
    } },
  };
}

describe("durable model activities", () => {
  it("reuses a completed call after restart, records usage, and deduplicates concurrent calls", async () => {
    const { create, send, store } = await fixture();
    const activities = create();
    expect(await Promise.all([activities.invoke(request()), activities.invoke(request())])).toEqual([{ answer: "ok" }, { answer: "ok" }]);
    expect(await create().invoke(request())).toEqual({ answer: "ok" });
    expect(send).toHaveBeenCalledTimes(1);
    const artifacts = await store.listArtifacts();
    const trace = artifacts.find(({ kind }) => kind.endsWith("-trace"));
    if (trace === undefined) throw new Error("TRACE_ABSENT");
    expect(JSON.parse((await store.readArtifact(trace.artifactId)).content)).toMatchObject({ provenance: { providerId: "openai", usage: { inputTokens: 2, outputTokens: 3 } } });
  });

  it("refuses changed prompts or protocol versions for the same activity", async () => {
    const { create, send } = await fixture();
    await create().invoke(request());
    await expect(create().invoke({ ...request(), protocol: "discovery@2" })).rejects.toThrow("MODEL_ACTIVITY_INPUT_CHANGED");
    await expect(create().invoke({ ...request(), messages: [{ role: "user", content: "Different" }] })).rejects.toThrow("MODEL_ACTIVITY_INPUT_CHANGED");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("says which recorded activity no longer matches, and to resume with the version the run started on or start again", async () => {
    // Observed live (veritra, October 25): a code change altered one sentence every critic batch carries, and the resume
    // failed with the bare code MODEL_ACTIVITY_INPUT_CHANGED.
    const reworded = (activityId: string) => ({ ...request(activityId), messages: [{ role: "user" as const, content: "Return a JSON answer, reworded." }] });
    const unrecorded = await fixture();
    await unrecorded.create().invoke(request("critic/review/batch-1"));
    await expect(unrecorded.create().invoke(reworded("critic/review/batch-1"))).rejects.toThrow(/^MODEL_ACTIVITY_INPUT_CHANGED:critic\/review\/batch-1: the request this version of arbitra makes for critic\/review\/batch-1 differs from the one the run recorded, so the run cannot reuse that work\. Resume it with the arbitra version it started on, or start a new run\.$/u);
    // The run recorded the build it started on: the message names it, for a finished call and for one that failed.
    const { create, send, store } = await fixture();
    await store.publish("environment-versions", { arbitra: "45ed1d2", cli: {} });
    await create().invoke(request("critic/review/batch-1"));
    await expect(create().invoke(reworded("critic/review/batch-1"))).rejects.toThrow(/^MODEL_ACTIVITY_INPUT_CHANGED:critic\/review\/batch-1: .* Resume it with the arbitra version it started on, "45ed1d2", or start a new run\.$/u);
    send.mockResolvedValue({ status: 500, headers: {}, body: {} });
    await expect(create().invoke(request("critic/review/batch-2"))).rejects.toThrow("Provider openai failed");
    await expect(create().invoke(reworded("critic/review/batch-2"))).rejects.toThrow(/^MODEL_ACTIVITY_INPUT_CHANGED:critic\/review\/batch-2: .*"45ed1d2"/u);
  });

  it("keeps failed attempts charged across restart and binds their original input", async () => {
    const { create, send } = await fixture(100);
    send.mockResolvedValue({ status: 500, headers: {}, body: {} });
    await expect(create().invoke(request())).rejects.toThrow("Provider openai failed");
    await expect(create().invoke({ ...request(), protocol: "changed" })).rejects.toThrow("MODEL_ACTIVITY_INPUT_CHANGED");
    await expect(create().invoke(request())).rejects.toMatchObject({ state: "SUSPENDED_BUDGET" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("releases a refused attempt so its retry completes within a budget the estimate alone would exhaust", async () => {
    // Observed live: six 503 retries were charged 350k of a 600k run cap although none produced tokens.
    const { create, send } = await fixture(100, 1);
    send.mockResolvedValueOnce({ status: 503, headers: {}, body: { error: { message: "The model is overloaded", type: "overloaded_error" } } });
    await expect(create().invoke(request())).resolves.toEqual({ answer: "ok" });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("takes a validated answer from its trace when the answer's mapping was never written, and never asks again", async () => {
    // The answer and its trace were saved, the mapping write failed, and the next call paid for the answer twice.
    const { create, send, store } = await fixture();
    const publish = store.publish.bind(store);
    const failing = vi.spyOn(store, "publish").mockImplementation(async (kind, value, nodeId) => {
      if (/^model-activity-[0-9a-f]{64}$/u.test(kind)) throw new Error("MAPPING_WRITE_FAILED");
      return publish(kind, value, nodeId);
    });
    await expect(create().invoke(request())).rejects.toThrow("MAPPING_WRITE_FAILED");
    failing.mockRestore();
    // Only the same request may take it.
    await expect(create().invoke({ ...request(), protocol: "discovery@2" })).rejects.toThrow("MODEL_ACTIVITY_INPUT_CHANGED");
    expect(await create().invoke(request())).toEqual({ answer: "ok" });
    expect(await create().invoke(request())).toEqual({ answer: "ok" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not persist invalid JSON as a completed result and retains both attempts", async () => {
    const { create, send, store } = await fixture();
    send.mockResolvedValueOnce({ status: 200, headers: {}, body: { output_text: "not JSON" } });
    await expect(create().invoke(request())).rejects.toThrow("MODEL_ACTIVITY_INVALID_JSON");
    expect(await create().invoke(request())).toEqual({ answer: "ok" });
    const trace = (await store.listArtifacts()).find(({ kind }) => kind.endsWith("-trace"));
    if (trace === undefined) throw new Error("TRACE_ABSENT");
    expect(JSON.parse((await store.readArtifact(trace.artifactId)).content).attempts).toHaveLength(2);
  });

  it("replays a saved answer asked under a higher output ceiling when it fits the lower one, and keeps a resume strict", async () => {
    // Since October 25, 2026 a verification answer asks for at most 16,000 tokens where earlier runs asked for the
    // model's ceiling (128,000), and a replay of such a run asked every verification question again.
    const { create, send, store, root, config, client } = await fixture();
    const question = request("verification/C-1/turn-0");
    await create().invoke(question);
    const replay = async (runId: string, changed: Partial<ReturnType<typeof request>> & { maximumOutputTokens: number }) => {
      const target = new RunStore(root, runId);
      const seed = new IncrementalSeed(store, target, { baseRunId: store.runId, stages: [{ stage: "verification", decision: "reuse" }] } as unknown as IncrementalContract);
      await new ModelActivities(target, config, client, seed).invoke({ ...question, ...changed });
      const record = (await target.listArtifacts()).find(({ kind }) => kind.startsWith("incremental-activity-"));
      return record === undefined ? null : JSON.parse((await target.readArtifact(record.artifactId)).content) as { decision: string; reason?: string };
    };
    // The saved answer wrote 3 tokens under the run's ceiling of 10.
    expect(await replay("replay-fits", { maximumOutputTokens: 5 })).toMatchObject({ decision: "reused" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(await replay("replay-above", { maximumOutputTokens: 2 })).toMatchObject({ decision: "regenerated", reason: "source_output_above_ceiling" });
    expect(await replay("replay-changed", { maximumOutputTokens: 5, messages: [{ role: "user", content: "Different" }] })).toMatchObject({ decision: "regenerated", reason: "activity_identity_changed" });
    expect(send).toHaveBeenCalledTimes(3);
    // The run itself, resumed, does not take its answer under another ceiling.
    await expect(create().invoke({ ...question, maximumOutputTokens: 5 })).rejects.toThrow("MODEL_ACTIVITY_INPUT_CHANGED");
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("rejects cancelled calls before publishing or spending", async () => {
    const { create, send, store } = await fixture();
    const controller = new AbortController(); controller.abort();
    await expect(create().invoke({ ...request(), signal: controller.signal })).rejects.toThrow("MODEL_ACTIVITY_CANCELLED");
    expect(send).not.toHaveBeenCalled();
    expect(await store.listArtifacts()).toEqual([]);
  });
});

describe("prompt-JSON replies", () => {
  it("accepts the requested leading <quotes> block and a Markdown fence, and nothing looser", () => {
    expect(parsePromptJson('{"a":1}')).toEqual({ a: 1 });
    expect(parsePromptJson('<quotes>\n1. "x" (src/a.js:1-2: `a < b`)\n</quotes>\n\n{"a":1}')).toEqual({ a: 1 });
    expect(parsePromptJson('<quotes>q</quotes>\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parsePromptJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parsePromptJson('<quotes>\nexport const a = { b: 1 };\n</quotes>\n\nThe session logic is risky.\n\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parsePromptJson('<quotes>q</quotes>\nReasoning mentions {"a":0} inline.\n{\n  "a": 1\n}\n')).toEqual({ a: 1 });
    expect(() => parsePromptJson('Here is the answer: {"a":1}')).toThrow("MODEL_ACTIVITY_INVALID_JSON");
    expect(() => parsePromptJson('{"a":1}\nThanks!')).toThrow("MODEL_ACTIVITY_INVALID_JSON");
    expect(() => parsePromptJson('{"a":1}\n<quotes>late</quotes>')).toThrow("MODEL_ACTIVITY_INVALID_JSON");
  });

  it("reads past closing brackets left over after a complete document, and past a fenced block the model abandoned", () => {
    // Observed live (P20 pilot): long task expansions ended "}}" where "}" closed the document.
    expect(parsePromptJson('{"task":{"id":"TASK-1","notes":["a } in text"]},"estimatedTurns":6}}')).toEqual({ task: { id: "TASK-1", notes: ["a } in text"] }, estimatedTurns: 6 });
    expect(parsePromptJson('[{"a":1}]]\n')).toEqual([{ a: 1 }]);
    expect(parsePromptJson('<quotes>q</quotes>\n```json\n{"a":{"b":1}}}\n```')).toEqual({ a: { b: 1 } });
    expect(parsePromptJson('```json\n{"a":0,\n```\n\nI need to correct that output.\n\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    // Anything but brackets after the document is still refused, and so is a document cut short.
    expect(() => parsePromptJson('{"a":1}},"b":2}')).toThrow("MODEL_ACTIVITY_INVALID_JSON");
    expect(() => parsePromptJson('{"a":1}} done')).toThrow("MODEL_ACTIVITY_INVALID_JSON");
    expect(() => parsePromptJson('{"a":{"b":1}')).toThrow("MODEL_ACTIVITY_INVALID_JSON");
    expect(() => parsePromptJson('{"a":1,}}')).toThrow("MODEL_ACTIVITY_INVALID_JSON");
  });
});
