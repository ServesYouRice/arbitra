export type RequirementsMode = "automatic" | "interactive";
export type BlastRadius = "low" | "medium" | "high";

export interface RequirementAssumption {
  readonly id: string;
  readonly statement: string;
  readonly confidence: "low" | "medium" | "high";
}

export interface RequirementAmbiguity {
  readonly id: string;
  readonly question: string;
  readonly proposedDefault: string;
  readonly blastRadius: BlastRadius;
}

export interface RequirementAcceptance {
  readonly id: string;
  readonly assertion: string;
}

export interface RequirementsContract {
  readonly schemaVersion: 1;
  readonly featureRequest: string;
  readonly assumptions: readonly RequirementAssumption[];
  readonly ambiguities: readonly RequirementAmbiguity[];
  readonly outOfScope: readonly string[];
  readonly acceptance: readonly RequirementAcceptance[];
  readonly decision: {
    readonly mode: RequirementsMode;
    readonly acceptedDefaults: readonly {
      readonly ambiguityId: string;
      readonly value: string;
      readonly acceptedBy: "automatic_mode" | "operator";
    }[];
  };
}

export interface FeaturePreflight {
  readonly affectedSurfaces: readonly {
    readonly id: string;
    readonly paths: readonly string[];
    readonly riskCategories: readonly string[];
    readonly relevantTo: readonly string[];
  }[];
  readonly securitySensitiveSurfaceCount: number;
  readonly migrationInvolvement: boolean;
  readonly architectureBreadth: number;
  readonly testingComplexity: number;
}

export interface IntensityRecommendation {
  readonly recommended: "FAST" | "BALANCED" | "DEEP";
  readonly effective: "FAST" | "BALANCED" | "DEEP";
  readonly score: number;
  readonly reasons: readonly string[];
  readonly stages: readonly ("requirements" | "targeted_exploration" | "targeted_review" | "planner" | "critic" | "renderer")[];
  readonly targetedSurfaceIds: readonly string[];
  readonly multiModelReview: false;
}

