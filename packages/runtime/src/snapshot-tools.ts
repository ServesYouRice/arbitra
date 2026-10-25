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

/** A call that audits some files of the snapshot and may read the rest: what it read beyond them, under its budget. */
export interface BeyondUnitPolicy { readonly unitPaths: ReadonlySet<string>; readonly maximumBytes: number }
export interface ReadsBeyondUnit {
  readonly maximumBytes: number;
  /** Bytes of tool results that carried files outside the unit. */
  readonly bytes: number;
  /** Each read of a file outside the unit, as the whole lines it delivered. */
  readonly reads: readonly { readonly path: string; readonly startLine: number; readonly endLine: number; readonly bytes: number }[];
  /** Reads refused because the budget was spent. */
  readonly refused: number;
}
export const READ_BUDGET_SPENT = "READ_BUDGET_SPENT";

/**
 * `repositoryPaths` names every file of the repository when `snapshot` holds only the files a call was given, so a
 * read of another file says that it exists outside the call. Observed live (P20 pilot): told only
 * PATH_NOT_IN_SNAPSHOT, a discovery unit wrote that two files of the repository were not in it, after 62,000 more
 * tokens of reasoning about them.
 *
 * With `beyondUnit`, `snapshot` is the whole snapshot and every file of it can be read: reads of files outside the
 * unit share `beyondUnit.maximumBytes`, a read is cut at whole lines to what is left, and once it is spent such reads
 * are refused. Searches and listings cover the whole snapshot; they deliver paths and line numbers only, within the
 * activity's byte budget like every result.
 */
export function snapshotTools(snapshot: RepositorySnapshot, store: RunStore, activityId: string, maximumBytes = 128_000, repositoryPaths?: ReadonlySet<string>, beyondUnit?: BeyondUnitPolicy): { runtime: HarnessToolRuntime; footprints: FootprintRecorder; archive(content: string): Promise<string>; readsBeyondUnit(): ReadsBeyondUnit | null } {
  const byPath = new Map(snapshot.files.map((file) => [file.path, file]));
  const selected = (scope?: string) => snapshot.files.filter(({ path }) => scope === undefined || scope === "." || path === scope || path.startsWith(`${scope.replace(/\/$/u, "")}/`));
  const read: ReadRepository["readFile"] = async (path) => {
    const file = byPath.get(path);
    if (file === undefined && repositoryPaths?.has(path) === true) throw new Error(`PATH_OUTSIDE_THIS_CALL: ${path} is a file of the repository, but not one of the files this call was given, so it cannot be read here; do not report it as missing.`);
    if (file === undefined) throw new Error("PATH_NOT_IN_SNAPSHOT");
    return { path, content: file.lines.join("\n"), size: file.byteLength, modifiedAt: null };
  };
  const repository: ReadRepository = {
    async listTree(scope) { return selected(scope).map(({ path }) => path); }, readFile: read, readManifest: read,
    async stat(path) { const file = await read(path); return { size: file.size, modifiedAt: null }; },
    async search(query, scope) {
      if (!query.trim()) throw new Error("SEARCH_QUERY_REQUIRED");
      const hits: SearchHit[] = [];
      // One hit per matching line, at its first occurrence, as grep reports it: the line's text shows any others, and
      // a hit per occurrence would repeat the same line to the model.
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
  const archive = async (content: string): Promise<string> => {
    const digest = createHash("sha256").update(activityId).update("\0").update(content).digest("hex");
    const artifact = await store.publish(`tool-output-${digest}`, { content }, activityId);
    allowedArtifacts.add(artifact.artifactId);
    return artifact.artifactId;
  };
  // One result carries a source file of ordinary size whole. A model's next turn resends its whole prompt, so a
  // file cut short costs a second call. Observed live (P20 pilot): at 8,192 bytes a file of some 300 lines came
  // in two calls, and the second resent 125,000 tokens.
  const registry = new ToolRegistry({ repository, footprints, nodeBudgetBytes: maximumBytes, defaultCallBytes: Math.min(32_768, maximumBytes), artifacts: {
    put: archive,
    async read(ref) {
      if (!allowedArtifacts.has(ref)) throw new Error("ARTIFACT_OUTSIDE_ACTIVITY_CONTEXT");
      const value = JSON.parse((await store.readArtifact(ref)).content) as { content: string };
      return value.content;
    },
  } });
  const beyond = { bytes: 0, refused: 0, reads: [] as { path: string; startLine: number; endLine: number; bytes: number }[] };
  const readsBeyondUnit = (): ReadsBeyondUnit | null => beyondUnit === undefined ? null : { maximumBytes: beyondUnit.maximumBytes, bytes: beyond.bytes, reads: beyond.reads.map((read) => ({ ...read })), refused: beyond.refused };
  return { footprints, archive, readsBeyondUnit, runtime: { async invoke(name, args, context) {
    if (!Object.hasOwn(names, name)) return { ok: false, summary: "Tool unavailable", content: "Only declared snapshot tools are available.", artifact: null, truncated: false, trust: "untrusted", error: { code: "TOOL_NOT_ALLOWED", message: "Only declared snapshot tools are available." } };
    const tool = names[name as keyof typeof names];
    const path = typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>)["path"] : undefined;
    const file = tool === "repo.readFile" && typeof path === "string" && beyondUnit !== undefined && !beyondUnit.unitPaths.has(path) ? byPath.get(path) : undefined;
    if (beyondUnit === undefined || file === undefined) return registry.invoke(tool, args, { nodeId: context.nodeId, protect: context.protect });
    const remaining = Math.max(0, beyondUnit.maximumBytes - beyond.bytes);
    // A read is cut at whole lines to what is left, so one whose first line does not fit delivers nothing whole.
    const first = (args as Record<string, unknown>)["startLine"];
    const firstLine = file.lines[(typeof first === "number" && Number.isInteger(first) && first >= 1 ? first : 1) - 1];
    if (firstLine !== undefined && Buffer.byteLength(firstLine) + 1 > remaining) {
      beyond.refused += 1;
      const message = `${READ_BUDGET_SPENT}: this call has read ${beyond.bytes} bytes of files outside its unit, and ${remaining} of its budget of ${beyondUnit.maximumBytes} are left, less than the first line asked for. Conclude from what you have read, and name what you could not read as a limitation.`;
      return { ok: false, summary: message, content: "", artifact: null, truncated: false, trust: "untrusted", error: { code: READ_BUDGET_SPENT, message } };
    }
    const before = footprints.exposure(context.nodeId).ranges.length;
    const result = await registry.invoke(tool, args, { nodeId: context.nodeId, protect: context.protect, maxCallBytes: remaining });
    if (!result.ok) return result;
    beyond.bytes += Buffer.byteLength(result.content);
    const delivered = deliveredLines(file.lines, footprints.exposure(context.nodeId).ranges.slice(before).filter((range) => range.source === "repository" && range.path === file.path));
    if (delivered !== null) beyond.reads.push({ path: file.path, ...delivered, bytes: Buffer.byteLength(result.content) });
    return result;
  } } };
}

/** The whole lines a read delivered, from its exposure in the bytes of the text the tools read (lines joined by "\n"). */
function deliveredLines(lines: readonly string[], ranges: readonly { readonly start: number; readonly end: number }[]): { startLine: number; endLine: number } | null {
  const range = ranges[0];
  if (range === undefined) return null;
  let offset = 0; let startLine = 0; let endLine = 0;
  for (const [index, line] of lines.entries()) {
    if (offset >= range.end) break;
    const end = offset + Buffer.byteLength(line);
    if (offset >= range.start && end <= range.end) { if (startLine === 0) startLine = index + 1; endLine = index + 1; }
    offset = end + 1;
  }
  return startLine === 0 ? null : { startLine, endLine };
}
