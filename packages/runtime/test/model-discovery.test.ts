import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelActivities, ModelActivityRequest } from "../src/model-activities.js";
import { discoverWithModel } from "../src/model-discovery.js";
import { RunStore } from "../src/run-store.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const snapshot = { root: "fixture", files: [{ path: "src/a.ts", lines: ["const value = null;"], lineStartBytes: [0], byteLength: 19 }] };
function finding(id: string, text = "const value = null;") {
  return { schemaVersion: 1, sourceFindingId: `auditor-a/${id}`, category: "CORRECTNESS", title: "Fixture claim", severity: "medium", status: "needs_verification", confidence: 0.5, productionBlocker: false,
    locations: [{ id: "L1", path: "src/a.ts", startLine: 1, endLine: 1 }], evidence: [{ id: "E1", text, locationIds: ["L1"] }],
    problem: "Fixture problem", productionImpact: "", trigger: "", recommendedFix: "Check value", verification: "", dependencies: [], relatedRisks: [],
  };
}
async function setup(output: unknown) {
  const root = await mkdtemp(join(tmpdir(), "arbitra-discovery-")); directories.push(root);
  const store = new RunStore(root, "run-1");
  const prompts: string[] = [];
  const activities: Pick<ModelActivities, "invoke"> = { async invoke(input) { prompts.push(JSON.stringify(input.messages)); return input.schema.parse({ findings: output, truncated: false, unexaminedDueToBudget: [], limitations: [] }); } };
  const run = () => discoverWithModel({ auditorId: "auditor-a", modelProfileId: "configured-model", snapshot, activities, store, signal: new AbortController().signal });
  return { store, run, prompts };
}

describe("independent model discovery", () => {
  it("runs bounded independent scopes with unique finding IDs and explicit uncovered paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbitra-discovery-scopes-")); directories.push(root);
    const store = new RunStore(root, "run-scopes");
    const calls: string[][] = [];
    const activities = {
      estimateInitialTokens(input: { messages: readonly { role: string; content: string }[] }) {
        const payload = JSON.parse(input.messages.find(({ role }) => role === "user")?.content ?? "{}");
        return payload.files.reduce((sum: number, file: { path: string }) => sum + (file.path === "huge.ts" ? 200 : 40), 0);
      },
      async invoke<T>(input: ModelActivityRequest<T>): Promise<T> {
        const payload = JSON.parse(input.messages.find(({ role }) => role === "user")?.content ?? "{}");
        const namespace = /Every sourceFindingId must start with (.+)\/ and be unique/u.exec(input.messages.find(({ role }) => role === "system")?.content ?? "")?.[1];
        calls.push(payload.files.map(({ path }: { path: string }) => path));
        const path = payload.files[0]?.path;
        return input.schema.parse({ findings: [{ ...finding("one"), sourceFindingId: `${namespace}/one`, locations: [{ id: "L1", path, startLine: 1, endLine: 1 }] }], truncated: false, unexaminedDueToBudget: [], limitations: [] });
      },
    };
    const result = await discoverWithModel({ auditorId: "auditor-a", modelProfileId: "model", activities, store, signal: new AbortController().signal, maximumInputTokens: 50,
      snapshot: { root: "fixture", files: ["a.ts", "b.ts", "huge.ts"].map((path) => ({ ...snapshot.files[0], path, lines: ["const value = null;"], lineStartBytes: [0], byteLength: 19 })) } });
    expect(calls).toEqual([["a.ts"], ["b.ts"]]);
    expect(new Set(result.map(({ sourceFindingId }) => sourceFindingId)).size).toBe(2);
    const summary = (await store.listArtifacts()).find(({ kind }) => kind === "discovery-validation-auditor-a");
    if (summary === undefined) throw new Error("SUMMARY_ABSENT");
    expect(JSON.parse((await store.readArtifact(summary.artifactId)).content)).toMatchObject({ acceptedCount: 2, unexaminedDueToBudget: ["huge.ts:1"], limitations: expect.arrayContaining(["lines_exceed_discovery_context_budget"]) });
  });

  it("audits a file larger than the discovery budget through exact original-line windows and reuses them on resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbitra-discovery-windows-")); directories.push(root);
    const store = new RunStore(root, "run-windows");
    const lines = Array.from({ length: 200 }, (_, index) => `const value${index + 1} = ${index % 50 === 7 ? "null" : index};`);
    const big = { path: "big.ts", lines, lineStartBytes: lines.map((_, index) => lines.slice(0, index).reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0)), byteLength: Buffer.byteLength(lines.join("\n")) };
    const durable = new Map<string, unknown>(); const spent: string[] = []; const seen: { start: number; end: number }[] = [];
    const activities = {
      estimateInitialTokens(input: { messages: readonly { role: string; content: string }[] }) { return Buffer.byteLength(input.messages.find(({ role }) => role === "user")?.content ?? ""); },
      async invoke<T>(input: ModelActivityRequest<T>): Promise<T> {
        if (!durable.has(input.activityId)) {
          spent.push(input.activityId);
          const payload = JSON.parse(input.messages.find(({ role }) => role === "user")?.content ?? "{}") as { files: { path: string; lines: { line: number; text: string }[] }[] };
          const namespace = /Every sourceFindingId must start with (.+)\/ and be unique/u.exec(input.messages.find(({ role }) => role === "system")?.content ?? "")?.[1];
          const supplied = payload.files[0]?.lines ?? [];
          seen.push({ start: supplied[0]?.line ?? 0, end: supplied.at(-1)?.line ?? 0 });
          // Evidence cites original line numbers taken from the window and exact source text.
          durable.set(input.activityId, { findings: supplied.filter(({ text }) => text.includes("null")).map(({ line, text }) => ({ ...finding(`${line}`), sourceFindingId: `${namespace}/L${line}`,
            locations: [{ id: "L1", path: "big.ts", startLine: line, endLine: line }], evidence: [{ id: "E1", text, locationIds: ["L1"] }] })), truncated: false, unexaminedDueToBudget: [], limitations: [] });
        }
        return input.schema.parse(durable.get(input.activityId));
      },
    };
    const run = () => discoverWithModel({ auditorId: "auditor-a", modelProfileId: "model", activities, store, signal: new AbortController().signal, maximumInputTokens: 2_500, snapshot: { root: "fixture", files: [big] } });
    const result = await run();
    // Previously this whole file was reported unexamined; every line is now read exactly.
    expect(seen.length).toBeGreaterThan(2);
    expect(seen[0]?.start).toBe(1); expect(seen.at(-1)?.end).toBe(200);
    for (let index = 1; index < seen.length; index += 1) expect((seen[index]?.start ?? 0)).toBeLessThanOrEqual((seen[index - 1]?.end ?? 0) + 1);
    const nullLines = lines.flatMap((line, index) => line.includes("null") ? [index + 1] : []);
    expect([...new Set(result.map(({ locations }) => locations[0]?.startLine))].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(nullLines);
    const summary = (await store.listArtifacts()).find(({ kind }) => kind === "discovery-validation-auditor-a");
    const coverage = JSON.parse((await store.readArtifact(summary?.artifactId ?? "")).content) as { unexaminedDueToBudget: string[]; limitations: string[]; rejectedCount: number };
    expect(coverage.unexaminedDueToBudget).toEqual([]);
    expect(coverage.rejectedCount).toBe(0);
    expect(coverage.limitations).toEqual(expect.arrayContaining(["file_context_split:big.ts"]));
    expect(coverage.limitations).not.toContain("files_exceed_discovery_context_budget");
    // Deterministic window identities: a resumed discovery repeats no model work.
    const before = spent.length;
    expect((await run()).map(({ sourceFindingId }) => sourceFindingId)).toEqual(result.map(({ sourceFindingId }) => sourceFindingId));
    expect(spent).toHaveLength(before);
  });

  it("accepts grounded citations, rejects fabricated excerpts and invalid paths, and records coverage loss", async () => {
    const invalidPath = { ...finding("3"), locations: [{ id: "L1", path: "constructor", startLine: 1, endLine: 1 }] };
    const { run, store } = await setup([finding("1"), finding("2", "fabricated source"), invalidPath]);
    expect((await run()).map(({ sourceFindingId }) => sourceFindingId)).toEqual(["auditor-a/1"]);
    const descriptor = (await store.listArtifacts()).find(({ kind }) => kind === "discovery-validation-auditor-a");
    if (descriptor === undefined) throw new Error("VALIDATION_ABSENT");
    expect(JSON.parse((await store.readArtifact(descriptor.artifactId)).content)).toMatchObject({ acceptedCount: 1, rejectedCount: 2, quoteRejections: ["auditor-a/2"] });
  });

  it("does not expose stored peer findings to independent discovery", async () => {
    const { run, store, prompts } = await setup([]);
    await store.publish("findings-peer", { secretPeerClaim: "PEER_REASONING_SENTINEL" });
    await run();
    expect(prompts.join("\n")).not.toContain("PEER_REASONING_SENTINEL");
    expect(prompts.join("\n")).toContain("untrusted_repository_data");
  });

  it("rejects duplicate identities and findings without evidence", async () => {
    await expect((await setup([finding("1"), finding("1")])).run()).rejects.toThrow("INVALID_DISCOVERY_FINDING_ID");
    await expect((await setup([{ ...finding("1"), evidence: [] }])).run()).rejects.toThrow("DISCOVERY_EVIDENCE_REQUIRED");
  });
});
