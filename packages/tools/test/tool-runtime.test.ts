import { describe, expect, it, vi } from "vitest";

import { MemoryArtifactSink } from "../src/bounded-output.js";
import { FootprintRecorder } from "../src/footprint/index.js";
import { READ_TOOL_NAMES, ToolRegistry, type LinesToDeliver, type ToolRuntimeContext } from "../src/registry.js";
import { buildSymbolIndex } from "../src/repo/symbol-index.js";
import type { ReadArtifacts, ReadRepository, RepositoryFile, SearchHit } from "../src/repo/types.js";

describe("canonical read tool runtime", () => {
  it("registers exactly the read tools: the nine of v1 and the symbol lookup", () => {
    expect(READ_TOOL_NAMES).toEqual([
      "repo.listTree", "repo.readFile", "repo.search", "repo.stat", "repo.gitStatus",
      "repo.gitDiff", "repo.gitLog", "repo.readManifest", "artifact.read", "repo.symbol",
    ]);
    expect(READ_TOOL_NAMES.every((name) => !/write|shell|delete|patch/iu.test(name))).toBe(true);
  });

  it("truncates a large file, protects its preview and preserves resolvable overflow", async () => {
    const fixture = makeRuntime({ "large.ts": "const value = 'TOKEN';\n".repeat(100) }, 20_000);
    const result = await fixture.registry.invoke("repo.readFile", { path: "large.ts" }, context("node-a", 80));
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    // The cut falls on a line end, and the summary says which lines came and where to read on.
    expect(result.summary).toBe("large.ts lines 1-3 of the 1-100 asked for, cut at the size limit: read on from line 4");
    const rest = await fixture.registry.invoke("repo.readFile", { path: "large.ts", startLine: 4, endLine: 5 }, context("node-a", 80));
    expect(rest).toMatchObject({ ok: true, truncated: false, summary: "large.ts lines 4-5" });
    expect(result.artifact).toMatch(/^artifacts\/[a-f0-9]{64}\.txt$/u);
    expect(await fixture.artifacts.read(result.artifact ?? "")).toContain("TOKEN");
    expect(result.content).toContain("<untrusted source=");
    expect(result.content).not.toContain("TOKEN");
    expect(fixture.footprints.exposure("node-a").ranges[0]).toMatchObject({
      sourceId: "repo:large.ts", path: "large.ts", start: 0,
    });
  });

  it("refuses cumulative small reads beyond the per-node budget with an actionable error", async () => {
    const fixture = makeRuntime({ "small.ts": "1234567890" }, 120);
    let refused = false;
    for (let index = 0; index < 10; index += 1) {
      const result = await fixture.registry.invoke("repo.readFile", { path: "small.ts" }, context("node-budget", 100));
      if (!result.ok) {
        expect(result.error?.code).toBe("NODE_BYTE_BUDGET_EXCEEDED");
        expect(result.error?.message).toMatch(/remaining|narrow/iu);
        refused = true;
        break;
      }
    }
    expect(refused).toBe(true);
  });

  it("keeps searched and read inspections distinct and returns instructive zero-result errors", async () => {
    const fixture = makeRuntime({ "src/auth.ts": "export function authorize() {}\n" }, 10_000);
    const searched = await fixture.registry.invoke("repo.search", { query: "authorize", scope: "src" }, context("node-inspect"));
    const read = await fixture.registry.invoke("repo.readFile", { path: "src/auth.ts", startLine: 1, endLine: 1 }, context("node-inspect"));
    const missing = await fixture.registry.invoke("repo.search", { query: "missing", scope: "." }, context("node-inspect"));
    expect(searched.ok).toBe(true);
    expect(read.ok).toBe(true);
    expect(missing.error?.message).toContain("try a symbol name or narrow to a directory");
    expect(fixture.footprints.inspection("node-inspect")).toMatchObject({
      reads: [{ path: "src/auth.ts", lineRanges: [{ start: 1, end: 1 }] }],
      searches: [
        { query: "authorize", scope: "src", resultCount: 1 },
        { query: "missing", scope: ".", resultCount: 0 },
      ],
    });
  });

  describe("a search with lines of context", () => {
    const source = { "a.ts": ["one", "two", "three target", "four", "five", "six", "seven target", "eight"].join("\n") };
    const lines = source["a.ts"].split("\n");

    it("stays a list of locations unless context is asked for", async () => {
      const fixture = makeRuntime(source, 10_000);
      const result = await fixture.registry.invoke("repo.search", { query: "target" }, { ...context("n"), responseFormat: "concise" });
      expect(result.content).toContain("a.ts:1");
      expect(result.content).not.toContain("three");
    });

    it("shows each hit numbered with its context, joining what overlaps, and records the lines as read and exposed", async () => {
      const search = vi.spyOn(MemoryRepository.prototype, "search").mockResolvedValueOnce([hit("a.ts", 3, lines), hit("a.ts", 7, lines)]);
      const fixture = makeRuntime(source, 10_000);
      const result = await fixture.registry.invoke("repo.search", { query: "target", contextLines: 2 }, context("n"));
      search.mockRestore();
      expect(result.content).toContain(["a.ts", "1- one", "2- two", "3: three target", "4- four", "5- five", "6- six", "7: seven target", "8- eight"].join("\n"));
      expect(fixture.footprints.inspection("n").reads).toMatchObject([{ path: "a.ts", lineRanges: [{ start: 1, end: 8 }] }]);
      expect(fixture.footprints.exposure("n").ranges).toMatchObject([{ path: "a.ts", start: 0, end: Buffer.byteLength(source["a.ts"]) }]);
    });

    it("gives only locations for lines the caller holds, and for lines it has no budget for, without counting them read", async () => {
      const search = vi.spyOn(MemoryRepository.prototype, "search").mockResolvedValue([hit("a.ts", 3, lines)]);
      const fixture = makeRuntime(source, 10_000);
      const asked: LinesToDeliver[] = [];
      const supplied = await fixture.registry.invoke("repo.search", { query: "target", contextLines: 1 }, { ...context("n"), deliverLines(block) { asked.push(block); return "supplied"; } });
      expect(asked).toEqual([{ path: "a.ts", startLine: 2, endLine: 4, bytes: Buffer.byteLength("two\nthree target\nfour\n") }]);
      expect(supplied.content).toContain("a.ts:2-4 (in the source you were given)");
      expect(supplied.content).not.toContain("three");
      const refused = await fixture.registry.invoke("repo.search", { query: "target", contextLines: 1 }, { ...context("n"), deliverLines: () => "refused" });
      search.mockRestore();
      expect(refused.content).toContain("a.ts:2-4");
      expect(refused.content).toContain("budget for reading outside your source is spent");
      expect(refused.content).not.toContain("three");
      expect(fixture.footprints.inspection("n").reads).toEqual([]);
    });

    it("refuses more context than it allows", async () => {
      const fixture = makeRuntime(source, 10_000);
      expect(await fixture.registry.invoke("repo.search", { query: "target", contextLines: 6 }, context("n"))).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
    });
  });

  describe("a symbol lookup", () => {
    const files = {
      "src/rooms.ts": ["export function closeRoom(id: string) {", "  return store.close(id); // TOKEN", "}"].join("\n"),
      "src/page.ts": ["import { closeRoom } from './rooms';", "closeRoom('a');"].join("\n"),
      "src/other.ts": ["export const other = () => {", "  return 1;", "};"].join("\n"),
    };

    it("answers several names in one call with bodies and references, protected like every result", async () => {
      const fixture = makeRuntime(files, 10_000);
      const result = await fixture.registry.invoke("repo.symbol", { names: ["closeRoom", "other"] }, context("n"));
      expect(result.ok).toBe(true);
      expect(result.truncated).toBe(false);
      expect(result.content).toContain(["== closeRoom", "definition src/rooms.ts:1-3", "1: export function closeRoom(id: string) {", "2:   return store.close(id); // [REDACTED]", "3: }", "references 2 of 2", "src/page.ts:1: import { closeRoom } from './rooms';", "src/page.ts:2: closeRoom('a');"].join("\n"));
      expect(result.content).toContain("definition src/other.ts:1-3");
      expect(result.content).not.toContain("TOKEN");
      expect(result.content).toContain("<untrusted source=");
      const inspection = fixture.footprints.inspection("n");
      expect(inspection.searches).toEqual([{ query: "symbol:closeRoom", scope: ".", resultCount: 3 }, { query: "symbol:other", scope: ".", resultCount: 1 }]);
      expect(inspection.reads.map(({ path }) => path).sort()).toEqual(["src/other.ts", "src/page.ts", "src/page.ts", "src/rooms.ts"]);
    });

    it("keeps to a scope and takes the name out of a call or a qualified name", async () => {
      const fixture = makeRuntime(files, 10_000);
      const result = await fixture.registry.invoke("repo.symbol", { names: ["Rooms.closeRoom("], scope: "src/page.ts" }, context("n"));
      expect(result.content).toContain("no definition recognised");
      expect(result.content).not.toContain("src/rooms.ts");
      expect(result.content).toContain("src/page.ts:2: closeRoom('a');");
    });

    it("falls back to the literal search for text of no known language, and says when nothing matches at all", async () => {
      const fixture = makeRuntime({ ...files, "notes.zzz": "see POST /rooms/close" }, 10_000);
      const literal = await fixture.registry.invoke("repo.symbol", { names: ["POST /rooms/close", "nothingAnywhere"] }, context("n"));
      expect(literal.content).toContain("no definition recognised");
      expect(literal.content).toContain("notes.zzz:1: see POST /rooms/close");
      expect(literal.content).toContain("no definition and no use found");
      expect(await fixture.registry.invoke("repo.symbol", { names: ["nothingAnywhere"] }, context("n"))).toMatchObject({ ok: false, error: { code: "ZERO_RESULTS" } });
    });

    it("leaves out whole blocks rather than cut a line, within the limit of one result", async () => {
      const big = Array.from({ length: 150 }, (_, index) => `  const value${index} = ${index};`);
      const fixture = makeRuntime({ "big.ts": ["function huge() {", ...big, "}"].join("\n"), "use.ts": "huge();" }, 100_000);
      const result = await fixture.registry.invoke("repo.symbol", { names: ["huge"] }, context("n", 1_000));
      expect(result.truncated).toBe(false);
      expect(result.artifact).toBeNull();
      expect(result.content).toContain("big.ts:1-152 (too long for this result: read it by line range)");
      expect(result.content).toContain("use.ts:1: huge();");
      expect(fixture.footprints.inspection("n").reads.map(({ path }) => path)).toEqual(["use.ts"]);
    });

    it("holds at most eight names", async () => {
      const fixture = makeRuntime(files, 10_000);
      expect(await fixture.registry.invoke("repo.symbol", { names: Array.from({ length: 9 }, (_, index) => `n${index}`) }, context("n"))).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
      expect(await fixture.registry.invoke("repo.symbol", { names: [] }, context("n"))).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
      expect(await fixture.registry.invoke("repo.symbol", { names: 1 }, context("n"))).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
    });
  });
});

function hit(path: string, line: number, lines: readonly string[]): SearchHit {
  return { path, line, column: 1, text: lines[line - 1] ?? "", startByte: 0, endByte: 1 };
}

function context(nodeId: string, maxCallBytes = 1_000): ToolRuntimeContext {
  return {
    nodeId,
    maxCallBytes,
    responseFormat: "detailed",
    protect(content, meta) {
      return `<untrusted source="${meta.sourceId}">${content.replaceAll("TOKEN", "[REDACTED]")}</untrusted>`;
    },
    moduleForPath: (path) => path.startsWith("src/") ? "application" : null,
    riskSurfacesForPath: (path) => path.includes("auth") ? ["authentication"] : [],
  };
}

function makeRuntime(files: Readonly<Record<string, string>>, nodeBudgetBytes: number) {
  const repository = new MemoryRepository(files);
  const artifacts = new ReadableMemoryArtifacts();
  const footprints = new FootprintRecorder();
  return {
    artifacts,
    footprints,
    registry: new ToolRegistry({ repository, artifacts, footprints, nodeBudgetBytes, defaultCallBytes: 1_000 }),
  };
}

class ReadableMemoryArtifacts extends MemoryArtifactSink implements ReadArtifacts {
  async read(ref: string): Promise<string> {
    const value = this.values.get(ref);
    if (value === undefined) throw new Error(`ARTIFACT_NOT_FOUND:${ref}`);
    return value;
  }
}

class MemoryRepository implements ReadRepository {
  constructor(private readonly files: Readonly<Record<string, string>>) {}
  async listTree(scope = ".") { return Object.keys(this.files).filter((path) => scope === "." || path.startsWith(scope)).sort(); }
  async readFile(path: string): Promise<RepositoryFile> {
    const content = this.files[path];
    if (content === undefined) throw new Error(`FILE_NOT_FOUND:${path}`);
    return { path, content, size: Buffer.byteLength(content), modifiedAt: null };
  }
  async readManifest(path: string) { return this.readFile(path); }
  async search(query: string, scope = "."): Promise<readonly SearchHit[]> {
    const hits: SearchHit[] = [];
    for (const [path, content] of Object.entries(this.files)) {
      if (scope !== "." && !path.startsWith(scope)) continue;
      const index = content.indexOf(query);
      if (index < 0) continue;
      hits.push({ path, line: 1, column: index + 1, text: content.trim(), startByte: index, endByte: index + Buffer.byteLength(query) });
    }
    return hits;
  }
  async stat(path: string) { const file = await this.readFile(path); return { size: file.size, modifiedAt: file.modifiedAt }; }
  async gitStatus() { return "clean"; }
  async gitDiff() { return "diff"; }
  async gitLog() { return "log"; }
  symbols() { return buildSymbolIndex(Object.entries(this.files).map(([path, content]) => ({ path, lines: content.split("\n") }))); }
}
