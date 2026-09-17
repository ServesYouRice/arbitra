import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runConfigSchema } from "@arbitra/schemas/config.js";
import type { HttpClient, HttpRequest } from "@arbitra/providers/transport-contract.js";
import { ModelActivities } from "../src/model-activities.js";
import { ModelHarness } from "../src/model-harness.js";
import { RunStore } from "../src/run-store.js";
import { snapshotTools } from "../src/snapshot-tools.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const snapshot = { root: "fixture", files: [{ path: "a.ts", lines: ["const value = null;"], lineStartBytes: [0], byteLength: 19 }] };
async function setup(maxToolTurns = 2) {
  const root = await mkdtemp(join(tmpdir(), "arbitra-harness-")); directories.push(root);
  const example = runConfigSchema.parse(JSON.parse(await readFile(new URL("../../../examples/audit-balanced.json", import.meta.url), "utf8")));
  const profile = example.models["auditor-a"];
  if (profile === undefined) throw new Error("FIXTURE_PROFILE_ABSENT");
  const config = runConfigSchema.parse({ ...example, models: { "auditor-a": { ...profile, quirks: { ...profile.quirks, toolLoopLimit: maxToolTurns } } }, workflow: { modelExecution: {
    endpoints: [{ id: "primary", providerId: "openai", transport: "openai-responses", endpoint: "https://fixture.example/v1", apiKeyEnvVar: "FIXTURE_KEY" }],
    modelEndpoints: { "auditor-a": "primary" }, maximumOutputTokens: 500, maximumTokens: 100_000, timeoutMs: 1_000, maximumRetries: 0,
    rateLimits: { openai: { rpm: 100, tpm: 100_000, maxConcurrent: 4 } },
  } } });
  const store = new RunStore(root, "run-1");
  const requests: HttpRequest[] = [];
  const send = vi.fn<HttpClient["send"]>(async (request) => {
    requests.push(request);
    return { status: 200, headers: {}, body: requests.length === 1
      ? { output: [{ type: "function_call", call_id: "call-1", name: "repo_read_file", arguments: '{"path":"a.ts"}' }], usage: { input_tokens: 10, output_tokens: 10 } }
      : { output_text: '{"answer":"ok"}', usage: { input_tokens: 20, output_tokens: 10 } } };
  });
  const create = () => new ModelHarness(new ModelActivities(store, config, { client: { send }, credential: () => "fixture-credential" }), config, snapshot, store);
  return { store, create, send, requests };
}
const request = () => ({ activityId: "auditor-a/discovery", modelProfileId: "auditor-a", protocol: "fixture@1", signal: new AbortController().signal,
  messages: [{ role: "system" as const, content: "Inspect the snapshot." }, { role: "user" as const, content: "Return JSON." }],
  schema: { parse(value: unknown) { if (typeof value !== "object" || value === null || !("answer" in value) || typeof value.answer !== "string") throw new Error("INVALID_ANSWER"); return { answer: value.answer }; } },
});

describe("durable canonical model harness", () => {
  it("restricts scoped tool reads and binds the source scope to durable identity", async () => {
    const { create, requests } = await setup();
    const input = { ...request(), sourcePaths: [] };
    expect(await create().invoke(input)).toEqual({ answer: "ok" });
    const wire = JSON.stringify(requests[1]?.body);
    expect(wire).toContain("PATH_NOT_IN_SNAPSHOT");
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

  it("preserves the turn bound and refuses to execute tools after its last model turn", async () => {
    const { create, send } = await setup(0);
    await expect(create().invoke(request())).rejects.toThrow("HARNESS_TOOL_LOOP_LIMIT:0");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("restricts reads to the snapshot and artifact context and blocks undeclared tools", async () => {
    const { store } = await setup();
    const peer = await store.publish("findings-peer", { findings: ["private peer reasoning"] });
    const { runtime } = snapshotTools(snapshot, store, "auditor-a/discovery");
    const context = { nodeId: "auditor-a/discovery", protect: (content: string) => content };
    expect(await runtime.invoke("artifact_read", { ref: peer.artifactId }, context)).toMatchObject({ ok: false, error: { code: "ARTIFACT_OUTSIDE_ACTIVITY_CONTEXT" } });
    expect(await runtime.invoke("repo_read_file", { path: "../outside.ts" }, context)).toMatchObject({ ok: false, error: { code: "PATH_NOT_IN_SNAPSHOT" } });
    expect(await runtime.invoke("shell", { command: "ignored" }, context)).toMatchObject({ ok: false, error: { code: "TOOL_NOT_ALLOWED" } });
  });
});
