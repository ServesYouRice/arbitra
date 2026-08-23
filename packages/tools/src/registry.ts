import { boundOutput, type ArtifactSink, NodeByteBudget } from "./bounded-output.js";
import { FootprintRecorder, type ExposureRange } from "./footprint/index.js";
import type { ReadArtifacts, ReadRepository, ResponseFormat, SearchHit } from "./repo/types.js";

export const READ_TOOL_NAMES = Object.freeze([
  "repo.listTree", "repo.readFile", "repo.search", "repo.stat", "repo.gitStatus",
  "repo.gitDiff", "repo.gitLog", "repo.readManifest", "artifact.read",
] as const);
export type ReadToolName = typeof READ_TOOL_NAMES[number];

export interface ToolRuntimeContext {
  readonly nodeId: string;
  readonly responseFormat?: ResponseFormat;
  readonly maxCallBytes?: number;
  /** Mandatory security boundary: redact secrets, then frame the result as untrusted data. */
  readonly protect: (content: string, meta: { readonly sourceId: string; readonly path?: string }) => string;
  readonly moduleForPath?: (path: string) => string | null;
  readonly riskSurfacesForPath?: (path: string) => readonly string[];
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
      const protectedContent = context.protect(bounded.preview, {
        sourceId: delivery.sourceId,
        ...(delivery.path === undefined ? {} : { path: delivery.path }),
      });
      this.budget.consume(context.nodeId, Buffer.byteLength(protectedContent));
      this.dependencies.footprints.recordExposure(context.nodeId, deliveredRanges(delivery, bounded.preview));
      return Object.freeze({
        ok: true,
        summary: bounded.summary,
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
      exposures: [{ source: "repository", sourceId: `repo:${path}`, path, start: startByte, end: endByte }],
    };
  }

  private async search(args: Record<string, unknown>, context: ToolRuntimeContext): Promise<Delivery> {
    const query = requiredString(args, "query");
    const scope = optionalString(args, "scope") ?? ".";
    const hits = rankSearchHits(query, await this.dependencies.repository.search(query, scope));
    this.dependencies.footprints.recordSearch(context.nodeId, { query, scope, resultCount: hits.length });
    if (hits.length === 0) throw new Error("ZERO_RESULTS: 0 results; try a symbol name or narrow to a directory.");
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
}

export function rankSearchHits(query: string, hits: readonly SearchHit[]): readonly SearchHit[] {
  const symbol = new RegExp(`(?:^|[^A-Za-z0-9_$])${escapeRegExp(query)}(?:$|[^A-Za-z0-9_$])`, "u");
  return Object.freeze([...hits].sort((left, right) => {
    const leftScore = (symbol.test(left.text) ? 4 : 0) + (left.path.split(/[\\/]/u).at(-1)?.includes(query) ? 2 : 0);
    const rightScore = (symbol.test(right.text) ? 4 : 0) + (right.path.split(/[\\/]/u).at(-1)?.includes(query) ? 2 : 0);
    return rightScore - leftScore || left.path.localeCompare(right.path) || left.line - right.line;
  }));
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
