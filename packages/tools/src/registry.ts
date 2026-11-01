import { boundOutput, type ArtifactSink, NodeByteBudget } from "./bounded-output.js";
import { FootprintRecorder, type ExposureRange } from "./footprint/index.js";
import { symbolName, type SymbolDefinition } from "./repo/symbol-index.js";
import type { ReadArtifacts, ReadRepository, ResponseFormat, SearchHit } from "./repo/types.js";

export const READ_TOOL_NAMES = Object.freeze([
  "repo.listTree", "repo.readFile", "repo.search", "repo.stat", "repo.gitStatus",
  "repo.gitDiff", "repo.gitLog", "repo.readManifest", "artifact.read", "repo.symbol",
] as const);
export type ReadToolName = typeof READ_TOOL_NAMES[number];

/** Lines of a file a result would carry, before they are written into it. */
export interface LinesToDeliver { readonly path: string; readonly startLine: number; readonly endLine: number; readonly bytes: number }
/** deliver: show them. supplied: the caller already holds them, so only where they are. refused: their budget is spent. */
export type LineDelivery = "deliver" | "supplied" | "refused";

export interface ToolRuntimeContext {
  readonly nodeId: string;
  readonly responseFormat?: ResponseFormat;
  readonly maxCallBytes?: number;
  /** Mandatory security boundary: redact secrets, then frame the result as untrusted data. */
  readonly protect: (content: string, meta: { readonly sourceId: string; readonly path?: string }) => string;
  readonly moduleForPath?: (path: string) => string | null;
  readonly riskSurfacesForPath?: (path: string) => readonly string[];
  /** Asked for each block of lines a search with context or a symbol lookup would carry; all are delivered without it. */
  readonly deliverLines?: (lines: LinesToDeliver) => LineDelivery;
}

export interface ToolResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly content: string;
  readonly artifact: string | null;
  readonly truncated: boolean;
  readonly trust: "untrusted";
  readonly error?: { readonly code: string; readonly message: string };
}

interface RuntimeDependencies {
  readonly repository: ReadRepository;
  readonly artifacts: ReadArtifacts & ArtifactSink;
  readonly footprints: FootprintRecorder;
  readonly nodeBudgetBytes: number;
  readonly defaultCallBytes?: number;
}

interface Delivery {
  readonly raw: string;
  readonly summary: string;
  readonly sourceId: string;
  readonly path?: string;
  /** The lines a file read asked for, so a result cut at the size limit can say which of them it carries. */
  readonly lines?: { readonly start: number; readonly end: number };
  readonly exposures: readonly ExposureRange[];
}

export class ToolRegistry {
  readonly names = READ_TOOL_NAMES;
  private readonly budget: NodeByteBudget;
  private readonly maximumCallBytes: number;

  constructor(private readonly dependencies: RuntimeDependencies) {
    this.budget = new NodeByteBudget(dependencies.nodeBudgetBytes);
    this.maximumCallBytes = dependencies.defaultCallBytes ?? 8_192;
  }

  async invoke(name: string, args: unknown, context: ToolRuntimeContext): Promise<ToolResult> {
    if (!isReadToolName(name)) return errorResult("UNKNOWN_READ_TOOL", `Unknown tool ${name}; choose one of: ${READ_TOOL_NAMES.join(", ")}.`);
    try {
      const delivery = await this.execute(name, objectArgs(args), context);
      const limit = Math.min(context.maxCallBytes ?? this.maximumCallBytes, this.maximumCallBytes);
      const bounded = await boundOutput(delivery.raw, limit, delivery.summary, this.dependencies.artifacts);
      const carried = bounded.truncated ? wholeLines(bounded.preview, delivery) : { preview: bounded.preview, summary: bounded.summary };
      const protectedContent = context.protect(carried.preview, {
        sourceId: delivery.sourceId,
        ...(delivery.path === undefined ? {} : { path: delivery.path }),
      });
      this.budget.consume(context.nodeId, Buffer.byteLength(protectedContent));
      this.dependencies.footprints.recordExposure(context.nodeId, deliveredRanges(delivery, carried.preview));
      return Object.freeze({
        ok: true,
        summary: carried.summary,
        content: protectedContent,
        artifact: bounded.artifact,
        truncated: bounded.truncated,
        trust: "untrusted",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = message.split(":", 1)[0] ?? "TOOL_ERROR";
      return errorResult(code, instructive(message, name));
    }
  }

  private async execute(name: ReadToolName, args: Record<string, unknown>, context: ToolRuntimeContext): Promise<Delivery> {
    switch (name) {
      case "repo.listTree": {
        const scope = optionalString(args, "scope");
        const paths = await this.dependencies.repository.listTree(scope);
        return textDelivery(paths.join("\n"), `${paths.length} repository paths`, `tree:${scope ?? "."}`);
      }
      case "repo.readFile": return this.readFile(args, context, false);
      case "repo.readManifest": return this.readFile(args, context, true);
      case "repo.search": return this.search(args, context);
      case "repo.symbol": return this.symbol(args, context);
      case "repo.stat": {
        const path = requiredString(args, "path");
        const stat = await this.dependencies.repository.stat(path);
        return textDelivery(JSON.stringify({ path, ...stat }), `Metadata for ${path}`, `stat:${path}`, path);
      }
      case "repo.gitStatus": return textDelivery(await this.dependencies.repository.gitStatus(), "Git status", "git:status");
      case "repo.gitDiff": {
        const base = optionalString(args, "base");
        const head = optionalString(args, "head");
        return textDelivery(await this.dependencies.repository.gitDiff(base, head), "Git diff", `git:diff:${base ?? "working"}:${head ?? ""}`);
      }
      case "repo.gitLog": {
        const limit = optionalInteger(args, "limit");
        return textDelivery(await this.dependencies.repository.gitLog(limit), "Git log", `git:log:${limit ?? "default"}`);
      }
      case "artifact.read": {
        const ref = requiredString(args, "ref");
        const raw = await this.dependencies.artifacts.read(ref);
        return textDelivery(raw, `Artifact ${ref}`, ref);
      }
    }
  }

  private async readFile(args: Record<string, unknown>, context: ToolRuntimeContext, manifest: boolean): Promise<Delivery> {
    const path = requiredString(args, "path");
    const file = manifest
      ? await this.dependencies.repository.readManifest(path)
      : await this.dependencies.repository.readFile(path);
    const lines = file.content.split(/(?<=\n)/u);
    const startLine = optionalInteger(args, "startLine") ?? 1;
    const endLine = optionalInteger(args, "endLine") ?? lines.length;
    if (startLine < 1 || endLine < startLine) throw new Error("INVALID_LINE_RANGE: use 1-based lines with endLine >= startLine.");
    const startByte = Buffer.byteLength(lines.slice(0, startLine - 1).join(""));
    const raw = lines.slice(startLine - 1, endLine).join("");
    const endByte = startByte + Buffer.byteLength(raw);
    this.dependencies.footprints.recordRead(context.nodeId, {
      path,
      lineRanges: [{ start: startLine, end: Math.min(endLine, lines.length) }],
      bytesReturned: Buffer.byteLength(raw),
    });
    const module = context.moduleForPath?.(path);
    if (module !== undefined && module !== null) this.dependencies.footprints.recordModule(context.nodeId, module);
    for (const risk of context.riskSurfacesForPath?.(path) ?? []) this.dependencies.footprints.recordRiskSurface(context.nodeId, risk);
    return {
      raw,
      summary: `${path} lines ${startLine}-${Math.min(endLine, lines.length)}`,
      sourceId: `repo:${path}`,
      path,
      lines: { start: startLine, end: Math.min(endLine, lines.length) },
      exposures: [{ source: "repository", sourceId: `repo:${path}`, path, start: startByte, end: endByte }],
    };
  }

  private async search(args: Record<string, unknown>, context: ToolRuntimeContext): Promise<Delivery> {
    const query = requiredString(args, "query");
    const scope = optionalString(args, "scope") ?? ".";
    const hits = rankSearchHits(query, await this.dependencies.repository.search(query, scope));
    this.dependencies.footprints.recordSearch(context.nodeId, { query, scope, resultCount: hits.length });
    if (hits.length === 0) throw new Error("ZERO_RESULTS: 0 results; try a symbol name or narrow to a directory.");
    const contextLines = optionalInteger(args, "contextLines") ?? 0;
    if (contextLines < 0 || contextLines > MAXIMUM_CONTEXT_LINES) throw new Error(`INVALID_ARGUMENT:contextLines: use 0 to ${MAXIMUM_CONTEXT_LINES}.`);
    if (contextLines > 0) return this.searchWithContext(query, scope, hits, contextLines, context);
    const raw = hits.map((hit) => context.responseFormat === "detailed"
      ? `${hit.path}:${hit.line}:${hit.column}: ${hit.text}` : `${hit.path}:${hit.line}`).join("\n");
    return {
      raw,
      summary: `${hits.length} ranked results for ${JSON.stringify(query)} in ${scope}`,
      sourceId: `search:${scope}:${query}`,
      exposures: hits.map((hit) => ({
        source: "repository", sourceId: `repo:${hit.path}`, path: hit.path,
        start: hit.startByte, end: hit.endByte,
      })),
    };
  }

  /** Hits with the lines around them, then bare locations once MAXIMUM_HITS_WITH_TEXT are shown: a name and its
   * surroundings come in one turn, where a bare location takes a read in the next. */
  private async searchWithContext(query: string, scope: string, hits: readonly SearchHit[], contextLines: number, context: ToolRuntimeContext): Promise<Delivery> {
    const blocks = new LineBlocks(this.callLimit(context), context, this.dependencies.footprints);
    const shown = hits.slice(0, MAXIMUM_HITS_WITH_TEXT);
    for (const path of [...new Set(shown.map((hit) => hit.path))]) {
      const lines = (await this.dependencies.repository.readFile(path)).content.split("\n");
      const ranges: { start: number; end: number; hits: Set<number> }[] = [];
      for (const line of [...new Set(shown.filter((hit) => hit.path === path).map((hit) => hit.line))].sort((a, b) => a - b)) {
        const last = ranges.at(-1);
        const start = Math.max(1, line - contextLines); const end = Math.min(lines.length, line + contextLines);
        if (last !== undefined && start <= last.end + 1) { last.end = end; last.hits.add(line); } else ranges.push({ start, end, hits: new Set([line]) });
      }
      blocks.write(path);
      for (const range of ranges) blocks.lines(path, lines, range.start, range.end, range.hits, MAXIMUM_SHOWN_LINE_BYTES);
    }
    for (const hit of hits.slice(MAXIMUM_HITS_WITH_TEXT)) blocks.write(`${hit.path}:${hit.line}`);
    return { raw: blocks.text(), summary: `${hits.length} ranked results for ${JSON.stringify(query)} in ${scope}`, sourceId: `search:${scope}:${query}`, exposures: blocks.exposures };
  }

  /** For each name, its definitions with their bodies and where it is used. It takes several names, so one turn answers them all. */
  private async symbol(args: Record<string, unknown>, context: ToolRuntimeContext): Promise<Delivery> {
    const asked: unknown = args["names"];
    if (!Array.isArray(asked) || asked.length === 0 || asked.length > MAXIMUM_SYMBOL_NAMES || !asked.every((name): name is string => typeof name === "string" && name.trim().length > 0)) throw new Error(`INVALID_ARGUMENT:names: provide 1 to ${MAXIMUM_SYMBOL_NAMES} names.`);
    const index = this.dependencies.repository.symbols?.();
    if (index === undefined) throw new Error("SYMBOL_INDEX_UNAVAILABLE: use repo.search.");
    const scope = optionalString(args, "scope") ?? ".";
    const inScope = (path: string) => scope === "." || path === scope || path.startsWith(`${scope.replace(/\/$/u, "")}/`);
    const blocks = new LineBlocks(this.callLimit(context), context, this.dependencies.footprints);
    const names = [...new Set((asked as readonly string[]).map((name) => name.trim()))];
    let found = 0;
    for (const raw of names) {
      const name = symbolName(raw);
      const definitions = name === null ? [] : mergedClauses(index.definitions(name).filter(({ path }) => inScope(path)));
      const references = name === null ? [] : index.references(name).filter(({ path }) => inScope(path));
      blocks.write(`== ${raw}`);
      for (const [position, { path, startLine, endLine, cut }] of definitions.entries()) {
        blocks.write(`definition ${path}:${startLine}-${endLine}`);
        if (position >= MAXIMUM_DEFINITIONS_SHOWN) continue;
        blocks.lines(path, index.linesOf(path) ?? [], startLine, endLine, null, Number.POSITIVE_INFINITY);
        if (cut) blocks.write(`(it runs on: read on from line ${endLine + 1})`);
      }
      // A name no definition or word matches may still be text: a language the index does not know, or several words.
      const literal = definitions.length === 0 && references.length === 0 ? await this.dependencies.repository.search(raw, scope) : [];
      const used = literal.length > 0 ? literal.map(({ path, line }) => ({ path, line })) : references;
      if (definitions.length === 0) blocks.write(used.length === 0 ? "no definition and no use found" : "no definition recognised: these lines mention it");
      if (used.length > 0) blocks.write(`references ${Math.min(used.length, MAXIMUM_REFERENCES_SHOWN)} of ${used.length}${used.length > MAXIMUM_REFERENCES_SHOWN ? ": ask with a scope, or search, for the rest" : ""}`);
      for (const { path, line } of used.slice(0, MAXIMUM_REFERENCES_SHOWN)) blocks.reference(path, index.linesOf(path) ?? [], line);
      found += definitions.length + used.length;
      this.dependencies.footprints.recordSearch(context.nodeId, { query: `symbol:${raw}`, scope, resultCount: definitions.length + used.length });
    }
    if (found === 0) throw new Error("ZERO_RESULTS: 0 results; check the spelling, or search for the text with repo_search.");
    return { raw: blocks.text(), summary: `${found} definitions and references for ${names.length} name${names.length === 1 ? "" : "s"} in ${scope}`, sourceId: `symbol:${scope}:${names.join(",")}`, exposures: blocks.exposures };
  }

  private callLimit(context: ToolRuntimeContext): number { return Math.min(context.maxCallBytes ?? this.maximumCallBytes, this.maximumCallBytes); }
}

export const MAXIMUM_SYMBOL_NAMES = 8;
const MAXIMUM_CONTEXT_LINES = 5;
const MAXIMUM_HITS_WITH_TEXT = 40;
const MAXIMUM_DEFINITIONS_SHOWN = 5;
const MAXIMUM_REFERENCES_SHOWN = 30;
/** A longer line is minified or data: a reference or a search's context gives only where it is. */
const MAXIMUM_SHOWN_LINE_BYTES = 1_000;
/** Room kept in a result for saying what was left out. */
const RESULT_TRAILER_BYTES = 400;

/** Definitions in one file with at most a blank line between them are clauses of one function, shown as one block. */
function mergedClauses(definitions: readonly SymbolDefinition[]): readonly SymbolDefinition[] {
  const merged: SymbolDefinition[] = [];
  for (const definition of definitions) {
    const last = merged.at(-1);
    if (last?.path === definition.path && definition.startLine <= last.endLine + 2) merged[merged.length - 1] = { ...last, endLine: Math.max(last.endLine, definition.endLine), cut: definition.cut };
    else merged.push(definition);
  }
  return merged;
}

/**
 * The text of a result built from whole lines of source. It stays within its limit by leaving out whole blocks, each
 * named by where it is, so it is never cut in the middle: every line shown is one the model can cite.
 */
class LineBlocks {
  readonly #parts: string[] = [];
  #used = 0; #refused = 0; #left = 0;
  readonly exposures: ExposureRange[] = [];
  constructor(private readonly limit: number, private readonly context: ToolRuntimeContext, private readonly footprints: FootprintRecorder) {}

  write(line: string): void {
    const bytes = Buffer.byteLength(line) + 1;
    if (this.#used + bytes > this.limit - RESULT_TRAILER_BYTES) { this.#left += 1; return; }
    this.#parts.push(line); this.#used += bytes;
  }

  /** Lines `start` to `end` (1-based), each with its number: a hit or a body as `12:`, a line of context as `12-`. */
  lines(path: string, lines: readonly string[], start: number, end: number, hits: ReadonlySet<number> | null, longestLine: number): void {
    const selected = lines.slice(start - 1, end);
    const location = start === end ? `${path}:${start}` : `${path}:${start}-${end}`;
    const formatted = selected.map((text, index) => `${start + index}${hits === null || hits.has(start + index) ? ":" : "-"} ${text}`);
    const bytes = formatted.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
    if (selected.some((text) => Buffer.byteLength(text) > longestLine) || this.#used + bytes > this.limit - RESULT_TRAILER_BYTES) { this.write(`${location} (too long for this result: read it by line range)`); return; }
    if (!this.#delivered(path, lines, start, end, location)) return;
    for (const line of formatted) this.write(line);
  }

  /** One line of use, as `path:line: text`. */
  reference(path: string, lines: readonly string[], line: number): void {
    const text = lines[line - 1] ?? "";
    const location = `${path}:${line}`;
    if (Buffer.byteLength(text) > MAXIMUM_SHOWN_LINE_BYTES || this.#used + Buffer.byteLength(text) + Buffer.byteLength(location) + 3 > this.limit - RESULT_TRAILER_BYTES) { this.write(location); return; }
    if (this.#delivered(path, lines, line, line, location)) this.write(`${location}: ${text.trim()}`);
  }

  #delivered(path: string, lines: readonly string[], start: number, end: number, location: string): boolean {
    const startByte = lines.slice(0, start - 1).reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
    const size = lines.slice(start - 1, end).reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
    const delivery = this.context.deliverLines?.({ path, startLine: start, endLine: end, bytes: size }) ?? "deliver";
    if (delivery === "supplied") { this.write(`${location} (in the source you were given)`); return false; }
    if (delivery === "refused") { this.#refused += 1; this.write(location); return false; }
    this.exposures.push({ source: "repository", sourceId: `repo:${path}`, path, start: startByte, end: startByte + Math.max(0, size - 1) });
    this.footprints.recordRead(this.context.nodeId, { path, lineRanges: [{ start, end }], bytesReturned: size });
    return true;
  }

  text(): string {
    return [...this.#parts,
      ...(this.#left === 0 ? [] : [`${this.#left} more lines of this result did not fit: ask for fewer names, or narrow by scope.`]),
      ...(this.#refused === 0 ? [] : [`${this.#refused} blocks are named but not shown: the budget for reading outside your source is spent. Conclude from what you have read, and name what you could not read as a limitation.`]),
    ].join("\n");
  }
}

export function rankSearchHits(query: string, hits: readonly SearchHit[]): readonly SearchHit[] {
  const symbol = new RegExp(`(?:^|[^A-Za-z0-9_$])${escapeRegExp(query)}(?:$|[^A-Za-z0-9_$])`, "u");
  return Object.freeze([...hits].sort((left, right) => {
    const leftScore = (symbol.test(left.text) ? 4 : 0) + (left.path.split(/[\\/]/u).at(-1)?.includes(query) ? 2 : 0);
    const rightScore = (symbol.test(right.text) ? 4 : 0) + (right.path.split(/[\\/]/u).at(-1)?.includes(query) ? 2 : 0);
    return rightScore - leftScore || left.path.localeCompare(right.path) || left.line - right.line;
  }));
}

/** A file read cut at the size limit ends on a whole line and says which lines it carries and where to read on.
 * Observed live (P20 pilot): a result cut in the middle of a line still read "lines 1-292", and the model asked
 * for the file again from a guessed line, a second call that resent its whole prompt. */
function wholeLines(preview: string, delivery: Delivery): { preview: string; summary: string } {
  const cut = preview.lastIndexOf("\n");
  if (delivery.lines === undefined || delivery.path === undefined || cut < 0) return { preview, summary: `${delivery.summary}, cut at the size limit` };
  const whole = preview.slice(0, cut + 1); const last = delivery.lines.start + (whole.match(/\n/gu) ?? []).length - 1;
  return { preview: whole, summary: `${delivery.path} lines ${delivery.lines.start}-${last} of the ${delivery.lines.start}-${delivery.lines.end} asked for, cut at the size limit: read on from line ${last + 1}` };
}

function deliveredRanges(delivery: Delivery, preview: string): readonly ExposureRange[] {
  if (Buffer.byteLength(preview) >= Buffer.byteLength(delivery.raw)) return delivery.exposures;
  if (delivery.exposures.length !== 1) return [];
  const range = delivery.exposures[0];
  if (range === undefined) return [];
  return [Object.freeze({ ...range, end: Math.min(range.end, range.start + Buffer.byteLength(preview)) })];
}

function textDelivery(raw: string, summary: string, sourceId: string, path?: string): Delivery {
  return {
    raw, summary, sourceId, ...(path === undefined ? {} : { path }),
    exposures: [{ source: sourceId.startsWith("artifacts/") ? "artifact" : "tool", sourceId,
      ...(path === undefined ? {} : { path }), start: 0, end: Buffer.byteLength(raw) }],
  };
}

function isReadToolName(value: string): value is ReadToolName { return (READ_TOOL_NAMES as readonly string[]).includes(value); }
function objectArgs(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("INVALID_ARGUMENTS: pass a JSON object.");
  return value as Record<string, unknown>;
}
function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`INVALID_ARGUMENT:${key}: provide a non-empty string.`);
  return value;
}
function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`INVALID_ARGUMENT:${key}: provide a string.`);
  return value;
}
function optionalInteger(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) throw new Error(`INVALID_ARGUMENT:${key}: provide an integer.`);
  return value as number;
}
function errorResult(code: string, message: string): ToolResult {
  return Object.freeze({ ok: false, summary: message, content: "", artifact: null, truncated: false,
    trust: "untrusted", error: Object.freeze({ code, message }) });
}
function instructive(message: string, name: ReadToolName): string {
  if (message.includes("ZERO_RESULTS") || message.includes("NODE_BYTE_BUDGET")) return message.replace(/^[^:]+:\s*/u, "");
  return `${message} Tool ${name} made no delivery; check the path/scope and request a narrower range.`;
}
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }
