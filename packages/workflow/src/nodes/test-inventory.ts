export const TEST_CATEGORIES = ["unit", "integration", "end-to-end", "contract", "authorization", "security-sensitive", "regression", "failure-path", "concurrency", "race-condition", "migration", "recovery", "retry", "idempotency", "frontend-interaction", "accessibility", "api"] as const;
export type TestCategory = typeof TEST_CATEGORIES[number];

export interface TestSnapshotEntry { readonly path: string; readonly kind: "file" | "directory" }
export interface TestSystemReport {
  readonly frameworkFiles: readonly string[];
  readonly testDirectories: readonly string[];
  readonly testFiles: readonly string[];
  readonly sourceFiles: readonly string[];
  readonly observedCategories: readonly TestCategory[];
  readonly derivation: "deterministic_snapshot_inventory";
}
export interface RiskSurface { readonly id: string; readonly paths: readonly string[]; readonly categories: readonly TestCategory[]; readonly severity: "low" | "medium" | "high" | "critical"; readonly failureModes: readonly string[] }
export interface TestGap { readonly id: string; readonly surfaceId: string; readonly category: TestCategory; readonly priority: "medium" | "high" | "critical"; readonly rationale: string; readonly productionRisk: string; readonly suggestedPaths: readonly string[] }
export interface GapSelectionRuntime { select(input: { readonly capability: "frontier"; readonly report: TestSystemReport; readonly candidates: readonly TestGap[]; readonly forbiddenMetrics: readonly ["raw_test_count", "coverage_percentage"] }): Promise<readonly string[]> }
export interface TestTaskIR { readonly id: string; readonly gapIds: readonly string[]; readonly routing: { readonly capability: "fast" | "balanced" | "frontier"; readonly effort: "low" | "medium" | "high"; readonly reason: readonly string[] }; readonly verification: { readonly commands: readonly { readonly command: string; readonly executionPolicy: "derived_repository_script" }[] } }

export function testInventory(snapshot: readonly TestSnapshotEntry[]): TestSystemReport {
  const files = snapshot.filter(({ kind }) => kind === "file").map(({ path }) => normalise(path)).sort();
  const testFiles = files.filter(isTestFile);
  const frameworkFiles = files.filter((path) => /(?:^|\/)(?:vitest|jest|playwright|cypress|pytest|phpunit|cargo|go\.mod)|(?:^|\/)(?:package\.json|pyproject\.toml)$/u.test(path));
  const testDirectories = [...new Set(testFiles.map((path) => path.slice(0, Math.max(0, path.lastIndexOf("/")))).filter(Boolean))].sort();
  const categories = new Set<TestCategory>();
  for (const path of testFiles) for (const category of TEST_CATEGORIES) if (categoryPattern(category).test(path)) categories.add(category);
  return Object.freeze({ frameworkFiles: Object.freeze(frameworkFiles), testDirectories: Object.freeze(testDirectories), testFiles: Object.freeze(testFiles), sourceFiles: Object.freeze(files.filter((path) => !isTestFile(path))), observedCategories: Object.freeze([...categories].sort()), derivation: "deterministic_snapshot_inventory" as const });
}

export async function prioritiseGaps(report: TestSystemReport, risk: readonly RiskSurface[], runtime: GapSelectionRuntime): Promise<readonly TestGap[]> {
  const existing = new Set(report.observedCategories);
  const candidates = risk.flatMap((surface) => surface.categories.filter((category) => !existing.has(category)).map((category, index) => Object.freeze({
    id: `GAP-${surface.id}-${index + 1}`,
    surfaceId: surface.id,
    category,
    priority: surface.severity === "critical" ? "critical" as const : surface.severity === "high" ? "high" as const : "medium" as const,
    rationale: `${category} coverage is justified by ${surface.failureModes.join(", ")} on ${surface.id}.`,
    productionRisk: `${surface.severity}:${surface.failureModes.join("|")}`,
    suggestedPaths: Object.freeze([...surface.paths]),
  })));
  const selectedIds = new Set(await runtime.select(Object.freeze({ capability: "frontier" as const, report, candidates: Object.freeze(candidates), forbiddenMetrics: Object.freeze(["raw_test_count", "coverage_percentage"] as const) })));
  return Object.freeze(candidates.filter(({ id }) => selectedIds.has(id)).sort((a, b) => priority(b.priority) - priority(a.priority) || a.id.localeCompare(b.id)));
}

export function testTasks(gaps: readonly TestGap[], repositoryTestCommand: string): readonly TestTaskIR[] {
  return Object.freeze(gaps.map((gap, index) => Object.freeze({ id: `TEST-TASK-${index + 1}`, gapIds: Object.freeze([gap.id]), routing: route(gap), verification: Object.freeze({ commands: Object.freeze([{ command: repositoryTestCommand, executionPolicy: "derived_repository_script" as const }]) }) })));
}

function route(gap: TestGap): TestTaskIR["routing"] { const frontier = ["race-condition", "concurrency", "migration", "recovery", "security-sensitive", "end-to-end"].includes(gap.category); return Object.freeze({ capability: frontier ? "frontier" as const : gap.priority === "medium" ? "fast" as const : "balanced" as const, effort: frontier ? "high" as const : "medium" as const, reason: Object.freeze([`production_risk:${gap.productionRisk}`, `category:${gap.category}`]) }); }
function priority(value: TestGap["priority"]): number { return value === "critical" ? 3 : value === "high" ? 2 : 1; }
function normalise(path: string): string { return path.replaceAll("\\", "/").replace(/^\.\//u, ""); }
function isTestFile(path: string): boolean { return /(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path); }
function categoryPattern(category: TestCategory): RegExp { return new RegExp(category.replace("-", "[-_/ ]?"), "iu"); }

