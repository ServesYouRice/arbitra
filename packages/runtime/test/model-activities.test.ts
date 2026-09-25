import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runConfigSchema } from "@arbitra/schemas/config.js";
import type { HttpClient } from "@arbitra/providers/transport-contract.js";
import { ModelActivities, parsePromptJson } from "../src/model-activities.js";
import { RunStore } from "../src/run-store.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture(maximumTokens = 10_000) {
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
      maximumRetries: 0, timeoutMs: 1_000, rateLimits: { [model.provider]: { rpm: 100, tpm: 100_000, maxConcurrent: 4 } },
    },
  } });
  const store = new RunStore(root, "run-1");
  const send = vi.fn<HttpClient["send"]>(async () => ({ status: 200, headers: {}, body: {
    id: "response-1", output_text: '{"answer":"ok"}', usage: { input_tokens: 2, output_tokens: 3 },
  } }));
  const create = () => new ModelActivities(store, config, { client: { send }, credential: () => "fixture-credential" });
  return { store, send, create };
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

  it("keeps failed attempts charged across restart and binds their original input", async () => {
    const { create, send } = await fixture(100);
    send.mockResolvedValue({ status: 500, headers: {}, body: {} });
    await expect(create().invoke(request())).rejects.toThrow("Provider openai failed");
    await expect(create().invoke({ ...request(), protocol: "changed" })).rejects.toThrow("MODEL_ACTIVITY_INPUT_CHANGED");
    await expect(create().invoke(request())).rejects.toMatchObject({ state: "SUSPENDED_BUDGET" });
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
});
