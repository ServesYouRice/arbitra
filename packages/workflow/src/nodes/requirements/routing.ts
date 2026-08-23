import type { FeaturePreflight, IntensityRecommendation, RequirementsContract } from "./types.js";

export function featureComplexityGate(requirements: RequirementsContract, preflight: FeaturePreflight): IntensityRecommendation {
  validatePreflight(preflight);
  const highAmbiguities = requirements.ambiguities.filter(({ blastRadius }) => blastRadius === "high").length;
  const mediumAmbiguities = requirements.ambiguities.filter(({ blastRadius }) => blastRadius === "medium").length;
  const lowConfidence = requirements.assumptions.filter(({ confidence }) => confidence === "low").length;
  const score = highAmbiguities * 30
    + mediumAmbiguities * 10
    + lowConfidence * 8
    + preflight.securitySensitiveSurfaceCount * 15
    + (preflight.migrationInvolvement ? 25 : 0)
    + Math.min(15, preflight.architectureBreadth * 3)
    + Math.min(10, preflight.testingComplexity * 2);
  const recommended = score >= 45 ? "DEEP" as const : score >= 20 ? "BALANCED" as const : "FAST" as const;
  const references = new Set([
    ...requirements.assumptions.map(({ id }) => id),
    ...requirements.ambiguities.map(({ id }) => id),
    ...requirements.acceptance.map(({ id }) => id),
  ]);
  const targetedSurfaceIds = preflight.affectedSurfaces
    .filter(({ relevantTo }) => relevantTo.some((id) => references.has(id)))
    .map(({ id }) => id)
    .sort();
  const requiresReview = recommended !== "FAST";
  const reasons = [
    ...(highAmbiguities > 0 ? [`high_blast_radius_ambiguities:${highAmbiguities}`] : []),
    ...(preflight.securitySensitiveSurfaceCount > 0 ? [`security_sensitive_surfaces:${preflight.securitySensitiveSurfaceCount}`] : []),
    ...(preflight.migrationInvolvement ? ["migration_involvement"] : []),
    ...(requiresReview ? ["targeted_review_required"] : ["bounded_requirements_and_low_risk"]),
  ];
  return Object.freeze({
    recommended,
    effective: recommended,
    score,
    reasons: Object.freeze(reasons),
    stages: Object.freeze(requiresReview
      ? ["requirements", "targeted_exploration", "targeted_review", "planner", "critic", "renderer"] as const
      : ["requirements", "targeted_exploration", "planner", "renderer"] as const),
    targetedSurfaceIds: Object.freeze(targetedSurfaceIds),
    multiModelReview: false as const,
  });
}

export function validateFeatureTaskTraceability(
  requirements: RequirementsContract,
  tasks: readonly { readonly id: string; readonly requirementIds: readonly string[] }[],
): readonly { readonly taskId: string; readonly code: "FEATURE_TASK_REQUIREMENT_TRACE_MISSING" | "FEATURE_TASK_REQUIREMENT_TRACE_UNKNOWN" }[] {
  const known = new Set([
    ...requirements.assumptions.map(({ id }) => id),
    ...requirements.acceptance.map(({ id }) => id),
  ]);
  const diagnostics: { taskId: string; code: "FEATURE_TASK_REQUIREMENT_TRACE_MISSING" | "FEATURE_TASK_REQUIREMENT_TRACE_UNKNOWN" }[] = [];
  for (const task of tasks) {
    if (task.requirementIds.length === 0) diagnostics.push({ taskId: task.id, code: "FEATURE_TASK_REQUIREMENT_TRACE_MISSING" });
    else if (task.requirementIds.some((id) => !known.has(id))) diagnostics.push({ taskId: task.id, code: "FEATURE_TASK_REQUIREMENT_TRACE_UNKNOWN" });
  }
  return Object.freeze(diagnostics.map((diagnostic) => Object.freeze(diagnostic)));
}

function validatePreflight(preflight: FeaturePreflight): void {
  for (const [key, value] of Object.entries(preflight)) {
    if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) throw new Error(`INVALID_FEATURE_PREFLIGHT:${key}`);
  }
}
