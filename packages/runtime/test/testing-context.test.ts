import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { testingExecutionSchema } from "@arbitra/schemas/testing.js";
import { prioritiseGaps, testInventory } from "@arbitra/workflow/nodes/test-inventory.js";
import { snapshotRepository } from "../src/repository.js";
import { isTestingWritePath, repositoryTestCommands, validateTestingEvidence, validateTestingRisk, validateTestingSelection } from "../src/testing-context.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const settings = testingExecutionSchema.parse({ mode: "plan", goal: "Protect sessions", roles: { analyst: "model", planner: "model" } });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "testing-context-")); roots.push(root);
  await mkdir(join(root, "nested"));
  await Promise.all([
    writeFile(join(root, "auth.ts"), "export const authorized = false;\n"),
    writeFile(join(root, "auth.test.ts"), "test('auth', () => {});\n"),
    writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10.24.0", scripts: { test: "vitest run", "test:unit": "vitest run unit", build: "tsc", "test;echo": "unsafe" } })),
    writeFile(join(root, "nested", "package.json"), JSON.stringify({ scripts: { test: "node --test" } })),
    writeFile(join(root, "commands.md"), "go test ./...\n"),
  ]);
  const snapshot = await snapshotRepository(root, 20, { includeTestMetadata: true, additionalPaths: ["commands.md"] });
  return { root, snapshot, inventory: testInventory(snapshot.files.map(({ path }) => ({ path, kind: "file" }))) };
}

it("includes metadata only on opt-in and preserves module/diff snapshot boundaries", async () => {
  const { root } = await fixture();
  expect((await snapshotRepository(root)).files.map(({ path }) => path)).toEqual(["auth.test.ts", "auth.ts"]);
  expect((await snapshotRepository(root, 2, { includeTestMetadata: true, scope: { kind: "module", modules: ["nested"] } })).files.map(({ path }) => path)).toEqual(["nested/package.json"]);
  const snapshot = await snapshotRepository(root, 2, { includeTestMetadata: true, scope: { kind: "diff", diffMode: "staged" }, git: { async run(_root, args) { return args[0] === "diff" ? "package.json\0commands.md\0" : '{"scripts":{"test":"staged-test"}}'; } } });
  expect(snapshot.files).toHaveLength(1);
  expect(snapshot.files[0]?.lines[0]).toContain("staged-test");
  await expect(snapshotRepository(root, 2, { includeTestMetadata: true })).rejects.toThrow("REPOSITORY_FILE_LIMIT_EXCEEDED");
});

it("derives commands from exact repository metadata and retains approval policy", async () => {
  const { snapshot } = await fixture();
  const command = { command: "go test ./...", evidence: { path: "commands.md", startLine: 1, endLine: 1, text: "go test ./..." } };
  expect(repositoryTestCommands(snapshot, { ...settings, commands: [command] })).toEqual([
    { command: "npm --prefix nested run test", executionPolicy: "derived_repository_script", sourcePath: "nested/package.json", source: "node --test" },
    { command: "pnpm run test", executionPolicy: "derived_repository_script", sourcePath: "package.json", source: "vitest run" },
    { command: "pnpm run test:unit", executionPolicy: "derived_repository_script", sourcePath: "package.json", source: "vitest run unit" },
    { command: "go test ./...", executionPolicy: "requires_approval", sourcePath: "commands.md", source: "go test ./..." },
  ]);
  expect(() => repositoryTestCommands(snapshot, { ...settings, commands: [{ ...command, command: "invented test" }] })).toThrow("TESTING_COMMAND_NOT_REPOSITORY_DERIVED");
  expect(() => validateTestingEvidence({ ...command.evidence, endLine: 3 }, snapshot)).toThrow("TESTING_EVIDENCE_UNGROUNDED");
  expect(() => validateTestingEvidence({ ...command.evidence, text: "invented quote" }, snapshot)).toThrow("TESTING_EVIDENCE_UNGROUNDED");
});

it("rejects fabricated risk evidence, unrelated paths and incomplete candidate accounting", async () => {
  const { snapshot, inventory } = await fixture();
  const surface = { id: "auth", paths: ["auth.ts"], categories: ["authorization"], severity: "high", failureModes: ["unauthorized access"], evidence: [{ path: "auth.ts", startLine: 1, endLine: 1, text: "export const authorized = false;" }] };
  const risk = { summary: "Authorization", surfaces: [surface], reviewedTestPaths: ["auth.test.ts"], reviewedSourcePaths: ["auth.ts"], limitations: [] };
  expect(validateTestingRisk(risk, snapshot, inventory)).toEqual(risk);
  expect(() => validateTestingRisk({ ...risk, surfaces: [{ ...surface, paths: ["auth.test.ts"] }] }, snapshot, inventory)).toThrow("TESTING_RISK_SOURCE_INVALID");
  expect(() => validateTestingRisk({ ...risk, reviewedTestPaths: ["missing.test.ts"] }, snapshot, inventory)).toThrow("TESTING_REVIEWED_PATH_INVALID");
  expect(() => validateTestingRisk({ ...risk, surfaces: [{ ...surface, evidence: [{ ...surface.evidence[0], text: "fabrication" }] }] }, snapshot, inventory)).toThrow("TESTING_EVIDENCE_UNGROUNDED");
  const gaps = await prioritiseGaps(inventory, validateTestingRisk(risk, snapshot, inventory).surfaces, { async select({ candidates }) { return candidates.map(({ id }) => id); } });
  const selection = { selectedGapIds: ["GAP-auth-1"], rejected: [], limitations: [] };
  expect(validateTestingSelection(selection, gaps)).toEqual(selection);
  for (const invalid of [{ ...selection, selectedGapIds: [] }, { ...selection, rejected: [{ gapId: "GAP-auth-1", reason: "duplicate" }] }, { ...selection, selectedGapIds: ["unknown"] }]) expect(() => validateTestingSelection(invalid, gaps)).toThrow("TESTING_SELECTION_INCOMPLETE_OR_INVALID");
  expect(validateTestingSelection({ selectedGapIds: [], rejected: [{ gapId: "GAP-auth-1", reason: "Existing assertions cover the failure" }], limitations: [] }, gaps).rejected).toHaveLength(1);
});

it("restricts proposed test writes to normalized test and framework paths", async () => {
  const { inventory } = await fixture();
  for (const path of ["auth.test.ts", "tests/new.test.ts", "new_test.go", "vitest.config.ts"]) expect(isTestingWritePath(path, inventory)).toBe(true);
  for (const path of ["auth.ts", "jest-helper.ts", "../tests/a.ts", "tests/../auth.ts", "tests//a.ts", "./tests/a.ts", "C:/tests/a.ts", "/tests/a.ts"]) expect(isTestingWritePath(path, inventory)).toBe(false);
});
