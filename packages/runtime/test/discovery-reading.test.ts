import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bundledProtocolControlPlane } from "@arbitra/protocols/bundled.js";
import { ProtocolRegistry } from "@arbitra/protocols/registry.js";
import { runConfigSchema } from "@arbitra/schemas/config.js";
import type { HttpClient, HttpRequest } from "@arbitra/providers/transport-contract.js";
import { ModelActivities, type ModelActivityRequest } from "../src/model-activities.js";
import { discoverWithModel } from "../src/model-discovery.js";
import { ModelHarness } from "../src/model-harness.js";
import { RunStore } from "../src/run-store.js";

/*
 * What a finder reads and how it asks for it, against a fake HTTP provider; no model is called. A run pinned to
 * production-audit 2.0.0 keeps the requests it made, or its resume and a replay of it would be refused.
 */

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function fileOf(path: string, lines: readonly string[]) {
  return { path, lines: [...lines], lineStartBytes: lines.map((_, index) => lines.slice(0, index).reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0)), byteLength: Buffer.byteLength(lines.join("\n")) };
}
const CLIENT = ["export async function deleteRoom(roomId: string): Promise<Response> {", "  return fetch(`/api/rooms/${roomId}`, { method: \"DELETE\" });", "}"];
const SERVER = ["export function deleteRoomHandler(request: Request): Response {", "  if (request.headers.get(\"x-operator-token\") !== process.env.OPERATOR_TOKEN) return new Response(null, { status: 403 });", "  return new Response(null, { status: 204 });", "}"];
const repository = { root: "fixture", files: [fileOf("client/api.ts", CLIENT), fileOf("server/rooms.ts", SERVER)] };

type Body = Record<string, unknown>;
interface Call { readonly paths: readonly string[]; readonly namespace: string; readonly toolOutputs: readonly string[]; readonly input: readonly { role?: string; content?: string }[]; readonly turn: number }
const answer = (findings: readonly unknown[] = []): Body => ({ output_text: JSON.stringify({ findings, truncated: false, unexaminedDueToBudget: [], limitations: [] }) });
const calling = (...calls: readonly { name: string; arguments: unknown }[]): Body => ({ output: calls.map((call, index) => ({ type: "function_call", call_id: `call-${index}`, name: call.name, arguments: JSON.stringify(call.arguments) })) });

async function harness(reply: (call: Call) => Body, depthLabel?: string) {
  const root = await mkdtemp(join(tmpdir(), "arbitra-discovery-reading-")); directories.push(root);
  const example = runConfigSchema.parse(JSON.parse(await readFile(new URL("../../../examples/audit-balanced.json", import.meta.url), "utf8")));
  const profile = example.models["auditor-a"];
  if (profile === undefined) throw new Error("FIXTURE_PROFILE_ABSENT");
  const config = runConfigSchema.parse({ ...example, ...(depthLabel === undefined ? {} : { auditDepth: depthLabel }), models: { "auditor-a": profile }, workflow: { modelExecution: {
    endpoints: [{ id: "primary", providerId: "openai", transport: "openai-responses", endpoint: "https://fixture.example/v1", apiKeyEnvVar: "FIXTURE_KEY" }],
    modelEndpoints: { "auditor-a": "primary" }, maximumOutputTokens: 500, maximumTokens: 1_000_000, timeoutMs: 1_000, maximumRetries: 0, maximumOutputRepairs: 0,
    rateLimits: { openai: { rpm: 1_000, tpm: 10_000_000, maxConcurrent: 4 } },
  } } });
  const store = new RunStore(root, "run-1");
  const requests: HttpRequest[] = [];
  const send = vi.fn<HttpClient["send"]>(async (request) => {
    requests.push(request);
    const input = (request.body as { input: { role?: string; content?: string; type?: string; output?: string }[] }).input;
    const text = input.map(({ content }) => content ?? "").join("\n");
    const namespace = /Every sourceFindingId must start with (\S+?)\/ and be unique/u.exec(text)?.[1] ?? "";
    const toolOutputs = input.filter(({ type }) => type === "function_call_output").map(({ output }) => output ?? "");
    const paths = repository.files.map(({ path }) => path).filter((path) => text.includes(`\\"path\\":\\"${path}\\"`) || text.includes(`"path":"${path}"`));
    return { status: 200, headers: {}, body: { usage: { input_tokens: 10, output_tokens: 10 }, ...reply({ paths, namespace, toolOutputs, input, turn: input.filter(({ type }) => (type as string | undefined) === "function_call").length }) } };
  });
  const model = new ModelHarness(new ModelActivities(store, config, { client: { send }, credential: () => "fixture-credential" }), config, repository, store);
  return { root, store, requests, model, config };
}

/** One file a unit: each unit counts 10,000 tokens a file against a budget of 15,000. */
const perFile = (model: ModelHarness) => ({ invoke: <T>(request: ModelActivityRequest<T>) => model.invoke(request), readsBeyondSource: (activityId: string) => model.readsBeyondSource(activityId),
  estimateInitialTokens: (request: ModelActivityRequest<unknown>) => { const user = request.messages.find(({ role }) => role === "user")?.content ?? "{}"; return 10_000 * ((JSON.parse(user) as { files?: unknown[] }).files?.length ?? 0); } });

const protocolAt = (version: string) => new ProtocolRegistry(bundledProtocolControlPlane()).resolve("production-audit", version);

describe("a run pinned to production-audit 2.0.0", () => {
  it("sends byte for byte the requests it sent, and keeps every activity's identity", async () => {
    const { store, requests, model } = await harness(({ toolOutputs }) => toolOutputs.length === 0 ? calling({ name: "repo_read_file", arguments: { path: "server/rooms.ts" } }, { name: "repo_search", arguments: { query: "deleteRoom" } }) : answer());
    await discoverWithModel({ auditorId: "auditor-a", modelProfileId: "auditor-a", snapshot: repository, activities: perFile(model), store, signal: new AbortController().signal, maximumInputTokens: 15_000, protocol: await protocolAt("2.0.0") });
    const artifacts = await store.listArtifacts();
    const identities = await Promise.all(artifacts.filter(({ kind }) => /^model-activity-[0-9a-f]{64}$/u.test(kind)).map(async ({ kind, artifactId }) => {
      const { fingerprint, replayIdentity } = JSON.parse((await store.readArtifact(artifactId)).content) as { fingerprint: string; replayIdentity: string };
      return [kind, fingerprint, replayIdentity];
    }));
    const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    // Computed on the build before the reading tools (4a55818). When a change makes these differ, a run pinned to 2.0.0
    // can no longer resume or be replayed: put the change behind DISCOVERY_READS_BY_NAME_FROM instead of updating them.
    expect(digest(requests.map(({ body }) => body))).toBe("1da4cb5890c2cecb2096e8453943e6d6f9bd1de46e1eb593b2bc38c735bb715a");
    expect(digest(identities.sort((a, b) => String(a[0]).localeCompare(String(b[0]))))).toBe("51f4cdff103218de25d0879a3ba6569fe5dbf891b20be2283ce6d23d69b4ac6a");
  });
});
