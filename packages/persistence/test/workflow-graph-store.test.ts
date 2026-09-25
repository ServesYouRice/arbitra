import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowGraphStore } from "../src/workflow-graph-store.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function store(): Promise<{ root: string; store: WorkflowGraphStore }> {
  const root = await mkdtemp(join(tmpdir(), "workflow-graphs-"));
  roots.push(root);
  let tick = 0;
  return { root, store: new WorkflowGraphStore(root, { now: () => `2026-01-01T00:00:0${tick++}.000Z` }) };
}

describe("workflow graph store", () => {
  it("stores each graph once under its content address and keeps versions immutable", async () => {
    const { store: graphs } = await store();
    const first = await graphs.save({ graphId: "reviewed", graph: { id: "reviewed", nodes: [1] }, parentVersion: null, authorizations: [] });
    expect(first.created).toBe(true);
    expect(first.record.version).toBe(WorkflowGraphStore.versionOf({ nodes: [1], id: "reviewed" }));
    // Saving identical content again is the same version; its first record is kept.
    const again = await graphs.save({ graphId: "reviewed", graph: { nodes: [1], id: "reviewed" }, parentVersion: null, authorizations: ["write_authority"] });
    expect(again).toEqual({ record: first.record, created: false });
    const second = await graphs.save({ graphId: "reviewed", graph: { id: "reviewed", nodes: [1, 2] }, parentVersion: first.record.version, authorizations: ["b", "a", "a"] });
    expect(second.record).toMatchObject({ parentVersion: first.record.version, authorizations: ["a", "b"], savedAt: "2026-01-01T00:00:02.000Z" });
    expect((await graphs.versions("reviewed")).map(({ version }) => version)).toEqual([first.record.version, second.record.version]);
    expect(await graphs.list()).toEqual([{ graphId: "reviewed", versions: await graphs.versions("reviewed") }]);
    expect(await graphs.get("reviewed", first.record.version)).toEqual(first.record);
    expect(await graphs.get("reviewed", "0".repeat(64))).toBeNull();
  });

  it("refuses unknown parents, invalid identifiers and tampered bodies", async () => {
    const { root, store: graphs } = await store();
    await expect(graphs.save({ graphId: "g", graph: {}, parentVersion: "a".repeat(64), authorizations: [] })).rejects.toThrow("WORKFLOW_PARENT_VERSION_ABSENT");
    await expect(graphs.save({ graphId: "../escape", graph: {}, parentVersion: null, authorizations: [] })).rejects.toThrow("INVALID_WORKFLOW_GRAPH_ID");
    await expect(graphs.get("g", "latest")).rejects.toThrow("INVALID_WORKFLOW_GRAPH_VERSION");
    const { record } = await graphs.save({ graphId: "g", graph: { id: "g" }, parentVersion: null, authorizations: [] });
    await writeFile(join(root, "artifacts", `${record.version}.json`), "{\"id\":\"changed\"}");
    await expect(graphs.get("g", record.version)).rejects.toThrow();
    const recordPath = join(root, "versions", "g", `${record.version}.json`);
    const stored = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
    await writeFile(recordPath, JSON.stringify({ ...stored, graphId: "other" }));
    await expect(graphs.versions("g")).rejects.toThrow("INVALID_WORKFLOW_GRAPH_RECORD");
  });
});
