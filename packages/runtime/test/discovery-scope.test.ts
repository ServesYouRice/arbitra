import { describe, expect, it } from "vitest";
import { allocateDiscoveryScopes } from "../src/discovery-scope.js";

const file = (path: string, content = "export const value = 1;") => ({ path, lines: content.split("\n"), byteLength: Buffer.byteLength(content), lineStartBytes: [0] });

describe("discovery scope allocation", () => {
  it("keeps cross-directory import chains together instead of partitioning by directory", () => {
    const files = [file("ui/a.ts", "import { value } from '../data/b.js';"), file("data/b.ts"), file("other/c.ts")];
    const result = allocateDiscoveryScopes({ root: "fixture", files }, (selected) => selected.length <= 2);
    expect(result.scopes.some(({ files }) => files.map(({ path }) => path).sort().join() === "data/b.ts,ui/a.ts")).toBe(true);
    expect(result.scopes.flatMap(({ splitModules }) => splitModules)).toEqual([]);
    expect(result.unallocatedPaths).toEqual([]);
  });

  it("reports split modules and oversized files without dropping unsupported source extensions", () => {
    const files = [file("ui/a.ts", "import '../data/b.js';"), file("data/b.ts"), file("theme.css"), file("huge.ts", "x".repeat(200))];
    const result = allocateDiscoveryScopes({ root: "fixture", files }, (selected) => selected.length <= 1 && selected.every(({ byteLength }) => byteLength < 100));
    expect(result.scopes.flatMap(({ files }) => files.map(({ path }) => path)).sort()).toEqual(["data/b.ts", "theme.css", "ui/a.ts"]);
    expect(result.scopes.flatMap(({ splitModules }) => splitModules)).toHaveLength(2);
    expect(result.unallocatedPaths).toEqual(["huge.ts"]);
  });
});
