import { createHash } from "node:crypto";
import { ToolRegistry } from "@arbitra/tools/registry.js";
import { FootprintRecorder } from "@arbitra/tools/footprint/index.js";
import type { ReadRepository, SearchHit } from "@arbitra/tools/repo/types.js";
import type { HarnessToolDefinition, HarnessToolRuntime } from "@arbitra/harness/adapter.js";
import type { RepositorySnapshot } from "./repository.js";
import type { RunStore } from "./run-store.js";

const names = { repo_list_tree: "repo.listTree", repo_read_file: "repo.readFile", repo_search: "repo.search", repo_stat: "repo.stat", artifact_read: "artifact.read" } as const;
export const SNAPSHOT_TOOLS: readonly HarnessToolDefinition[] = [
  { name: "repo_list_tree", description: "List source paths in the immutable run snapshot.", inputSchema: { type: "object", properties: { scope: { type: "string" } }, additionalProperties: false } },
  { name: "repo_read_file", description: "Read a snapshot file, optionally a 1-based line range.", inputSchema: { type: "object", properties: { path: { type: "string" }, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 } }, required: ["path"], additionalProperties: false } },
  { name: "repo_search", description: "Search snapshot source for literal text.", inputSchema: { type: "object", properties: { query: { type: "string" }, scope: { type: "string" } }, required: ["query"], additionalProperties: false } },
  { name: "repo_stat", description: "Read snapshot file metadata.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } },
  { name: "artifact_read", description: "Read only a tool-output artifact produced by this activity.", inputSchema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"], additionalProperties: false } },
];

export function snapshotTools(snapshot: RepositorySnapshot, store: RunStore, activityId: string, maximumBytes = 128_000): { runtime: HarnessToolRuntime; footprints: FootprintRecorder } {
  const byPath = new Map(snapshot.files.map((file) => [file.path, file]));
  const selected = (scope?: string) => snapshot.files.filter(({ path }) => scope === undefined || scope === "." || path === scope || path.startsWith(`${scope.replace(/\/$/u, "")}/`));
  const read: ReadRepository["readFile"] = async (path) => {
    const file = byPath.get(path);
    if (file === undefined) throw new Error("PATH_NOT_IN_SNAPSHOT");
    return { path, content: file.lines.join("\n"), size: file.byteLength, modifiedAt: null };
  };
  const repository: ReadRepository = {
    async listTree(scope) { return selected(scope).map(({ path }) => path); }, readFile: read, readManifest: read,
    async stat(path) { const file = await read(path); return { size: file.size, modifiedAt: null }; },
    async search(query, scope) {
      if (!query.trim()) throw new Error("SEARCH_QUERY_REQUIRED");
      const hits: SearchHit[] = [];
      for (const file of selected(scope)) for (const [index, text] of file.lines.entries()) {
        const column = text.indexOf(query);
        if (column < 0) continue;
        const startByte = (file.lineStartBytes[index] ?? 0) + Buffer.byteLength(text.slice(0, column));
        hits.push({ path: file.path, line: index + 1, column: column + 1, text, startByte, endByte: startByte + Buffer.byteLength(query) });
      }
      return hits;
    },
    async gitStatus() { throw new Error("SNAPSHOT_GIT_EVIDENCE_UNAVAILABLE"); },
    async gitDiff() { throw new Error("SNAPSHOT_GIT_EVIDENCE_UNAVAILABLE"); },
    async gitLog() { throw new Error("SNAPSHOT_GIT_EVIDENCE_UNAVAILABLE"); },
  };
  const footprints = new FootprintRecorder();
  const allowedArtifacts = new Set<string>();
  const registry = new ToolRegistry({ repository, footprints, nodeBudgetBytes: maximumBytes, defaultCallBytes: Math.min(8_192, maximumBytes), artifacts: {
    async put(content) {
      const digest = createHash("sha256").update(activityId).update("\0").update(content).digest("hex");
      const artifact = await store.publish(`tool-output-${digest}`, { content }, activityId);
      allowedArtifacts.add(artifact.artifactId);
      return artifact.artifactId;
    },
    async read(ref) {
      if (!allowedArtifacts.has(ref)) throw new Error("ARTIFACT_OUTSIDE_ACTIVITY_CONTEXT");
      const value = JSON.parse((await store.readArtifact(ref)).content) as { content: string };
      return value.content;
    },
  } });
  return { footprints, runtime: { async invoke(name, args, context) {
    if (!Object.hasOwn(names, name)) return { ok: false, summary: "Tool unavailable", content: "Only declared snapshot tools are available.", artifact: null, truncated: false, trust: "untrusted", error: { code: "TOOL_NOT_ALLOWED", message: "Only declared snapshot tools are available." } };
    return registry.invoke(names[name as keyof typeof names], args, { nodeId: context.nodeId, protect: context.protect });
  } } };
}
