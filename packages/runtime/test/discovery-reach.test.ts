import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bundledProtocolControlPlane } from "@arbitra/protocols/bundled.js";
import { ProtocolRegistry } from "@arbitra/protocols/registry.js";
import { runConfigSchema } from "@arbitra/schemas/config.js";
import type { HttpClient, HttpRequest } from "@arbitra/providers/transport-contract.js";
import { ModelActivities, type ModelActivityRequest } from "../src/model-activities.js";
import { assertDiscoveryResumable, DISCOVERY_READ_BEYOND_UNIT_BYTES, discoverWithModel } from "../src/model-discovery.js";
import { ModelHarness } from "../src/model-harness.js";
import { AUDIT_PROTOCOL_DEFAULTS, ModelProtocols } from "../src/model-protocols.js";
import { RunStore } from "../src/run-store.js";
import { READ_BUDGET_SPENT, snapshotTools } from "../src/snapshot-tools.js";

/*
 * Discovery reads beyond its unit (docs/research.md, section 12): only 8 of nextra's 97 discovery calls used a tool, 52
 * limitations said a caller was "not supplied", and a client that never sent the operator token its server requires
 * was missed, because no unit held both. The model here is a fake HTTP provider; no model is called.
 */

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function fileOf(path: string, lines: readonly string[]) {
  return { path, lines: [...lines], lineStartBytes: lines.map((_, index) => lines.slice(0, index).reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0)), byteLength: Buffer.byteLength(lines.join("\n")) };
}
const CLIENT = ["export async function deleteRoom(roomId: string): Promise<Response> {", "  return fetch(`/api/rooms/${roomId}`, { method: \"DELETE\" });", "}"];
const SERVER = ["export function deleteRoomHandler(request: Request): Response {", "  if (request.headers.get(\"x-operator-token\") !== process.env.OPERATOR_TOKEN) return new Response(null, { status: 403 });", "  return new Response(null, { status: 204 });", "}"];
const repository = { root: "fixture", files: [fileOf("client/api.ts", CLIENT), fileOf("server/rooms.ts", SERVER)] };

function finding(namespace: string, locations: readonly { id: string; path: string; line: number; text: string }[]) {
  return { schemaVersion: 1, sourceFindingId: `${namespace}/token`, category: "CORRECTNESS", title: "The client never sends the operator token", severity: "high", status: "needs_verification", confidence: 0.7, productionBlocker: false,
    locations: locations.map(({ id, path, line }) => ({ id, path, startLine: line, endLine: line })), evidence: locations.map(({ id, text }) => ({ id: `E-${id}`, text, locationIds: [id] })),
    problem: "Every delete is refused", productionImpact: "Rooms cannot be deleted", trigger: "Delete a room", recommendedFix: "Send the token", verification: "Delete a room", dependencies: [], relatedRisks: [] };
}

interface Call { readonly paths: readonly string[]; readonly namespace: string; readonly toolOutputs: readonly string[]; readonly payload: { repositoryIndex?: unknown } | null }
type Body = Record<string, unknown>;

/** A provider answering each turn from what it was sent; every request is kept. */
async function harness(reply: (call: Call) => Body, source = repository) {
  const root = await mkdtemp(join(tmpdir(), "arbitra-discovery-reach-")); directories.push(root);
  const example = runConfigSchema.parse(JSON.parse(await readFile(new URL("../../../examples/audit-balanced.json", import.meta.url), "utf8")));
  const profile = example.models["auditor-a"];
  if (profile === undefined) throw new Error("FIXTURE_PROFILE_ABSENT");
  const config = runConfigSchema.parse({ ...example, models: { "auditor-a": profile }, workflow: { modelExecution: {
    endpoints: [{ id: "primary", providerId: "openai", transport: "openai-responses", endpoint: "https://fixture.example/v1", apiKeyEnvVar: "FIXTURE_KEY" }],
    modelEndpoints: { "auditor-a": "primary" }, maximumOutputTokens: 500, maximumTokens: 1_000_000, timeoutMs: 1_000, maximumRetries: 0, maximumOutputRepairs: 0,
    rateLimits: { openai: { rpm: 1_000, tpm: 10_000_000, maxConcurrent: 4 } },
  } } });
  const store = new RunStore(root, "run-1");
  const requests: HttpRequest[] = [];
  const send = vi.fn<HttpClient["send"]>(async (request) => {
    requests.push(request);
    const input = (request.body as { input: { role?: string; content?: string; type?: string; output?: string }[] }).input;
    const system = input.filter(({ role }) => role === "system").map(({ content }) => content ?? "").join("\n");
    const user = input.find(({ role }) => role === "user")?.content ?? "";
    // A compiled prompt (with a protocol) is not JSON; the unit's own request is.
    const parsed = (): { files?: { path: string }[]; repositoryIndex?: unknown } | null => { try { return JSON.parse(user) as { files?: { path: string }[] }; } catch { return null; } };
    const payload = parsed();
    const namespace = /Every sourceFindingId must start with (\S+?)\/ and be unique/u.exec(`${system}\n${user}`)?.[1] ?? "";
    return { status: 200, headers: {}, body: { usage: { input_tokens: 10, output_tokens: 10 }, ...reply({ paths: payload?.files?.map(({ path }) => path) ?? [], namespace, payload, toolOutputs: input.filter(({ type }) => type === "function_call_output").map(({ output }) => output ?? "") }) } };
  });
  const model = new ModelHarness(new ModelActivities(store, config, { client: { send }, credential: () => "fixture-credential" }), config, source, store);
  return { root, store, requests, model, config };
}
const answer = (findings: readonly unknown[]): Body => ({ output_text: JSON.stringify({ findings, truncated: false, unexaminedDueToBudget: [], limitations: [] }) });
const read = (path: string, call = "call-1"): Body => ({ output: [{ type: "function_call", call_id: call, name: "repo_read_file", arguments: JSON.stringify({ path }) }] });
/** One file a unit: each unit counts 10,000 tokens a file against a budget of 15,000. */
const perFile = (model: ModelHarness) => ({ invoke: <T>(request: ModelActivityRequest<T>) => model.invoke(request), readsBeyondSource: (activityId: string) => model.readsBeyondSource(activityId),
  estimateInitialTokens: (request: ModelActivityRequest<unknown>) => 10_000 * ((JSON.parse(request.messages.find(({ role }) => role === "user")?.content ?? "{}") as { files?: unknown[] }).files?.length ?? 0) });
async function artifact(store: RunStore, kind: string) {
  const descriptor = (await store.listArtifacts()).find((entry) => entry.kind === kind);
  if (descriptor === undefined) throw new Error(`ARTIFACT_ABSENT:${kind}`);
  return JSON.parse((await store.readArtifact(descriptor.artifactId)).content) as Record<string, unknown>;
}
async function unitScope(store: RunStore, path: string): Promise<string> {
  const { scopes } = await artifact(store, "discovery-scopes-auditor-a") as { scopes: { scopeId: string; paths: string[] }[] };
  const scope = scopes.find(({ paths }) => paths.length === 1 && paths[0] === path);
  if (scope === undefined) throw new Error(`UNIT_ABSENT:${path}`);
  return scope.scopeId;
}

describe("discovery reads beyond its unit", () => {
  it("reads the server a client unit calls, cites both sides, and the finding passes validation", async () => {
    const { store, requests, model } = await harness(({ paths, namespace, toolOutputs }) => {
      if (paths[0] !== "client/api.ts") return answer([]);
      if (toolOutputs.length === 0) return read("server/rooms.ts");
      return answer([finding(namespace, [{ id: "L1", path: "client/api.ts", line: 2, text: CLIENT[1] ?? "" }, { id: "L2", path: "server/rooms.ts", line: 2, text: SERVER[1] ?? "" }])]);
    });
    const result = await discoverWithModel({ auditorId: "auditor-a", modelProfileId: "auditor-a", snapshot: repository, activities: perFile(model), store, signal: new AbortController().signal, maximumInputTokens: 15_000 });
    expect(result).toHaveLength(1);
    expect(result[0]?.locations.map(({ path, startLine }) => [path, startLine])).toEqual([["client/api.ts", 2], ["server/rooms.ts", 2]]);
    // The read was delivered, not refused as outside the call.
    const delivered = requests.flatMap(({ body }) => (body as { input: { type?: string; output?: string }[] }).input).filter(({ type }) => type === "function_call_output").map(({ output }) => output ?? "");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).not.toContain("PATH_OUTSIDE_THIS_CALL");
    expect(delivered[0]).toContain("x-operator-token");
    // Every unit carries the index of the whole repository, ahead of its own files.
    const first = (requests[0]?.body as { input: { role?: string; content?: string }[] }).input.find(({ role }) => role === "user")?.content ?? "";
    expect(Object.keys(JSON.parse(first) as object)).toEqual(["trust", "repositoryIndex", "files"]);
    expect((JSON.parse(first) as { repositoryIndex: { directories: unknown } }).repositoryIndex.directories).toEqual({ client: ["api.ts 3: deleteRoom"], server: ["rooms.ts 4: deleteRoomHandler"] });
    // What the unit read beyond itself is recorded with the unit, and summed for the auditor.
    expect(await artifact(store, `discovery-validation-auditor-a-${await unitScope(store, "client/api.ts")}`)).toMatchObject({ acceptedCount: 1, rejectedCount: 0,
      readBeyondUnit: { maximumBytes: DISCOVERY_READ_BEYOND_UNIT_BYTES, refusedReads: 0, files: [{ path: "server/rooms.ts", lines: [[1, 4]] }], findingsCitingBeyondUnit: 1 } });
    expect(await artifact(store, `discovery-validation-auditor-a-${await unitScope(store, "server/rooms.ts")}`)).toMatchObject({ readBeyondUnit: { bytes: 0, files: [], findingsCitingBeyondUnit: 0 } });
    expect(await artifact(store, "discovery-validation-auditor-a")).toMatchObject({ acceptedCount: 1, readsBeyondUnits: { units: 2, unitsReading: 1, paths: ["server/rooms.ts"], findingsCitingBeyondUnit: 1, refusedReads: 0 } });
  });

  it("refuses a citation of another file's lines that the unit never read", async () => {
    const { store, model } = await harness(({ paths, namespace }) => paths[0] !== "client/api.ts" ? answer([])
      : answer([finding(namespace, [{ id: "L1", path: "client/api.ts", line: 2, text: CLIENT[1] ?? "" }, { id: "L2", path: "server/rooms.ts", line: 2, text: SERVER[1] ?? "" }])]));
    expect(await discoverWithModel({ auditorId: "auditor-a", modelProfileId: "auditor-a", snapshot: repository, activities: perFile(model), store, signal: new AbortController().signal, maximumInputTokens: 15_000 })).toEqual([]);
    const rejection = (await store.listArtifacts()).find(({ kind }) => kind.startsWith("discovery-rejection-auditor-a-"));
    expect(JSON.parse((await store.readArtifact(rejection?.artifactId ?? "")).content)).toMatchObject({ reasons: [{ code: "evidence_outside_exposure" }] });
  });

  it("masks a secret in a file read outside the unit, in what the model is sent and what the run stores, and grounds its masked quotation", async () => {
    const source = { root: "fixture", files: [fileOf("src/app.ts", ["import { loadSettings } from \"./settings.js\";", "export const ready = loadSettings();"]), fileOf("config/settings.py", ["API_URL = \"https://example.test\"", "password = \"hunter2isNotSecret\""])] };
    const { root, store, requests, model } = await harness(({ paths, namespace, toolOutputs }) => {
      if (paths[0] !== "src/app.ts") return answer([]);
      if (toolOutputs.length === 0) return read("config/settings.py");
      return answer([{ ...finding(namespace, [{ id: "L1", path: "config/settings.py", line: 2, text: "password = \"[REDACTED:assigned_secret]\"" }]), category: "SECURITY", title: "A password in source" }]);
    }, source);
    const result = await discoverWithModel({ auditorId: "auditor-a", modelProfileId: "auditor-a", snapshot: source, activities: perFile(model), store, signal: new AbortController().signal, maximumInputTokens: 15_000 });
    const toolOutput = requests.flatMap(({ body }) => (body as { input: { type?: string; output?: string }[] }).input).find(({ type }) => type === "function_call_output")?.output ?? "";
    expect(toolOutput).toContain("[REDACTED:assigned_secret]");
    expect(toolOutput).toContain("API_URL");
    expect(result.map(({ locations }) => locations[0]?.path)).toEqual(["config/settings.py"]);
    const stored = await Promise.all((await readdir(root, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => readFile(join(entry.parentPath, entry.name), "utf8")));
    for (const text of [JSON.stringify(requests.map(({ body }) => body)), ...stored]) expect(text).not.toContain("hunter2isNotSecret");
  });

  it("stops reads beyond the unit at the call's byte budget, never reads of the unit itself", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbitra-discovery-budget-")); directories.push(root);
    const store = new RunStore(root, "run-1");
    const lines = (name: string) => Array.from({ length: 20 }, (_, index) => `export const ${name}${String(index).padStart(2, "0")} = ${index};`.padEnd(29, " "));
    const source = { root: "fixture", files: [fileOf("unit.ts", lines("own")), ...["a", "b", "c"].map((name) => fileOf(`other/${name}.ts`, lines(name)))] };
    const { runtime, readsBeyondUnit } = snapshotTools(source, store, "auditor-a/discovery", undefined, undefined, { unitPaths: new Set(["unit.ts"]), maximumBytes: 1_000 });
    const context = { nodeId: "auditor-a/discovery", protect: (content: string) => content };
    const whole = await runtime.invoke("repo_read_file", { path: "other/a.ts" }, context);
    expect(whole).toMatchObject({ ok: true, truncated: false });
    // 600 bytes are read; the next read is cut at whole lines to what is left.
    const cut = await runtime.invoke("repo_read_file", { path: "other/b.ts" }, context);
    expect(cut).toMatchObject({ ok: true, truncated: true });
    expect(cut.content.endsWith("\n")).toBe(true);
    expect(await runtime.invoke("repo_read_file", { path: "other/c.ts" }, context)).toMatchObject({ ok: false, error: { code: READ_BUDGET_SPENT } });
    expect(await runtime.invoke("repo_read_file", { path: "unit.ts" }, context)).toMatchObject({ ok: true, truncated: false });
    expect(await runtime.invoke("repo_search", { query: "c19" }, context)).toMatchObject({ ok: true });
    const reads = readsBeyondUnit();
    expect(reads).toMatchObject({ maximumBytes: 1_000, refused: 1, reads: [{ path: "other/a.ts", startLine: 1, endLine: 20, bytes: 599 }, { path: "other/b.ts", startLine: 1, endLine: 13 }] });
    expect(reads?.bytes).toBeLessThanOrEqual(1_000);
  });

  it("starts every unit's prompt with the same text through the index, so a provider can read it from its cache", async () => {
    const protocol = await new ProtocolRegistry(bundledProtocolControlPlane()).resolve("production-audit", "2.0.0");
    const { store, model } = await harness(() => answer([]));
    await discoverWithModel({ auditorId: "auditor-a", modelProfileId: "auditor-a", snapshot: repository, activities: perFile(model), store, signal: new AbortController().signal, maximumInputTokens: 15_000, protocol });
    const prompts = await Promise.all(["client/api.ts", "server/rooms.ts"].map(async (path) => (await artifact(store, `compiled-prompt-${createHash("sha256").update(`auditor-a/${await unitScope(store, path)}/discovery`).digest("hex")}`))["text"] as string));
    const [left = "", right = ""] = prompts;
    let shared = 0; while (shared < left.length && left[shared] === right[shared]) shared += 1;
    const files = left.indexOf("\\\"files\\\"");
    expect(left.indexOf("repositoryIndex")).toBeGreaterThan(0);
    expect(files).toBeGreaterThan(left.indexOf("rooms.ts 4: deleteRoomHandler"));
    expect(shared).toBeGreaterThanOrEqual(files);
  });
});

describe("a run whose discovery was pinned before production-audit 2.0.0", () => {
  it("is refused when its discovery would go on, and resumes once every auditor has its findings", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbitra-discovery-retired-")); directories.push(root);
    const store = new RunStore(root, "run-old");
    const old = await new ProtocolRegistry(bundledProtocolControlPlane()).resolve("production-audit", "1.0.0");
    const activities = { invoke: vi.fn(async () => { throw new Error("NO_CALL_EXPECTED"); }) };
    await expect(discoverWithModel({ auditorId: "auditor-a", modelProfileId: "model", snapshot: repository, activities, store, signal: new AbortController().signal, protocol: old }))
      .rejects.toThrow(/^DISCOVERY_PROTOCOL_RETIRED:production-audit@1\.0\.0: .*start a new run on this build/u);
    expect(activities.invoke).not.toHaveBeenCalled();
    // A resumed run keeps the pin it made; the build's default is only for a run that has none.
    await store.publish("model-protocol-production-audit", old);
    expect((await new ModelProtocols(store, {}, undefined, AUDIT_PROTOCOL_DEFAULTS).resolve("production-audit")).protocolVersion).toBe("1.0.0");
    await expect(assertDiscoveryResumable(store, ["auditor-a", "auditor-b"])).rejects.toThrow("DISCOVERY_PROTOCOL_RETIRED:production-audit@1.0.0");
    await store.publish("findings-auditor-a", [], "auditor-a");
    await expect(assertDiscoveryResumable(store, ["auditor-a", "auditor-b"])).rejects.toThrow("DISCOVERY_PROTOCOL_RETIRED");
    await store.publish("findings-auditor-b", [], "auditor-b");
    await expect(assertDiscoveryResumable(store, ["auditor-a", "auditor-b"])).resolves.toBeUndefined();
  });

  it("is not a new run's: a new run pins 2.0.0 and its discovery proceeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbitra-discovery-current-")); directories.push(root);
    const store = new RunStore(root, "run-new");
    const pinned = await new ModelProtocols(store, {}, undefined, AUDIT_PROTOCOL_DEFAULTS).resolve("production-audit");
    expect(pinned.protocolVersion).toBe("2.0.0");
    expect(pinned.content).toContain("Read before concluding");
    await expect(assertDiscoveryResumable(store, ["auditor-a"])).resolves.toBeUndefined();
  });
});
