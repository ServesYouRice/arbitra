import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runConfigSchema } from "@arbitra/schemas/config.js";
import type { HttpClient, HttpRequest, TransportMessage } from "@arbitra/providers/transport-contract.js";
import { ModelActivities } from "../src/model-activities.js";
import { discoverWithModel } from "../src/model-discovery.js";
import { isModelOutputRejection, ModelHarness } from "../src/model-harness.js";
import { RunStore } from "../src/run-store.js";
import { snapshotTools } from "../src/snapshot-tools.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const snapshot = { root: "fixture", files: [{ path: "a.ts", lines: ["const value = null;"], lineStartBytes: [0], byteLength: 19 }] };
async function setup(maxToolTurns = 2, historySize = 0, maximumOutputRepairs = 0, source = snapshot) {
  const root = await mkdtemp(join(tmpdir(), "arbitra-harness-")); directories.push(root);
  const example = runConfigSchema.parse(JSON.parse(await readFile(new URL("../../../examples/audit-balanced.json", import.meta.url), "utf8")));
  const profile = example.models["auditor-a"];
  if (profile === undefined) throw new Error("FIXTURE_PROFILE_ABSENT");
  const config = runConfigSchema.parse({ ...example, models: { "auditor-a": { ...profile, quirks: { ...profile.quirks, toolLoopLimit: maxToolTurns } } }, workflow: { modelExecution: {
    endpoints: [{ id: "primary", providerId: "openai", transport: "openai-responses", endpoint: "https://fixture.example/v1", apiKeyEnvVar: "FIXTURE_KEY" }],
    modelEndpoints: { "auditor-a": "primary" }, maximumOutputTokens: 500, maximumTokens: 100_000, timeoutMs: 1_000, maximumRetries: 0, maximumOutputRepairs,
    ...(historySize === 0 ? {} : { maximumContextTokens: 4_000 }),
    rateLimits: { openai: { rpm: 100, tpm: 100_000, maxConcurrent: 4 } },
  } } });
  const store = new RunStore(root, "run-1");
  const requests: HttpRequest[] = [];
  const send = vi.fn<HttpClient["send"]>(async (request) => {
    requests.push(request);
    return { status: 200, headers: {}, body: requests.length === 1
      ? { output_text: "x".repeat(historySize), output: [{ type: "function_call", call_id: "call-1", name: "repo_read_file", arguments: '{"path":"a.ts"}' }], usage: { input_tokens: 10, output_tokens: 10 } }
      : { output_text: '{"answer":"ok"}', usage: { input_tokens: 20, output_tokens: 10 } } };
  });
  const create = () => new ModelHarness(new ModelActivities(store, config, { client: { send }, credential: () => "fixture-credential" }), config, source, store);
  return { store, create, send, requests, config };
}
const request = () => ({ activityId: "auditor-a/discovery", modelProfileId: "auditor-a", protocol: "fixture@1", signal: new AbortController().signal,
  messages: [{ role: "system" as const, content: "Inspect the snapshot." }, { role: "user" as const, content: "Return JSON." }],
  schema: { parse(value: unknown) { if (typeof value !== "object" || value === null || !("answer" in value) || typeof value.answer !== "string") throw new Error("INVALID_ANSWER"); return { answer: value.answer }; } },
});

describe("durable canonical model harness", () => {
  it("asks each model for its own output ceiling, not the run's when the model writes less", async () => {
    // Observed (P20 pilot): one ceiling for every model, held at the smallest model's limit, stopped a plan of 52 issues.
    const { store, send, requests, config } = await setup(0);
    const profile = config.models["auditor-a"]; if (profile === undefined) throw new Error("FIXTURE_PROFILE_ABSENT");
    const smaller = { ...config, models: { "auditor-a": { ...profile, limits: { ...profile.limits, maxOutputTokens: 300 } } } };
    send.mockImplementation(async (value) => { requests.push(value); return { status: 200, headers: {}, body: { output_text: '{"answer":"ok"}', usage: { input_tokens: 10, output_tokens: 10 } } }; });
    const harness = new ModelHarness(new ModelActivities(store, smaller, { client: { send }, credential: () => "fixture-credential" }), smaller, snapshot, store);
    expect(await harness.invoke({ ...request(), activityId: "auditor-a/review" })).toEqual({ answer: "ok" });
    expect((requests[0]?.body as { max_output_tokens: number }).max_output_tokens).toBe(300);
    expect(harness.estimateInitialTokens({ ...request(), activityId: "auditor-a/other" }) - new ModelHarness(new ModelActivities(store, config, { client: { send }, credential: () => "fixture-credential" }), config, snapshot, store).estimateInitialTokens({ ...request(), activityId: "auditor-a/other" })).toBe(300 - 500);
  });

  it("re-asks once after a reply fails validation, durably, and fails with the original error when repairs are exhausted", async () => {
    const replies = ['<quotes>q</quotes>\nThe answer follows.', '{"answer":"repaired"}'];
    const review = () => ({ ...request(), activityId: "auditor-a/review" });
    for (const [repairs, expected] of [[1, { answer: "repaired" }], [0, "MODEL_ACTIVITY_INVALID_JSON"]] as const) {
      const { create, send, requests } = await setup(2, 0, repairs);
      let index = 0;
      send.mockImplementation(async (value) => { requests.push(value); const text = replies[Math.min(index, replies.length - 1)]; index += 1; return { status: 200, headers: {}, body: { output_text: text, usage: { input_tokens: 10, output_tokens: 10 } } }; });
      if (typeof expected === "string") { await expect(create().invoke(review())).rejects.toThrow(expected); expect(requests).toHaveLength(1); continue; }
      expect(await create().invoke(review())).toEqual(expected);
      expect(requests).toHaveLength(2);
      const feedback = JSON.stringify(requests[1]?.body);
      expect(feedback).toContain("outputRejected"); expect(feedback).toContain("MODEL_ACTIVITY_INVALID_JSON"); expect(feedback).toContain("The answer follows.");
      // The repair's provenance is trusted instruction; the model-derived feedback is not.
      const input = (requests[1]?.body as { input: { role: string; content: string }[] }).input;
      expect(input.filter(({ role }) => role === "system").map(({ content }) => content).join("\n")).toMatch(/^Inspect the snapshot\.\nOutput repair: .*not a prompt injection/u);
      expect(input.filter(({ role }) => role === "system").some(({ content }) => content.includes("outputRejected\":"))).toBe(false);
      // A restarted harness replays both durable activities without new spend.
      expect(await create().invoke(review())).toEqual(expected);
      expect(requests).toHaveLength(2);
    }
  });


  it("has a request with a refit compose its output repair again, under the repair's own activity", async () => {
    // A stage that carries optional source up to its limit sends its repair with less of it.
    const { create, send, requests } = await setup(2, 0, 1);
    let index = 0;
    send.mockImplementation(async (value) => { requests.push(value); index += 1; return { status: 200, headers: {}, body: { output_text: index === 1 ? "No JSON here." : '{"answer":"repaired"}', usage: { input_tokens: 10, output_tokens: 10 } } }; });
    const refits: { appended: readonly { role: string; content: string }[]; activityId: string }[] = [];
    const review = { ...request(), activityId: "auditor-a/review", refit: async (appended: readonly TransportMessage[], activityId: string) => {
      refits.push({ appended, activityId });
      return { messages: [{ role: "system" as const, content: "Inspect the snapshot." }, { role: "user" as const, content: "Return JSON from less source." }, ...appended], admittedAsRequired: false };
    } };
    expect(await create().invoke(review)).toEqual({ answer: "repaired" });
    expect(refits.map(({ activityId }) => activityId)).toEqual(["auditor-a/review/repair-1"]);
    expect(refits[0]?.appended.map(({ role }) => role)).toEqual(["system", "user"]);
    const repaired = JSON.stringify(requests[1]?.body);
    expect(repaired).toContain("Return JSON from less source."); expect(repaired).toContain("outputRejected"); expect(repaired).toContain("No JSON here.");
    expect(repaired).not.toContain("Return JSON.");
    // A restarted harness composes the same repair and replays both durable activities without new spend.
    expect(await create().invoke(review)).toEqual({ answer: "repaired" });
    expect(requests).toHaveLength(2);
  });

  it("traces an output repair, and the failed tool calls whose results a turn reads", async () => {
    // Every trace said no repairs and no tool errors, so metrics and the trace view showed none.
    const terminals = async (store: Awaited<ReturnType<typeof setup>>["store"]) => {
      const traces = new Map<string, { repairCount: number; toolCallErrors: number; toolCallCount: number }>();
      for (const { kind, artifactId } of await store.listArtifacts()) {
        if (!kind.endsWith("-trace")) continue;
        const { activityId, terminal } = JSON.parse((await store.readArtifact(artifactId)).content) as { activityId: string; terminal: { repairCount: number; toolCallErrors: number; toolCallCount: number } };
        traces.set(activityId, terminal);
      }
      return traces;
    };
    const repaired = await setup(2, 0, 1); let index = 0;
    repaired.send.mockImplementation(async () => { index += 1; return { status: 200, headers: {}, body: { output_text: index === 1 ? "No JSON here." : '{"answer":"repaired"}', usage: { input_tokens: 10, output_tokens: 10 } } }; });
    expect(await repaired.create().invoke({ ...request(), activityId: "auditor-a/review" })).toEqual({ answer: "repaired" });
    const repairTraces = await terminals(repaired.store);
    expect(repairTraces.get("auditor-a/review/turn-0")?.repairCount).toBe(0);
    expect(repairTraces.get("auditor-a/review/repair-1/turn-0")?.repairCount).toBe(1);
    // The first turn reads a path outside its scope; the second turn reads that failure.
    const scoped = await setup();
    expect(await scoped.create().invoke({ ...request(), sourcePaths: [] })).toEqual({ answer: "ok" });
    const toolTraces = await terminals(scoped.store);
    expect(toolTraces.get("auditor-a/discovery/turn-0")).toMatchObject({ toolCallCount: 1, toolCallErrors: 0, repairCount: 0 });
    expect(toolTraces.get("auditor-a/discovery/turn-1")).toMatchObject({ toolCallCount: 0, toolCallErrors: 1, repairCount: 0 });
  });

  it("records a provider's refusal durably, with no repair and no second call after restart", async () => {
    // Observed live (P20 pilot): Gemini's content filter answered one discovery unit three times; read as a reply, it was repaired as invalid JSON until the run failed.
    const { store, config } = await setup(2, 0, 2);
    let calls = 0;
    const refusing = { invoke: async () => { calls += 1; return { text: null, toolCalls: [], refusal: "This request was blocked.", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null } }; } } as unknown as ModelActivities;
    const create = () => new ModelHarness(refusing, config, snapshot, store);
    await expect(create().invoke(request())).rejects.toMatchObject({ name: "ModelRefusalError", activityId: "auditor-a/discovery", refusal: "This request was blocked." });
    expect(calls).toBe(1);
    const restarted = create();
    expect(await restarted.refused("auditor-a/discovery")).toBe(true);
    await expect(restarted.invoke(request())).rejects.toThrow("MODEL_ACTIVITY_REFUSED:auditor-a/discovery");
    expect(calls).toBe(1);
  });

  it("records output-ceiling truncation durably and never repeats that spend after restart", async () => {
    const { create, send, store } = await setup();
    send.mockImplementation(async () => ({ status: 200, headers: {}, body: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output_text: '{"answer":', usage: { input_tokens: 10, output_tokens: 500 } } }));
    await expect(create().invoke(request())).rejects.toMatchObject({ name: "ModelOutputLimitError", activityId: "auditor-a/discovery", message: "MODEL_OUTPUT_LIMIT_REACHED:auditor-a/discovery" });
    expect(send).toHaveBeenCalledTimes(1);
    const restarted = create();
    expect(await restarted.outputLimited("auditor-a/discovery")).toBe(true);
    await expect(restarted.invoke(request())).rejects.toThrow("MODEL_OUTPUT_LIMIT_REACHED:auditor-a/discovery");
    expect(send).toHaveBeenCalledTimes(1);
    const marker = (await store.listArtifacts()).find(({ kind }) => kind.startsWith("model-output-limit-"));
    expect(JSON.parse((await store.readArtifact(marker?.artifactId ?? "")).content)).toMatchObject({ activityId: "auditor-a/discovery", turnActivityId: "auditor-a/discovery/turn-0", maximumOutputTokens: 500 });
  });

  it("finishes discovery on smaller scopes when the one-call audit stops at the output ceiling, with no repeated spend after restart", async () => {
    // Observed live (P20 pilot): the run failed at this call, and every resume failed again without a new call.
    const source = { root: "fixture", files: ["a.ts", "b.ts"].map((path) => ({ path, lines: ["const value = null;"], lineStartBytes: [0], byteLength: 19 })) };
    const { create, send, store } = await setup(2, 0, 0, source);
    const supplied: string[][] = [];
    send.mockImplementation(async (value) => {
      const user = (value.body as { input: { role: string; content: string }[] }).input.filter(({ role }) => role === "user").map(({ content }) => content).join("\n");
      const paths = source.files.map(({ path }) => path).filter((path) => user.includes(path));
      supplied.push(paths);
      return { status: 200, headers: {}, body: paths.length > 1
        ? { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output_text: '{"findings":', usage: { input_tokens: 10, output_tokens: 500 } }
        : { output_text: JSON.stringify({ findings: [], truncated: false, unexaminedDueToBudget: [], limitations: [] }), usage: { input_tokens: 10, output_tokens: 10 } } };
    });
    const run = () => discoverWithModel({ auditorId: "auditor-a", modelProfileId: "auditor-a", snapshot: source, activities: create(), store, signal: new AbortController().signal });
    expect(await run()).toEqual([]);
    expect(supplied).toEqual([["a.ts", "b.ts"], ["a.ts"], ["b.ts"]]);
    const scopes = (await store.listArtifacts()).find(({ kind }) => kind === "discovery-scopes-auditor-a");
    expect(JSON.parse((await store.readArtifact(scopes?.artifactId ?? "")).content)).toMatchObject({ scopes: [{ paths: ["a.ts"] }, { paths: ["b.ts"] }], outputLimitSplits: [{ scopeId: "whole" }] });
    expect(await run()).toEqual([]);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("marks the activity when its repair stops at the output ceiling, so no restart repeats the rejected reply's repair", async () => {
    // Observed live (P20 pilot): only the repair was marked; every resume replayed the rejected reply and failed at the same repair.
    const { create, send } = await setup(2, 0, 1);
    const replies = [{ output_text: "not json", usage: { input_tokens: 10, output_tokens: 10 } }, { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output_text: '{"answer":', usage: { input_tokens: 10, output_tokens: 500 } }];
    let index = 0;
    send.mockImplementation(async () => ({ status: 200, headers: {}, body: replies[Math.min(index++, replies.length - 1)] }));
    const review = () => ({ ...request(), activityId: "peer-review/1/auditor-a" });
    await expect(create().invoke(review())).rejects.toMatchObject({ name: "ModelOutputLimitError", activityId: "peer-review/1/auditor-a" });
    expect(send).toHaveBeenCalledTimes(2);
    const restarted = create();
    expect(await restarted.outputLimited("peer-review/1/auditor-a")).toBe(true);
    expect(await restarted.outputLimited("peer-review/1/auditor-a/repair-1")).toBe(true);
    await expect(restarted.invoke(review())).rejects.toThrow("MODEL_OUTPUT_LIMIT_REACHED:peer-review/1/auditor-a");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("archives overflowing tool history and reuses the same bounded turns after restart", async () => {
    const { create, requests, store } = await setup(2, 3_000);
    expect(await create().invoke(request())).toEqual({ answer: "ok" });
    expect(await create().invoke(request())).toEqual({ answer: "ok" });
    expect(requests).toHaveLength(2);
    const wire = JSON.stringify(requests[1]?.body);
    expect(wire).toContain("archivedToolMessages");
    expect(wire).not.toContain("x".repeat(3_000));
    expect((await store.listArtifacts()).some(({ kind }) => kind.startsWith("model-history-"))).toBe(true);
  });

  it("restricts scoped tool reads and binds the source scope to durable identity", async () => {
    const { create, requests } = await setup();
    const input = { ...request(), sourcePaths: [] };
    expect(await create().invoke(input)).toEqual({ answer: "ok" });
    const wire = JSON.stringify(requests[1]?.body);
    // The file exists outside the call's scope, and the refusal says so rather than that it is missing.
    expect(wire).toContain("PATH_OUTSIDE_THIS_CALL");
    expect(wire).not.toContain("const value = null;");
    await expect(create().invoke({ ...input, sourcePaths: ["a.ts"] })).rejects.toThrow("MODEL_ACTIVITY_INPUT_CHANGED");
    expect(requests).toHaveLength(2);
  });

  it("reads the immutable snapshot, preserves tool metadata, and reuses every model turn after restart", async () => {
    const { create, requests, store } = await setup();
    expect(await create().invoke(request())).toEqual({ answer: "ok" });
    expect(await create().invoke(request())).toEqual({ answer: "ok" });
    expect(requests).toHaveLength(2);
    const wire = JSON.stringify(requests[1]?.body);
    expect(wire).toContain("const value = null;");
    expect(wire).toContain("function_call_output");
    const input = (requests[1]?.body as { input: { type?: string; output?: string }[] }).input;
    const tool = JSON.parse(input.find(({ type }) => type === "function_call_output")?.output ?? "null") as { ok: boolean; content: string; artifact: null };
    expect(tool).toMatchObject({ ok: true, artifact: null }); expect(tool.content).toContain('trust="untrusted"');
    const artifact = (await store.listArtifacts()).find(({ kind }) => kind.startsWith("harness-"));
    if (artifact === undefined) throw new Error("HARNESS_ARTIFACT_ABSENT");
    const log = JSON.parse((await store.readArtifact(artifact.artifactId)).content) as { inspection: { reads: unknown[] }; events: { type: string }[] };
    expect(log.inspection.reads).toHaveLength(1); expect(log.events.at(-1)?.type).toBe("completed");
  });

  it("preserves the turn bound: a tool call after the last tool turn is not run, and the model is asked to answer", async () => {
    const { create, send, requests, store } = await setup(0);
    const harness = create();
    expect(await harness.invoke(request())).toEqual({ answer: "ok" });
    expect(send).toHaveBeenCalledTimes(2);
    const input = (requests[1]?.body as { input: { type?: string; output?: string }[] }).input;
    expect(JSON.parse(input.find(({ type }) => type === "function_call_output")?.output ?? "null")).toMatchObject({ ok: false, error: { code: "TOOL_TURN_LIMIT_REACHED" } });
    expect(harness.toolTurnsSpent("auditor-a/discovery")).toBe(true);
    const artifact = (await store.listArtifacts()).find(({ kind }) => kind.startsWith("harness-"));
    if (artifact === undefined) throw new Error("HARNESS_ARTIFACT_ABSENT");
    expect((JSON.parse((await store.readArtifact(artifact.artifactId)).content) as { inspection: { reads: unknown[] } }).inspection.reads).toHaveLength(0);
  });

  it("fails a model that asks for tools again after it was told none remain as a rejected reply, without a repair", async () => {
    // A stage that can go on without this one answer records a gap; observed live (commentanywhere, October 23), the run failed.
    const { create, send, requests } = await setup(0, 0, 1);
    send.mockImplementation(async (value) => { requests.push(value); return { status: 200, headers: {}, body: { output: [{ type: "function_call", call_id: `call-${requests.length}`, name: "repo_read_file", arguments: '{"path":"a.ts"}' }], usage: { input_tokens: 10, output_tokens: 10 } } }; });
    const error = await create().invoke(request()).then(() => null, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("HARNESS_TOOL_LOOP_LIMIT:0");
    expect(isModelOutputRejection(error)).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("restricts reads to the snapshot and artifact context and blocks undeclared tools", async () => {
    const { store } = await setup();
    const peer = await store.publish("findings-peer", { findings: ["private peer reasoning"] });
    const { runtime } = snapshotTools(snapshot, store, "auditor-a/discovery");
    const context = { nodeId: "auditor-a/discovery", protect: (content: string) => content };
    expect(await runtime.invoke("artifact_read", { ref: peer.artifactId }, context)).toMatchObject({ ok: false, error: { code: "ARTIFACT_OUTSIDE_ACTIVITY_CONTEXT" } });
    expect(await runtime.invoke("repo_read_file", { path: "../outside.ts" }, context)).toMatchObject({ ok: false, error: { code: "PATH_NOT_IN_SNAPSHOT" } });
    const unit = snapshotTools({ ...snapshot, files: [] }, store, "auditor-a/discovery", undefined, new Set(["a.ts"]));
    expect(await unit.runtime.invoke("repo_read_file", { path: "a.ts" }, context)).toMatchObject({ ok: false, error: { code: "PATH_OUTSIDE_THIS_CALL" } });
    expect(await unit.runtime.invoke("repo_read_file", { path: "b.ts" }, context)).toMatchObject({ ok: false, error: { code: "PATH_NOT_IN_SNAPSHOT" } });
    expect(await runtime.invoke("shell", { command: "ignored" }, context)).toMatchObject({ ok: false, error: { code: "TOOL_NOT_ALLOWED" } });
    const scoped = snapshotTools(snapshot, store, "scoped-history");
    const ref = await scoped.archive("Earlier tool result");
    expect(await scoped.runtime.invoke("artifact_read", { ref }, { ...context, nodeId: "scoped-history" })).toMatchObject({ ok: true, content: expect.stringContaining("Earlier tool result") });
    expect(await runtime.invoke("artifact_read", { ref }, context)).toMatchObject({ ok: false, error: { code: "ARTIFACT_OUTSIDE_ACTIVITY_CONTEXT" } });
  });
});
