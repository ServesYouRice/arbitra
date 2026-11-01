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
import { frameUntrusted } from "@arbitra/security/framing";
import { redactSecrets } from "@arbitra/security/redaction";
import { RunStore } from "../src/run-store.js";
import { READING_TOOLS, SNAPSHOT_TOOLS, snapshotTools } from "../src/snapshot-tools.js";

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

  it("is offered no symbol lookup and no count of turns, and a lookup asked for anyway is refused", async () => {
    const { store, requests, model } = await harness(({ toolOutputs }) => toolOutputs.length === 0 ? calling({ name: "repo_symbol", arguments: { names: ["deleteRoom"] } }) : answer());
    await discoverWithModel({ auditorId: "auditor-a", modelProfileId: "auditor-a", snapshot: repository, activities: perFile(model), store, signal: new AbortController().signal, maximumInputTokens: 15_000, protocol: await protocolAt("2.0.0"), depth: "cheap" });
    const body = requests.at(-1)?.body as { input: { type?: string; output?: string }[]; tools: { name: string }[] };
    expect(body.tools.map(({ name }) => name)).not.toContain("repo_symbol");
    const output = body.input.find(({ type }) => type === "function_call_output")?.output ?? "";
    expect(output).toContain("TOOL_NOT_ALLOWED");
    expect(output).not.toContain("toolTurnsLeft");
  });
});

const OWN = { auditorId: "auditor-a", modelProfileId: "auditor-a", snapshot: repository, signal: new AbortController().signal, maximumInputTokens: 15_000 };
const outputsOf = (request: HttpRequest | undefined) => (request?.body as { input: { type?: string; output?: string }[] }).input.filter(({ type }) => type === "function_call_output").map(({ output }) => output ?? "");
const firstCallsOf = (requests: readonly HttpRequest[]) => requests.map(({ body }) => (body as { input: { role?: string; content?: string; type?: string }[] }).input).filter((input) => !input.some(({ type }) => type === "function_call_output"));
const finding = (namespace: string, path: string, line: number, text: string) => ({ schemaVersion: 1, sourceFindingId: `${namespace}/token`, category: "CORRECTNESS", title: "The client never sends the operator token", severity: "high", status: "needs_verification", confidence: 0.7, productionBlocker: false,
  locations: [{ id: "L1", path, startLine: line, endLine: line }], evidence: [{ id: "E1", text, locationIds: ["L1"] }], problem: "Every delete is refused", productionImpact: "Rooms cannot be deleted", trigger: "Delete a room", recommendedFix: "Send the token", verification: "Delete a room", dependencies: [], relatedRisks: [] });
async function artifact(store: RunStore, kind: string) {
  const descriptor = (await store.listArtifacts()).find((entry) => entry.kind === kind);
  if (descriptor === undefined) throw new Error(`ARTIFACT_ABSENT:${kind}`);
  return JSON.parse((await store.readArtifact(descriptor.artifactId)).content) as Record<string, unknown>;
}

describe("a run on production-audit 2.1.0", () => {
  it("starts every unit with a first layer of fixed text, and with one text through the repository index", async () => {
    const { store, requests, model } = await harness(() => answer());
    await discoverWithModel({ ...OWN, activities: perFile(model), store, protocol: await protocolAt("2.1.0") });
    const [left, right] = firstCallsOf(requests);
    const userOf = (input: typeof left) => input?.find(({ role }) => role === "user")?.content ?? "";
    const lockedOf = (input: typeof left) => userOf(input).split("\n")[0] ?? "";
    expect(lockedOf(left)).toBe(lockedOf(right));
    expect(lockedOf(left)).toContain("repo_symbol");
    expect(lockedOf(left)).toContain("Plan your reading before you ask");
    // Nothing of the repository, and nothing of one unit, is in the layer Claude Code takes as its system prompt.
    for (const text of ["deleteRoom", "client/api.ts", "server/rooms.ts", "scope-"]) expect(lockedOf(left)).not.toContain(text);
    let shared = 0; const [a, b] = [userOf(left), userOf(right)];
    while (shared < a.length && a[shared] === b[shared]) shared += 1;
    expect(a.indexOf("repositoryIndex")).toBeGreaterThanOrEqual(0);
    expect(shared).toBeGreaterThan(a.indexOf("rooms.ts 4: deleteRoomHandler"));
    expect(userOf(left)).toContain("toolTurnsLeft");
  });

  it("offers the lookup, answers several names in one turn, and a finding may cite what it delivered", async () => {
    const { store, requests, model } = await harness(({ namespace, toolOutputs, input }) => {
      const own = input.some(({ content }) => (content ?? "").includes("\\\"path\\\":\\\"client/api.ts\\\""));
      if (!own) return answer();
      if (toolOutputs.length === 0) return calling({ name: "repo_symbol", arguments: { names: ["deleteRoomHandler", "deleteRoom"] } });
      return answer([finding(namespace, "server/rooms.ts", 2, SERVER[1] ?? "")]);
    });
    const result = await discoverWithModel({ ...OWN, activities: { ...perFile(model), toolUse: (id: string) => model.toolUse(id) }, store, protocol: await protocolAt("2.1.0") });
    expect(result.map(({ locations }) => locations[0]?.path)).toEqual(["server/rooms.ts"]);
    expect((requests[0]?.body as { tools: { name: string }[] }).tools.map(({ name }) => name)).toEqual(["repo_list_tree", "repo_symbol", "repo_read_file", "repo_search", "repo_stat", "artifact_read"]);
    const delivered = requests.flatMap((request) => outputsOf(request)).join("\n");
    expect(delivered).toContain("definition server/rooms.ts:1-4");
    expect(delivered).toContain("x-operator-token");
    // Its own file it holds already: the lookup says where, and does not send it again.
    expect(delivered).toContain("client/api.ts:1-3 (in the source you were given)");
    const scopes = (await artifact(store, "discovery-scopes-auditor-a") as { scopes: { scopeId: string; paths: string[] }[] }).scopes;
    const scope = scopes.find(({ paths }) => paths[0] === "client/api.ts")?.scopeId ?? "";
    // What it delivered is charged and recorded like a read, and how the unit used its tools is recorded with it.
    expect(await artifact(store, `discovery-validation-auditor-a-${scope}`)).toMatchObject({ acceptedCount: 1,
      readBeyondUnit: { files: [{ path: "server/rooms.ts", lines: [[1, 4]] }], findingsCitingBeyondUnit: 1 },
      toolUse: { toolTurnLimit: 8, turns: 2, toolCalls: 1, byTool: { repo_symbol: 1 }, symbolNames: 2, askedPastLimit: false } });
    expect(await artifact(store, "discovery-validation-auditor-a")).toMatchObject({ toolUseOfUnits: { units: 2, turns: 3, toolCalls: 1, byTool: { repo_symbol: 1 }, symbolNames: 2, askedPastLimit: 0 } });
    // An incremental run compares the files a unit read: the lookup's are among them.
    const record = await artifact(store, `harness-${createHash("sha256").update(`auditor-a/${scope}/discovery`).digest("hex")}`) as { inspection: { reads: { path: string }[]; searches: { query: string }[] } };
    expect(record.inspection.reads.map(({ path }) => path)).toEqual(["server/rooms.ts"]);
    expect(record.inspection.searches.map(({ query }) => query)).toEqual(["symbol:deleteRoomHandler", "symbol:deleteRoom"]);
  });

  it("refuses a citation of another file's lines the lookup named but did not deliver", async () => {
    const { store, model } = await harness(({ namespace, toolOutputs, input }) => {
      const own = input.some(({ content }) => (content ?? "").includes("\\\"path\\\":\\\"client/api.ts\\\""));
      if (!own) return answer();
      if (toolOutputs.length === 0) return calling({ name: "repo_symbol", arguments: { names: ["status"] } });
      return answer([finding(namespace, "server/rooms.ts", 1, SERVER[0] ?? "")]);
    });
    expect(await discoverWithModel({ ...OWN, activities: perFile(model), store, protocol: await protocolAt("2.1.0") })).toEqual([]);
    const rejection = (await store.listArtifacts()).find(({ kind }) => kind.startsWith("discovery-rejection-auditor-a-"));
    expect(JSON.parse((await store.readArtifact(rejection?.artifactId ?? "")).content)).toMatchObject({ reasons: [{ code: "evidence_outside_exposure" }] });
  });

  it("gives a search its lines of context by default, and charges them like a read", async () => {
    const { store, requests, model } = await harness(({ toolOutputs, input }) => {
      const own = input.some(({ content }) => (content ?? "").includes("\\\"path\\\":\\\"client/api.ts\\\""));
      return own && toolOutputs.length === 0 ? calling({ name: "repo_search", arguments: { query: "x-operator-token" } }) : answer();
    });
    await discoverWithModel({ ...OWN, activities: perFile(model), store, protocol: await protocolAt("2.1.0") });
    const delivered = requests.flatMap((request) => outputsOf(request)).join("\n");
    expect(delivered).toContain("1- export function deleteRoomHandler");
    expect(delivered).toContain("2:   if (request.headers.get(");
    const scopes = (await artifact(store, "discovery-scopes-auditor-a") as { scopes: { scopeId: string; paths: string[] }[] }).scopes;
    const scope = scopes.find(({ paths }) => paths[0] === "client/api.ts")?.scopeId ?? "";
    expect(await artifact(store, `discovery-validation-auditor-a-${scope}`)).toMatchObject({ readBeyondUnit: { files: [{ path: "server/rooms.ts", lines: [[1, 4]] }] } });
  });

  it("says how many tool turns are left only at the end of a turn's last result, so what was sent stays as it was", async () => {
    const { store, requests, model } = await harness(({ toolOutputs }) => toolOutputs.length >= 4 ? answer() : calling({ name: "repo_stat", arguments: { path: "client/api.ts" } }, { name: "repo_stat", arguments: { path: "server/rooms.ts" } }));
    await discoverWithModel({ auditorId: "auditor-a", modelProfileId: "auditor-a", snapshot: { root: "fixture", files: [repository.files[0] as (typeof repository.files)[number]] }, activities: perFile(model), store, signal: new AbortController().signal, protocol: await protocolAt("2.1.0") });
    const [first, second, third] = requests.map(({ body }) => (body as { input: unknown[] }).input);
    expect(first).toBeDefined();
    const outputs = outputsOf(requests[2]).map((output) => JSON.parse(output) as { toolTurnsLeft?: number });
    expect(outputs.map(({ toolTurnsLeft }) => toolTurnsLeft)).toEqual([undefined, 7, undefined, 6]);
    expect(outputsOf(requests[2])[1]?.endsWith(",\"toolTurnsLeft\":7}")).toBe(true);
    expect(third?.slice(0, second?.length)).toEqual(second);
    expect(second?.slice(0, first?.length)).toEqual(first);
  });

  it.each([["deep", 8], ["balanced", 6], ["cheap", 5], ["fast", 5]] as const)("holds a unit's tool turns to its depth: %s has %i", async (depth, turns) => {
    const { store, requests, model } = await harness(({ toolOutputs }) => {
      const last = toolOutputs.at(-1) ?? "";
      return last.includes("TOOL_TURN_LIMIT_REACHED") ? answer() : calling({ name: "repo_stat", arguments: { path: "client/api.ts" } });
    }, depth);
    await discoverWithModel({ auditorId: "auditor-a", modelProfileId: "auditor-a", snapshot: { root: "fixture", files: [repository.files[0] as (typeof repository.files)[number]] }, activities: { invoke: <T>(request: ModelActivityRequest<T>) => model.invoke(request), toolUse: (id: string) => model.toolUse(id) }, store, signal: new AbortController().signal, protocol: await protocolAt("2.1.0"), depth });
    // The turns of tools, one more that asks and is told none remain, and the answer.
    expect(requests).toHaveLength(turns + 2);
    expect(await artifact(store, "discovery-validation-auditor-a")).toMatchObject({ toolUse: { toolTurnLimit: turns, turns: turns + 2, askedPastLimit: true } });
  });
});

describe("what a lookup delivers", () => {
  const scoped = { root: "fixture", files: [fileOf("src/app.ts", ["import { loadSettings } from \"./settings.js\";", "export const ready = loadSettings();"]), fileOf("config/settings.py", ["def load_settings():", "    password = \"hunter2isNotSecret\"", "    return password"]), fileOf("big/a.ts", ["export function large() {", ...Array.from({ length: 40 }, (_, index) => `  run(${String(index).padStart(60, "0")});`), "}"])] };

  it("masks a secret in what the model is sent and what the run stores", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbitra-discovery-mask-")); directories.push(root);
    const store = new RunStore(root, "run-1");
    const { runtime, readsBeyondUnit } = snapshotTools(scoped, store, "auditor-a/discovery", undefined, undefined, { unitPaths: new Set(["src/app.ts"]), maximumBytes: 10_000, reading: { unitSuppliedWhole: true } });
    const result = await runtime.invoke("repo_symbol", { names: ["load_settings"] }, { nodeId: "auditor-a/discovery", protect: (content, meta) => frameUntrusted(redactSecrets(content).text, meta) });
    expect(result.content).toContain("[REDACTED:assigned_secret]");
    expect(result.content).toContain("trust=\"untrusted\"");
    expect(result.content).not.toContain("hunter2isNotSecret");
    expect(readsBeyondUnit()?.reads).toMatchObject([{ path: "config/settings.py", startLine: 1, endLine: 3 }]);
  });

  it("stops at the budget for reading beyond the unit: it charges what it delivers, and names the rest with no text", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbitra-discovery-spent-")); directories.push(root);
    const store = new RunStore(root, "run-1");
    const { runtime, readsBeyondUnit } = snapshotTools(scoped, store, "auditor-a/discovery", undefined, undefined, { unitPaths: new Set(["src/app.ts"]), maximumBytes: 100, reading: { unitSuppliedWhole: true } });
    const context = { nodeId: "auditor-a/discovery", protect: (content: string) => content };
    const delivered = await runtime.invoke("repo_symbol", { names: ["load_settings"] }, context);
    expect(delivered.content).toContain("def load_settings");
    const spent = readsBeyondUnit()?.bytes ?? 0;
    expect(spent).toBeGreaterThan(0);
    const refused = await runtime.invoke("repo_symbol", { names: ["large"] }, context);
    expect(refused.ok).toBe(true);
    expect(refused.content).toContain("big/a.ts:1-42");
    expect(refused.content).toContain("budget for reading outside your source is spent");
    expect(refused.content).not.toContain("run(");
    expect(readsBeyondUnit()).toMatchObject({ bytes: spent, refused: 1 });
    expect(readsBeyondUnit()?.reads.map(({ path }) => path)).toEqual(["config/settings.py"]);
  });

  it("shows a unit's own file again when the unit was sent only a window of it", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbitra-discovery-window-")); directories.push(root);
    const { runtime } = snapshotTools(scoped, new RunStore(root, "run-1"), "auditor-a/discovery", undefined, undefined, { unitPaths: new Set(["config/settings.py"]), maximumBytes: 1_000, reading: { unitSuppliedWhole: false } });
    const result = await runtime.invoke("repo_symbol", { names: ["load_settings"] }, { nodeId: "auditor-a/discovery", protect: (content: string) => content });
    expect(result.content).toContain("def load_settings");
  });

  it("builds its index once for a snapshot, however many units read it", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbitra-discovery-once-")); directories.push(root);
    const store = new RunStore(root, "run-1");
    const context = { nodeId: "n", protect: (content: string) => content };
    const lines = vi.fn(() => ["def once():", "    return 1"]);
    const counted = { root: "fixture", files: [{ ...fileOf("o.py", ["def once():", "    return 1"]), get lines() { return lines(); } }] };
    for (const id of ["one", "two"]) await snapshotTools(counted, store, id, undefined, undefined, { unitPaths: new Set(), maximumBytes: 1_000, reading: { unitSuppliedWhole: true } }).runtime.invoke("repo_symbol", { names: ["once"] }, { ...context, nodeId: id });
    const afterFirstBuild = lines.mock.calls.length;
    await snapshotTools(counted, store, "three", undefined, undefined, { unitPaths: new Set(), maximumBytes: 1_000, reading: { unitSuppliedWhole: true } }).runtime.invoke("repo_symbol", { names: ["once"] }, { ...context, nodeId: "three" });
    // Each new tool set maps the snapshot's paths, and takes the lines of no file to index them again.
    expect(lines.mock.calls.length).toBe(afterFirstBuild);
  });

  it("is not offered in other stages' tools", () => {
    expect(SNAPSHOT_TOOLS.map(({ name }) => name)).not.toContain("repo_symbol");
    expect(READING_TOOLS.map(({ name }) => name)).toContain("repo_symbol");
  });
});
