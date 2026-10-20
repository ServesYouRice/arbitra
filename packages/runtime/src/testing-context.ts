import type { TestingExecution, TestingRisk } from "@arbitra/schemas/testing.js";
import { testingRiskSchema, testingEvidenceSchema, testingSelectionSchema } from "@arbitra/schemas/testing.js";
import { anchorLineEvidence } from "./evidence-grounding.js";
import { groundBehaviourConflicts } from "./documented-behaviour.js";
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
  const parsed = testingEvidenceSchema.parse(value);
  const evidence = anchorLineEvidence(parsed, snapshot.files.find(({ path }) => path === parsed.path));
  // Named, so an output repair can correct the one quotation that failed.
  if (evidence === null) throw new Error(`TESTING_EVIDENCE_UNGROUNDED: evidence at ${parsed.path} lines ${parsed.startLine}-${parsed.endLine} must quote whole lines of that file exactly`);
  return evidence;
}

function assertPathSubset(code: string, field: string, paths: readonly string[], allowed: readonly string[], kind: string): void {
  const duplicates = [...new Set(paths.filter((path, index) => paths.indexOf(path) !== index))];
  const invalid = [...new Set(paths.filter((path) => !allowed.includes(path)))];
  if (duplicates.length === 0 && invalid.length === 0) return;
  const list = (values: readonly string[]) => values.slice(0, 20).map((value) => JSON.stringify(value)).join(", ") + (values.length > 20 ? ` and ${values.length - 20} more` : "");
  throw new Error(`${code}: ${field} ${invalid.length > 0 ? `lists ${list(invalid)}, which ${invalid.length === 1 ? "is" : "are"} not among the ${kind}` : `repeats ${list(duplicates)}`}; allowed: ${allowed.length === 0 ? "none" : list(allowed)}`);
}

/** `goal` is the request a documentation quotation with a null path may cite. */
export function validateTestingRisk(value: unknown, snapshot: RepositorySnapshot, inventory: TestSystemReport, goal?: string): TestingRisk {
  const risk = testingRiskSchema.parse(value);
  if (new Set(risk.surfaces.map(({ id }) => id)).size !== risk.surfaces.length) throw new Error("DUPLICATE_TEST_RISK_SURFACE");
  // The code stays first; the rest tells a repair which paths were wrong and which are allowed.
  assertPathSubset("TESTING_REVIEWED_PATH_INVALID", "reviewedTestPaths", risk.reviewedTestPaths, inventory.testFiles, "test files");
  assertPathSubset("TESTING_REVIEWED_SOURCE_INVALID", "reviewedSourcePaths", risk.reviewedSourcePaths, inventory.sourceFiles, "source files (test metadata such as package.json is not source)");
  for (const surface of risk.surfaces) {
    assertPathSubset("TESTING_RISK_SOURCE_INVALID", `surface ${surface.id} paths`, surface.paths, risk.reviewedSourcePaths, "reviewedSourcePaths entries");
    surface.evidence = surface.evidence.map((value) => validateTestingEvidence(value, snapshot));
    for (const evidence of surface.evidence) if (!surface.paths.includes(evidence.path)) throw new Error("TESTING_RISK_EVIDENCE_UNRELATED");
    if (surface.paths.some((path) => !surface.evidence.some((evidence) => evidence.path === path))) throw new Error("TESTING_RISK_EVIDENCE_MISSING");
  }
  risk.documentedBehaviourConflicts = groundBehaviourConflicts(risk.documentedBehaviourConflicts, snapshot, goal);
  return risk;
}

/** Catalog records origin, not permission to execute repository-defined commands. */
export function repositoryTestCommands(snapshot: RepositorySnapshot, settings: TestingExecution): readonly RepositoryTestCommand[] {
  const commands: RepositoryTestCommand[] = [];
  // A manifest that does not parse (a deliberately broken fixture, a vendored file) offers no commands; it does not
  // stop the others or the configured ones.
  const manifests = snapshot.files.filter(({ path }) => path === "package.json" || path.endsWith("/package.json")).flatMap((file) => {
    let parsed: unknown;
    try { parsed = JSON.parse(file.lines.join("\n").replace(/^\u{FEFF}/u, "")); } catch { return []; }
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? [{ path: file.path, manifest: parsed as { scripts?: unknown; packageManager?: unknown } }] : [];
  });
  // Workspace packages name no package manager of their own: the repository root's field or lockfile decides.
  const declared = (manifest: { packageManager?: unknown } | undefined) => typeof manifest?.packageManager === "string" ? /^(pnpm|yarn)@/u.exec(manifest.packageManager)?.[1] : undefined;
  const paths = new Set(snapshot.files.map(({ path }) => path));
  const rootManager = declared(manifests.find(({ path }) => path === "package.json")?.manifest)
    ?? (paths.has("pnpm-lock.yaml") || paths.has("pnpm-workspace.yaml") ? "pnpm" : paths.has("yarn.lock") ? "yarn" : "npm");
  for (const { path, manifest } of manifests) {
    if (typeof manifest.scripts !== "object" || manifest.scripts === null || Array.isArray(manifest.scripts)) continue;
    const manager = declared(manifest) ?? rootManager;
    const directory = path.slice(0, -"package.json".length).replace(/\/$/u, "");
    // Unusual names need an explicit, evidence-backed command rather than synthesized shell quoting.
    if (directory !== "" && !/^[A-Za-z0-9_./-]+$/u.test(directory)) continue;
    for (const [script, source] of Object.entries(manifest.scripts)) {
      if (!/^test(?::[A-Za-z0-9_.-]+)*$/u.test(script) || typeof source !== "string" || source.trim() === "") continue;
      const prefix = directory === "" ? "" : ` ${manager === "pnpm" ? "--dir" : manager === "yarn" ? "--cwd" : "--prefix"} ${directory}`;
      commands.push({ command: `${manager}${prefix} run ${script}`, executionPolicy: "derived_repository_script", sourcePath: path, source });
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
