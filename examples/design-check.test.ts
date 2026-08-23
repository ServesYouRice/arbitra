import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The documentation gate for the normative presentation assets.
 *
 * `docs/DESIGN-LANGUAGE.md` and `docs/brand/` are inputs, not outputs: this suite reads
 * them and fails if the implementation has drifted from them. It never writes to either,
 * and it never restates the palette — the token file is the only source.
 */
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const brand = join(repository, "docs", "brand");
const PRODUCTION_MARKS = ["mark-triangle-icon-mono.svg", "mark-triangle-icon.svg", "mark-triangle-of-error-mono.svg", "mark-triangle-of-error.svg", "mark-triangle-reduction.svg"] as const;
const SEMANTIC_TOKENS = ["--brass", "--steel", "--verified", "--refuted", "--tainted", "--faint"] as const;

describe("design token integrity", () => {
  it("defines every semantic token in the shipped token file, in all three theme states", () => {
    const shipped = read("apps/web/src/tokens.css");
    const light = shipped.slice(0, shipped.indexOf("@media (prefers-color-scheme: dark)"));
    const dark = shipped.slice(shipped.indexOf("@media (prefers-color-scheme: dark)"), shipped.indexOf('[data-theme="dark"]'));
    const explicit = shipped.slice(shipped.indexOf(':root[data-theme="dark"]'));
    for (const token of SEMANTIC_TOKENS) {
      if (token === "--faint") continue;
      for (const [name, block] of [["light", light], ["prefers-dark", dark], ["data-theme dark", explicit]] as const) expect(`${name}:${token}:${block.includes(`${token}:`)}`).toBe(`${name}:${token}:true`);
    }
    expect(light).toContain("--faint:");
    expect(dark).toContain("--faint:");
    expect(explicit).toContain("--faint:");
  });

  it("carries every token name the normative source defines and adds none of its own", () => {
    expect(names(read("docs/brand/tokens.css"))).toEqual(names(read("apps/web/src/tokens.css")));
  });

  it("encodes severity as stripe width rather than hue", () => {
    const shipped = read("apps/web/src/tokens.css");
    for (const [severity, width] of [["critical", "5px"], ["high", "4px"], ["medium", "3px"], ["low", "2px"]] as const) {
      expect(`${severity}:${new RegExp(`\\[data-severity="${severity}"\\]\\s*\\{\\s*--stripe:\\s*${width};`, "u").test(shipped)}`).toBe(`${severity}:true`);
    }
    expect(/\[data-severity="[a-z]+"\]\s*\{[^}]*color\s*:/u.test(shipped)).toBe(false);
  });

  it("keeps raw colour literals out of every stylesheet except the token source", () => {
    for (const path of stylesheets()) {
      if (path.endsWith("tokens.css")) continue;
      expect(`${path}:${/#[0-9a-f]{3,8}\b/iu.test(read(path))}`).toBe(`${path}:false`);
    }
  });

  it("registers the no-raw-color rule against the web sources", () => {
    const config = read("eslint.config.js");
    expect(config).toContain("./tooling/eslint-rules/no-raw-color.cjs");
    expect(config).toContain('"arbitra/no-raw-color": "error"');
    expect(config).toContain('files: ["apps/web/src/**/*.{js,jsx,ts,tsx}"]');
  });
});

describe("shared glyph module integrity", () => {
  it("ships exactly one typed glyph table, byte-identical to the normative source", () => {
    expect(hash("packages/schemas/src/glyphs.ts")).toBe(hash("docs/brand/glyphs.ts"));
  });

  it("is imported rather than redeclared by every consumer", () => {
    for (const path of sources()) {
      if (path.endsWith("packages/schemas/src/glyphs.ts") || path.endsWith("docs/brand/glyphs.ts")) continue;
      const source = read(path);
      expect(`${path}:${/(?:const|let|var)\s+NODE_GLYPHS\b/u.test(source)}`).toBe(`${path}:false`);
      expect(`${path}:${/(?:const|let|var)\s+STATE_TOKENS\b/u.test(source)}`).toBe(`${path}:false`);
    }
  });

  it("keeps the node taxonomy closed at six kinds and the state vocabulary at six states", () => {
    const glyphs = read("packages/schemas/src/glyphs.ts");
    expect(glyphs.match(/^ {2}"[a-z]+",$/gmu)).toHaveLength(12);
    for (const kind of ["deterministic", "model", "gate", "loop", "human", "subgraph"]) expect(glyphs).toContain(`  ${kind}: {`);
    for (const state of ["verified", "dissent", "refuted", "tainted", "unexamined", "degraded"]) expect(glyphs).toContain(`  ${state}: "--`);
  });
});

describe("brand asset integrity", () => {
  it("ships only the five designated production marks", () => {
    expect(readdirSync(join(repository, "apps/web/src/assets/brand")).sort()).toEqual([...PRODUCTION_MARKS].sort());
    expect(readdirSync(brand).filter((name) => name.endsWith(".svg")).sort()).toEqual([...PRODUCTION_MARKS].sort());
  });

  /**
   * Compared after removing non-rendering markup — XML comments and inter-tag whitespace.
   * The shipped copies are minified, so the source file's line breaks and design notes need
   * not survive, but every element, attribute and path command must match exactly. Any
   * change to the geometry, the fill token or the accessible label fails.
   */
  it("keeps every shipped mark identical to the normative source", () => {
    for (const mark of PRODUCTION_MARKS) expect(`${mark}:${svg(`apps/web/src/assets/brand/${mark}`)}`).toBe(`${mark}:${svg(`docs/brand/${mark}`)}`);
  });
});

function read(path: string): string { return readFileSync(join(repository, path), "utf8"); }
function hash(path: string): string { return createHash("sha256").update(readFileSync(join(repository, path))).digest("hex"); }
function svg(path: string): string { return read(path).replace(/<!--[\s\S]*?-->/gu, "").replace(/>\s+</gu, "><").trim(); }
function names(css: string): readonly string[] { return [...new Set(css.match(/--[a-z0-9-]+(?=\s*:)/gu) ?? [])].sort(); }
function stylesheets(): readonly string[] { return walk(join(repository, "apps/web/src")).filter((path) => path.endsWith(".css")); }
function sources(): readonly string[] { return [...walk(join(repository, "apps")), ...walk(join(repository, "packages"))].filter((path) => /\.tsx?$/u.test(path) && path.includes("/src/")); }
function walk(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "dist") return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path.slice(repository.length + 1).replaceAll("\\", "/")];
  });
}
