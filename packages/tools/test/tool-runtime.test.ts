import { describe, expect, it } from "vitest";

import { MemoryArtifactSink } from "../src/bounded-output.js";
import { validateEvidence } from "../src/evidence.js";
import { FootprintRecorder } from "../src/footprint/index.js";
import { READ_TOOL_NAMES, ToolRegistry, type ToolRuntimeContext } from "../src/registry.js";
import type { ReadArtifacts, ReadRepository, RepositoryFile, SearchHit } from "../src/repo/types.js";

describe("canonical read tool runtime", () => {
  it("registers exactly the nine v1 read tools", () => {
    expect(READ_TOOL_NAMES).toEqual([
      "repo.listTree", "repo.readFile", "repo.search", "repo.stat", "repo.gitStatus",
      "repo.gitDiff", "repo.gitLog", "repo.readManifest", "artifact.read",
    ]);
    expect(READ_TOOL_NAMES.every((name) => !/write|shell|delete|patch/iu.test(name))).toBe(true);
  });

  it("truncates a large file, protects its preview and preserves resolvable overflow", async () => {
    const fixture = makeRuntime({ "large.ts": "const value = 'TOKEN';\n".repeat(100) }, 20_000);
    const result = await fixture.registry.invoke("repo.readFile", { path: "large.ts" }, context("node-a", 80));
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
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

  it("rejects evidence outside the quoting node exposure footprint", async () => {
    const fixture = makeRuntime({ "src/auth.ts": "0123456789abcdefghij" }, 10_000);
    await fixture.registry.invoke("repo.readFile", { path: "src/auth.ts" }, context("auditor-1"));
    const footprint = fixture.footprints.exposure("auditor-1");
    expect(validateEvidence({ sourceId: "repo:src/auth.ts", path: "src/auth.ts", start: 2, end: 8 }, footprint)).toEqual({ valid: true });
    expect(validateEvidence({ sourceId: "repo:src/auth.ts", path: "src/auth.ts", start: 18, end: 30 }, footprint)).toMatchObject({
      valid: false, code: "OUTSIDE_EXPOSURE_FOOTPRINT",
    });
    expect(validateEvidence({ sourceId: "repo:src/auth.ts", path: "src/auth.ts", start: 0, end: 1 }, fixture.footprints.exposure("auditor-2"))).toMatchObject({ valid: false });
  });
});

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
}
