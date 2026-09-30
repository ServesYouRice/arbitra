import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fromPackageRoot } from "./package-root.js";

/**
 * The design language's rules that can be checked by reading the web sources: tokens only,
 * hairlines and square corners, brass reserved for dissent, forced-colour support, the
 * responsive drawer, and the six glyphs drawn only from the shared table.
 */
const sources = walk(fromPackageRoot("src"));
const stylesheets = sources.filter((path) => path.endsWith(".css") && !path.endsWith("tokens.css"));
const scripts = sources.filter((path) => /\.tsx?$/u.test(path));
const name = (path: string): string => path.slice(fromPackageRoot("src").length + 1);
const read = (path: string): string => readFileSync(path, "utf8");

describe("the design language, read from the sources", () => {
  it("uses token colours only, square corners, no shadows and no gradients in every stylesheet", () => {
    expect(stylesheets.length).toBeGreaterThan(8);
    for (const path of stylesheets) {
      const css = read(path);
      expect(`${name(path)}:${/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|color-mix)\(/iu.test(css)}`).toBe(`${name(path)}:false`);
      expect(`${name(path)}:${css.includes("gradient(")}`).toBe(`${name(path)}:false`);
      for (const shadow of css.match(/box-shadow:[^;}]+/gu) ?? []) expect(`${name(path)}:${shadow.trim()}`).toBe(`${name(path)}:box-shadow: none`);
      for (const radius of css.match(/border-radius:[^;}]+/gu) ?? []) expect(`${name(path)}:${radius.trim()}`).toBe(`${name(path)}:border-radius: var(--radius)`);
      // A border is a hairline or a state stripe; a raw width is a second weight.
      expect(`${name(path)}:${/\bborder(?:-[a-z-]+)?:\s*\d+px/u.test(css)}`).toBe(`${name(path)}:false`);
    }
  });

  it("keeps brass for its meaning: dissent preserved, or a model's proposal awaiting the operator; never emphasis", () => {
    for (const path of stylesheets) for (const rule of read(path).split("}")) {
      if (!rule.includes("var(--brass)")) continue;
      expect(`${name(path)}:${rule.slice(0, rule.indexOf("{")).trim()}`).toMatch(/dissent|operator-proposal/u);
    }
  });

  it("styles forced-colours mode in every stylesheet that draws a border", () => {
    for (const path of stylesheets) {
      const css = read(path);
      if (!/\bsolid\b/u.test(css)) continue;
      expect(`${name(path)}:${css.includes("@media (forced-colors: active)")}`).toBe(`${name(path)}:true`);
    }
  });

  it("turns the details panel into a drawer below 1180px and relaxes the page below 900px", () => {
    const run = read(fromPackageRoot("src/pages/run/run.css"));
    expect(run).toContain("@media (max-width: 1180px)");
    expect(run).toMatch(/\.details\[data-overlay="true"\] \{ position: fixed;/u);
    expect(read(fromPackageRoot("src/app/app.css"))).toContain("@media (max-width: 900px)");
  });

  it("draws the six node glyphs only from the shared table and has no hidden-reasoning path", () => {
    for (const path of scripts) {
      const source = read(path);
      expect(`${name(path)}:${/[■◆◇↻◫▣]/u.test(source)}`).toBe(`${name(path)}:false`);
      expect(`${name(path)}:${/chain.?of.?thought|hiddenReasoning|reasoningContent/iu.test(source)}`).toBe(`${name(path)}:false`);
    }
    for (const path of ["graph/GraphView.tsx", "graph/GraphEditor.tsx", "pages/run/DecisionBanner.tsx", "pages/run/NodeDetails.tsx"]) expect(read(fromPackageRoot(`src/${path}`))).toContain("@arbitra/schemas/glyphs");
  });

  it("ships only the five designated production marks", () => {
    expect(readdirSync(fromPackageRoot("src/assets/brand")).sort()).toEqual(["mark-triangle-icon-mono.svg", "mark-triangle-icon.svg", "mark-triangle-of-error-mono.svg", "mark-triangle-of-error.svg", "mark-triangle-reduction.svg"]);
  });
});

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)]);
}
