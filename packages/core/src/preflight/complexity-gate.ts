export type OrchestrationIntensity = "FAST" | "BALANCED" | "DEEP";

export interface ComplexityGateInputs {
  readonly scopeSize: number;
  readonly fileCount: number;
  readonly languageCount: number;
  readonly serviceCount: number;
  readonly riskCategory: "low" | "medium" | "high" | "critical";
  readonly securitySensitiveSurfaceCount: number;
  readonly migrationInvolvement: boolean;
  readonly architectureBreadth: number;
  readonly testingComplexity: number;
  readonly hotspotDensity: number;
  readonly instructionRiskDensity: number;
  readonly userSelectedThoroughness: OrchestrationIntensity | null;
  readonly configuredModelCount: number;
  readonly budget: number | null;
}

export interface IntensityRecommendation {
  readonly recommended: OrchestrationIntensity;
  readonly effective: OrchestrationIntensity;
  readonly score: number;
  readonly inputs: ComplexityGateInputs;
  readonly reasons: readonly string[];
  readonly explicitConfigurationPreserved: boolean;
}

export function complexityGate(inputs: ComplexityGateInputs): IntensityRecommendation {
  validateInputs(inputs);
  let score = 0;
  const reasons: string[] = [];
  score += Math.min(20, inputs.fileCount / 25);
  score += Math.min(10, inputs.scopeSize / 50_000);
  score += Math.min(10, inputs.languageCount * 2);
  score += Math.min(10, inputs.serviceCount * 2);
  score += ({ low: 0, medium: 8, high: 18, critical: 28 })[inputs.riskCategory];
  score += Math.min(15, inputs.securitySensitiveSurfaceCount * 3);
  score += inputs.migrationInvolvement ? 10 : 0;
  score += Math.min(10, inputs.architectureBreadth);
  score += Math.min(10, inputs.testingComplexity);
  score += Math.min(10, inputs.hotspotDensity * 10);
  score += Math.min(15, inputs.instructionRiskDensity * 15);
  if (inputs.configuredModelCount < 2) score -= 8;
  if (inputs.budget !== null && inputs.budget < 10) score -= 10;

  if (inputs.riskCategory === "high" || inputs.riskCategory === "critical") reasons.push("elevated risk category");
  if (inputs.securitySensitiveSurfaceCount > 0) reasons.push("security-sensitive surfaces detected");
  if (inputs.migrationInvolvement) reasons.push("migration involvement");
  if (inputs.hotspotDensity >= 0.25) reasons.push("dense hotspot coverage");
  if (inputs.fileCount >= 250) reasons.push("large selected scope");
  if (reasons.length === 0) reasons.push("bounded scope and ordinary risk signals");

  const roundedScore = Math.max(0, Math.round(score * 100) / 100);
  const recommended: OrchestrationIntensity = roundedScore >= 55 ? "DEEP"
    : roundedScore >= 20 ? "BALANCED" : "FAST";
  const explicitConfigurationPreserved = inputs.userSelectedThoroughness !== null;
  if (explicitConfigurationPreserved && inputs.userSelectedThoroughness !== recommended) {
    reasons.push(`explicit ${inputs.userSelectedThoroughness} configuration preserved`);
  }
  return Object.freeze({
    recommended,
    effective: inputs.userSelectedThoroughness ?? recommended,
    score: roundedScore,
    inputs: Object.freeze({ ...inputs }),
    reasons: Object.freeze(reasons),
    explicitConfigurationPreserved,
  });
}

function validateInputs(inputs: ComplexityGateInputs): void {
  for (const [key, value] of Object.entries(inputs)) {
    if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`INVALID_COMPLEXITY_INPUT:${key}`);
    }
  }
  if (inputs.hotspotDensity > 1 || inputs.instructionRiskDensity > 1) {
    throw new Error("INVALID_COMPLEXITY_DENSITY");
  }
}
