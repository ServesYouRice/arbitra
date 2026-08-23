export const DIFFICULTY_DIMENSIONS = ["ambiguity", "novelty", "architecturalBreadth", "affectedSystems", "dependencyDepth", "discoveryRequired", "verificationDifficulty", "securitySensitivity", "migrationRisk", "blastRadius", "failureDiagnosisUncertainty", "reversibility", "apiCompatibilityRisk", "dataIntegrityRisk"] as const;
export type DifficultyDimension = (typeof DIFFICULTY_DIMENSIONS)[number];
export type DifficultySignals = Readonly<Record<DifficultyDimension, 0 | 1 | 2 | 3 | 4>>;
export interface DifficultyScore { readonly total: number; readonly maximum: 56; readonly normalized: number; readonly dimensions: DifficultySignals; readonly recommendation: { readonly capability: "frontier" | "balanced" | "fast"; readonly effort: "low" | "medium" | "high" | "xhigh"; readonly escalationPermitted: boolean; readonly reason: readonly string[] } }

export function scoreDifficulty(task: { readonly signals: DifficultySignals }): DifficultyScore {
  const values = DIFFICULTY_DIMENSIONS.map((dimension) => task.signals[dimension]);
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 4)) throw new Error("INVALID_DIFFICULTY_SIGNAL");
  const total = values.reduce<number>((sum, value) => sum + value, 0); const normalized = Math.round(total / 56 * 10_000) / 10_000; const securityFloor = task.signals.securitySensitivity >= 3 || task.signals.migrationRisk >= 3 || task.signals.dataIntegrityRisk >= 3;
  let capability: DifficultyScore["recommendation"]["capability"]; let effort: DifficultyScore["recommendation"]["effort"];
  if (normalized >= 0.75) { capability = "frontier"; effort = "xhigh"; }
  else if (normalized >= 0.5 || securityFloor) { capability = "frontier"; effort = "high"; }
  else if (normalized >= 0.3) { capability = "balanced"; effort = "medium"; }
  else { capability = "fast"; effort = normalized >= 0.15 ? "medium" : "low"; }
  const leading = DIFFICULTY_DIMENSIONS.filter((dimension) => task.signals[dimension] >= 3).map((dimension) => `${dimension}:${task.signals[dimension]}`);
  return Object.freeze({ total, maximum: 56 as const, normalized, dimensions: Object.freeze({ ...task.signals }), recommendation: Object.freeze({ capability, effort, escalationPermitted: capability !== "frontier" || effort !== "xhigh", reason: Object.freeze(leading.length > 0 ? leading : [`aggregate_difficulty:${normalized}`]) }) });
}
