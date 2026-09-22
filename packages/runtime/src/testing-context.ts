import type { TestingExecution, TestingRisk } from "@arbitra/schemas/testing.js";
import { testingRiskSchema, testingEvidenceSchema, testingSelectionSchema } from "@arbitra/schemas/testing.js";
import type { RepositorySnapshot } from "./repository.js";
import { testInventory, type TestSystemReport, type TestGap } from "@arbitra/workflow/nodes/test-inventory.js";

export function validateTestingSelection(value: unknown, candidates: readonly TestGap[]) {
  const selection = testingSelectionSchema.parse(value);
  const ids = [...selection.selectedGapIds, ...selection.rejected.map(({ gapId }) => gapId)];
  const known = new Set(candidates.map(({ id }) => id));
  if (new Set(ids).size !== ids.length || ids.length !== known.size || ids.some((id) => !known.has(id))) throw new Error("TESTING_SELECTION_INCOMPLETE_OR_INVALID");
  return selection;
}

export interface RepositoryTestCommand { readonly command: string; readonly executionPolicy: "derived_repository_script" | "requires_approval"; readonly sourcePath: string; readonly source: string }

export function validateTestingEvidence(value: unknown, snapshot: RepositorySnapshot) {
  const evidence = testingEvidenceSchema.parse(value);
  const file = snapshot.files.find(({ path }) => path === evidence.path);
  if (file === undefined || evidence.endLine < evidence.startLine || evidence.endLine > file.lines.length || file.lines.slice(evidence.startLine - 1, evidence.endLine).join("\n") !== evidence.text) throw new Error("TESTING_EVIDENCE_UNGROUNDED");
  return evidence;
}

export function validateTestingRisk(value: unknown, snapshot: RepositorySnapshot, inventory: TestSystemReport): TestingRisk {
  const risk = testingRiskSchema.parse(value);
  if (new Set(risk.surfaces.map(({ id }) => id)).size !== risk.surfaces.length) throw new Error("DUPLICATE_TEST_RISK_SURFACE");
  if (new Set(risk.reviewedTestPaths).size !== risk.reviewedTestPaths.length || risk.reviewedTestPaths.some((path) => !inventory.testFiles.includes(path))) throw new Error("TESTING_REVIEWED_PATH_INVALID");
  if (new Set(risk.reviewedSourcePaths).size !== risk.reviewedSourcePaths.length || risk.reviewedSourcePaths.some((path) => !inventory.sourceFiles.includes(path))) throw new Error("TESTING_REVIEWED_SOURCE_INVALID");
  for (const surface of risk.surfaces) {
    if (new Set(surface.paths).size !== surface.paths.length || surface.paths.some((path) => !risk.reviewedSourcePaths.includes(path))) throw new Error("TESTING_RISK_SOURCE_INVALID");
    for (const evidence of surface.evidence) {
      validateTestingEvidence(evidence, snapshot);
      if (!surface.paths.includes(evidence.path)) throw new Error("TESTING_RISK_EVIDENCE_UNRELATED");
    }
    if (surface.paths.some((path) => !surface.evidence.some((evidence) => evidence.path === path))) throw new Error("TESTING_RISK_EVIDENCE_MISSING");
  }
  return risk;
}

/** Catalog records origin, not permission to execute repository-defined commands. */
export function repositoryTestCommands(snapshot: RepositorySnapshot, settings: TestingExecution): readonly RepositoryTestCommand[] {
  const commands: RepositoryTestCommand[] = [];
  for (const file of snapshot.files.filter(({ path }) => path === "package.json" || path.endsWith("/package.json"))) {
    let parsed: unknown;
    try { parsed = JSON.parse(file.lines.join("\n")); } catch { throw new Error(`TESTING_MANIFEST_INVALID:${file.path}`); }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`TESTING_MANIFEST_INVALID:${file.path}`);
    const manifest = parsed as { scripts?: unknown; packageManager?: unknown };
    if (typeof manifest.scripts !== "object" || manifest.scripts === null || Array.isArray(manifest.scripts)) continue;
    const manager = typeof manifest.packageManager === "string" && /^(pnpm|yarn)@/u.test(manifest.packageManager) ? manifest.packageManager.split("@")[0] ?? "npm" : "npm";
    const directory = file.path.slice(0, -"package.json".length).replace(/\/$/u, "");
    // Unusual names need an explicit, evidence-backed command rather than synthesized shell quoting.
    if (directory !== "" && !/^[A-Za-z0-9_./-]+$/u.test(directory)) continue;
    for (const [script, source] of Object.entries(manifest.scripts)) {
      if (!/^test(?::[A-Za-z0-9_.-]+)*$/u.test(script) || typeof source !== "string" || source.trim() === "") continue;
      const prefix = directory === "" ? "" : ` ${manager === "pnpm" ? "--dir" : manager === "yarn" ? "--cwd" : "--prefix"} ${directory}`;
      commands.push({ command: `${manager}${prefix} run ${script}`, executionPolicy: "derived_repository_script", sourcePath: file.path, source });
    }
  }
  for (const configured of settings.commands) {
    const evidence = validateTestingEvidence(configured.evidence, snapshot);
    if (evidence.text.trim() !== configured.command.trim()) throw new Error("TESTING_COMMAND_NOT_REPOSITORY_DERIVED");
    commands.push({ command: configured.command, executionPolicy: "requires_approval", sourcePath: evidence.path, source: evidence.text });
  }
  return [...new Map(commands.map((command) => [command.command, command])).values()];
}

export function isTestingWritePath(path: string, inventory: TestSystemReport): boolean {
  if (path.includes("\\") || path.includes(":") || path.split("/").some((part) => part === ".." || part === "." || part === "")) return false;
  if (inventory.sourceFiles.includes(path)) return false;
  const classified = testInventory([{ path, kind: "file" }]);
  return classified.testFiles.length > 0 || classified.frameworkFiles.length > 0;
}
