import { createHash } from "node:crypto";
import { ToolRegistry, type LineDelivery, type LinesToDeliver } from "@arbitra/tools/registry.js";
import { FootprintRecorder } from "@arbitra/tools/footprint/index.js";
import { buildSymbolIndex, type SymbolIndex } from "@arbitra/tools/repo/symbol-index.js";
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

/** Lines of context around each hit of a search, unless the call asks for another number. */
export const SEARCH_CONTEXT_LINES = 2;
const NUMBERED_LINES = "Lines come numbered: \"12:\" is a matched or asked-for line, \"12-\" a line around it. The number and its mark are not part of the source: leave them out of a quotation, and cite the number as the line.";

/**
 * What a discovery unit is offered from production-audit 2.1.0. A symbol lookup and a search that carries its context
 * answer in one turn what took a search and then a read. A call on any earlier protocol is offered `SNAPSHOT_TOOLS`,
 * byte for byte: these definitions are part of the prompt and of the identity of every turn.
 */
export const READING_TOOLS: readonly HarnessToolDefinition[] = [
  SNAPSHOT_TOOLS[0] as HarnessToolDefinition,
  { name: "repo_symbol", description: `Look names up across the whole snapshot: for each, every definition with its whole body, then the lines that use it. Ask for up to 8 names in one call, as they appear in the code (a function, type, module, or a qualified name such as Accounts.get_user). Prefer it to a search and a read when you know a name. A definition in the source you were given is named by location only. ${NUMBERED_LINES}`, inputSchema: { type: "object", properties: { names: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8 }, scope: { type: "string", description: "A directory or file to keep to." } }, required: ["names"], additionalProperties: false } },
  { name: "repo_read_file", description: "Read a snapshot file, optionally a 1-based line range. Ask for the lines you need when you know them.", inputSchema: { type: "object", properties: { path: { type: "string" }, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 } }, required: ["path"], additionalProperties: false } },
  { name: "repo_search", description: `Search snapshot source for literal text, for what is not a name. Each hit comes with the lines around it, ${SEARCH_CONTEXT_LINES} by default. Hits in the source you were given are named by location only. ${NUMBERED_LINES}`, inputSchema: { type: "object", properties: { query: { type: "string" }, scope: { type: "string" }, contextLines: { type: "integer", minimum: 0, maximum: 5 } }, required: ["query"], additionalProperties: false } },
  SNAPSHOT_TOOLS[3] as HarnessToolDefinition,
  SNAPSHOT_TOOLS[4] as HarnessToolDefinition,
];

/** Built once for a snapshot, however many units read it. */
const symbolIndexes = new WeakMap<RepositorySnapshot["files"], SymbolIndex>();
function symbolIndexOf(snapshot: RepositorySnapshot): SymbolIndex {
  const known = symbolIndexes.get(snapshot.files);
  if (known !== undefined) return known;
  const index = buildSymbolIndex(snapshot.files.map(({ path, lines }) => ({ path, lines })));
  symbolIndexes.set(snapshot.files, index);
  return index;
}

/** A call that audits some files of the snapshot and may read the rest: what it read beyond them, under its budget. */
export interface BeyondUnitPolicy {
  readonly unitPaths: ReadonlySet<string>;
  readonly maximumBytes: number;
  /** Offers the reading tools (`READING_TOOLS`). `unitSuppliedWhole`: the call was sent its files whole, so a result names their lines rather than repeat them. */
  readonly reading?: { readonly unitSuppliedWhole: boolean };
}
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
 * activity's byte budget like every result. With `beyondUnit.reading`, a symbol lookup and a search with context also
 * deliver lines: each block of another file is charged to the same budget and recorded as a read, so it can be cited,
 * and a block the budget cannot hold is named by where it is.
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
    ...(beyondUnit?.reading === undefined ? {} : { symbols: () => symbolIndexOf(snapshot) }),
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
  const deliverLines = (policy: BeyondUnitPolicy, { path, startLine, endLine, bytes }: LinesToDeliver): LineDelivery => {
    if (policy.unitPaths.has(path)) return policy.reading?.unitSuppliedWhole === true ? "supplied" : "deliver";
    if (bytes > policy.maximumBytes - beyond.bytes) { beyond.refused += 1; return "refused"; }
    beyond.bytes += bytes;
    beyond.reads.push({ path, startLine, endLine, bytes });
    return "deliver";
  };
  return { footprints, archive, readsBeyondUnit, runtime: { async invoke(name, args, context) {
    const reading = beyondUnit?.reading !== undefined;
    const lookup = name === "repo_symbol" && reading;
    if (!lookup && !Object.hasOwn(names, name)) return { ok: false, summary: "Tool unavailable", content: "Only declared snapshot tools are available.", artifact: null, truncated: false, trust: "untrusted", error: { code: "TOOL_NOT_ALLOWED", message: "Only declared snapshot tools are available." } };
    const tool = lookup ? "repo.symbol" : names[name as keyof typeof names];
    const argument = (key: string) => typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>)[key] : undefined;
    if (beyondUnit !== undefined && reading && (tool === "repo.symbol" || tool === "repo.search")) {
      // Lines charged for a result that then fails were never delivered, so they are neither spent nor citable.
      const before = { bytes: beyond.bytes, reads: beyond.reads.length };
      const asked = tool === "repo.search" && argument("contextLines") === undefined && typeof args === "object" && args !== null ? { ...args, contextLines: SEARCH_CONTEXT_LINES } : args;
      const result = await registry.invoke(tool, asked, { nodeId: context.nodeId, protect: context.protect, deliverLines: (lines) => deliverLines(beyondUnit, lines) });
      if (!result.ok) { beyond.bytes = before.bytes; beyond.reads.length = before.reads; }
      return result;
    }
    const path = argument("path");
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
