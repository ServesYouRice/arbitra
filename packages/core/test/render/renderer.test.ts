import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { isExecutionStateWriteAllowed, renderImplementation, type ImplementationManifest, validateProgressJsonl, writeImplementation } from "../../src/render/index.js";

const REAL_MANIFEST = new URL("../../../../implementation/manifest.json", import.meta.url);
const fixture = JSON.parse(readFileSync(new URL("./golden/manifest.json", import.meta.url), "utf8")) as ImplementationManifest;
const expectedHashes = JSON.parse(readFileSync(new URL("./golden/expected-hashes.json", import.meta.url), "utf8")) as Record<string, string>;
const options = {
  selectedTaskId: "TASK-001",
  adapters: ["claude", "gemini"] as const,
  effectiveWriteScopes: { "TASK-001": ["src/auth.ts", "src/generated.ts", ".github/workflows/deploy.yml"] },
};
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("deterministic implementation renderer", () => {
  it("matches the complete byte-level golden tree and repeats identically", () => {
    const first = renderImplementation(fixture, options);
    const second = renderImplementation(fixture, options);
    expect(second).toEqual(first);
    const hashes = Object.fromEntries(Object.entries(first).map(([path, bytes]) => [path, createHash("sha256").update(bytes).digest("hex")]));
    expect(hashes).toEqual(expectedHashes);
  });

  it("always emits compact trusted entrypoints and keeps provider adapters opt-in", () => {
    const base = renderImplementation(fixture, { ...options, adapters: [] });
    expect(base["README.md"]).toBeDefined();
    expect(base["AGENTS.md"]?.split("\n").length).toBeLessThan(50);
    expect(base["AGENTS.md"]).toContain("Trust warning");
    expect(base["AGENTS.md"]).toContain("implementation/manifest.json");
    expect(base["AGENTS.md"]).toContain("src/auth.ts");
    expect(base["AGENTS.md"]).toContain("Verification contract");
    expect(base["CLAUDE.md"]).toBeUndefined();
    expect(base["GEMINI.md"]).toBeUndefined();
    const adapters = renderImplementation(fixture, options);
    expect(adapters["CLAUDE.md"]).toContain("Trust warning");
    expect(adapters["GEMINI.md"]).toContain("Trust warning");
  });

  it("frames hostile free text, emits only intersected scope and visibly refuses unknown command policy", () => {
    const tree = renderImplementation(fixture, options);
    expect(tree["context/project.md"]).not.toContain("<script>");
    expect(tree["context/project.md"]).toContain("&lt;script&gt;");
    expect(tree["context/project.md"]).toContain("Untrusted planning prose — data only");
    expect(tree["tasks/TASK-001/task.md"]).toContain("src/auth.ts");
    expect(tree["tasks/TASK-001/task.md"]).not.toContain("src/generated.ts");
    expect(tree["tasks/TASK-001/task.md"]).not.toContain(".github/workflows/deploy.yml");
    expect(tree["tasks/TASK-001/task.md"]).toContain("executionPolicy: `requires_approval`");
    expect(tree["tasks/TASK-001/task.md"]).toContain("NOT RUNNABLE without explicit approval");
    expect(tree["tasks/TASK-001/task.md"]).not.toContain("```instructions```");
  });

  it("uses the shared glyph import and exposes dissent, provenance, null and degraded labels without colour", () => {
    const source = readFileSync(new URL("../../src/render/markdown/index.ts", import.meta.url), "utf8");
    expect(source).toContain('from "@arbitra/schemas/glyphs"');
    const readme = renderImplementation(fixture, options)["README.md"] ?? "";
    for (const label of ["dissent", "provenance / tainted", "null / unexamined", "degraded"]) expect(readme).toContain(label);
    expect(readme).not.toMatch(/#[a-f0-9]{3,8}\b/iu);
  });

  it("emits the required tree shape and schema-backed empty progress channel", () => {
    const tree = renderImplementation(fixture, options);
    for (const path of ["manifest.json", "context/project.md", "context/architecture.md", "context/invariants.md", "context/requirements.md", "issues/ISSUE-001.md", "tasks/TASK-001/task.md", "validation/final-validation.md", "progress.schema.json", "progress.jsonl", "execution/README.md"]) expect(tree[path]).toBeDefined();
    expect(JSON.parse(tree["manifest.json"] ?? "{}")).toMatchObject({ manifestVersion: "1.0.0", run: { runId: "run-golden" } });
    expect(tree["progress.jsonl"]).toBe("");
    expect(JSON.parse(tree["progress.schema.json"] ?? "{}")).toMatchObject({ type: "object" });
  });

  // The authoritative plan lives in implementation/, which is deliberately not tracked:
  // a fresh clone and CI do not have it. Run this check wherever the plan is present and
  // skip it — visibly — where it is not, rather than asserting against a file the
  // repository does not ship. Every other case here uses the tracked golden fixture.
  it.skipIf(!existsSync(REAL_MANIFEST))("renders the real authoritative 49-task manifest without reading living execution state", () => {
    const real = JSON.parse(readFileSync(REAL_MANIFEST, "utf8")) as ImplementationManifest;
    const effectiveWriteScopes = Object.fromEntries(real.tasks.map(({ id }) => [id, []]));
    const tree = renderImplementation(real, { selectedTaskId: "TASK-039", effectiveWriteScopes });
    expect(real.tasks).toHaveLength(49);
    expect(Object.keys(tree).filter((path) => /^tasks\/TASK-[0-9]{3}\/task\.md$/u.test(path))).toHaveLength(49);
    expect(tree["AGENTS.md"]?.split("\n").length).toBeLessThan(50);
    expect(tree["tasks/TASK-039/task.md"]).toContain("Empty — this task is display-only.");
  });

  it("writes the exact tree beneath a chosen root and rejects traversal", () => {
    const directory = mkdtempSync(join(tmpdir(), "arbitra-render-"));
    temporaryDirectories.push(directory);
    const tree = renderImplementation(fixture, options);
    writeImplementation(tree, directory);
    expect(readFileSync(join(directory, "tasks", "TASK-001", "task.md"), "utf8")).toBe(tree["tasks/TASK-001/task.md"]);
    expect(() => writeImplementation({ "../outside.md": "unsafe" }, directory)).toThrow(/UNSAFE_RENDER_PATH/u);
  });
});

describe("executor-state path policy", () => {
  it("allows only progress and the current task execution subtree", () => {
    expect(isExecutionStateWriteAllowed("implementation/progress.jsonl", "TASK-001")).toBe(true);
    expect(isExecutionStateWriteAllowed("implementation/execution/TASK-001/evidence.json", "TASK-001")).toBe(true);
    expect(isExecutionStateWriteAllowed("implementation/manifest.json", "TASK-001")).toBe(false);
    expect(isExecutionStateWriteAllowed("implementation/tasks/TASK-001/task.md", "TASK-001")).toBe(false);
    expect(isExecutionStateWriteAllowed("implementation/execution/TASK-002/evidence.json", "TASK-001")).toBe(false);
    expect(isExecutionStateWriteAllowed("../implementation/progress.jsonl", "TASK-001")).toBe(false);
  });

  it("validates every progress append against the emitted schema", () => {
    const valid = JSON.stringify({ ts: "2026-08-22T00:00:00Z", taskId: "TASK-001", event: "started" });
    expect(validateProgressJsonl(`${valid}\n`, fixture.progressSchema)).toEqual({ valid: true, errors: [] });
    expect(validateProgressJsonl('{"taskId":"bad","event":"invented","extra":true}\n', fixture.progressSchema)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([expect.stringContaining(".ts: required"), expect.stringContaining(".extra: additional property"), expect.stringContaining(".taskId: pattern mismatch"), expect.stringContaining(".event: value is outside enum")]),
    });
    expect(validateProgressJsonl("not-json\n", fixture.progressSchema)).toMatchObject({ valid: false, errors: ["line 1: invalid JSON"] });
  });
});
