import type { FeatureExploration, RequirementsContract } from "@arbitra/schemas/requirements.js";
import type { TestingRisk } from "@arbitra/schemas/testing.js";
import { validateTraceability } from "@arbitra/workflow/nodes/planner/traceability.js";
import { validateRequirementsPlanTraceability } from "@arbitra/workflow/nodes/requirements/planner.js";
import type { TestGap } from "@arbitra/workflow/nodes/test-inventory.js";
import type { PlannerRecordSet } from "./planner-context.js";

/** Requirement IDs a plan must trace. Ambiguities, defaults, scope exclusions and the
 * request stay global in every stage; assumptions and acceptance are complete records. */
export function requirementRecordIds(requirements: RequirementsContract): readonly string[] {
  return [...requirements.assumptions, ...requirements.acceptance].map(({ id }) => id);
}

/** Complete requirement records for `ids`; unrelated records are indexed, not dropped. */
export function scopedRequirements(requirements: RequirementsContract, ids: readonly string[]) {
  const selected = new Set(ids);
  return { ...requirements, assumptions: requirements.assumptions.filter(({ id }) => selected.has(id)), acceptance: requirements.acceptance.filter(({ id }) => selected.has(id)),
    requirementScope: { completeRequirementSet: false, requirementIds: ids, requirementIndex: requirementIndex(requirements) } };
}

export function requirementIndex(requirements: RequirementsContract) {
  return [...requirements.assumptions.map(({ id }) => ({ id, kind: "assumption" as const })), ...requirements.acceptance.map(({ id }) => ({ id, kind: "acceptance" as const })), ...requirements.ambiguities.map(({ id }) => ({ id, kind: "ambiguity" as const }))];
}

/** Exploration surfaces relevant to the selected requirements, with their exact evidence. */
export function scopedExploration(exploration: FeatureExploration, ids: readonly string[]) {
  const selected = new Set(ids);
  const surfaces = exploration.preflight.affectedSurfaces.filter(({ relevantTo }) => relevantTo.some((id) => selected.has(id)));
  const surfaceIds = new Set(surfaces.map(({ id }) => id));
  return { ...exploration, preflight: { ...exploration.preflight, affectedSurfaces: surfaces }, evidence: exploration.evidence.filter(({ surfaceId }) => surfaceIds.has(surfaceId)),
    surfaceIndex: explorationIndex(exploration) };
}

export function explorationIndex(exploration: FeatureExploration) {
  return exploration.preflight.affectedSurfaces.map(({ id, paths, riskCategories, relevantTo }) => ({ id, paths, riskCategories, relevantTo }));
}

function requirementDiagnostics(requirements: RequirementsContract, mode: "feature" | "testing"): PlannerRecordSet["diagnostics"] {
  return (plan) => [...validateTraceability(plan, []), ...validateRequirementsPlanTraceability(requirements, plan, mode)];
}

export function featurePlannerRecords(requirements: RequirementsContract, exploration: FeatureExploration): PlannerRecordSet {
  return { mode: "feature", ids: requirementRecordIds(requirements),
    // featurePlannerNode also forwards the whole contract as a top-level planner field;
    // staged requests carry the scoped records once, inside projectContext.
    scoped: (ids) => ({ canonicalIssues: [], projectContext: { context: { exploration: scopedExploration(exploration, ids) }, requirements: scopedRequirements(requirements, ids) }, requirements: undefined }),
    outlineContext: {
      requirements: { featureRequest: requirements.featureRequest, ambiguities: requirements.ambiguities, outOfScope: requirements.outOfScope, decision: requirements.decision, requirementIndex: requirementIndex(requirements) },
      exploration: { summary: exploration.summary, preflight: { ...exploration.preflight, affectedSurfaces: explorationIndex(exploration) }, limitations: exploration.limitations,
        evidence: "Exact exploration evidence is supplied with each requirement brief and task expansion." },
    },
    addressed: (task) => task.addresses.requirements,
    diagnostics: requirementDiagnostics(requirements, "feature") };
}

export interface TestingPlannerContext {
  readonly requirements: RequirementsContract;
  readonly analysis: { readonly inputFingerprint: string; readonly inventory: unknown; readonly commands: readonly unknown[]; readonly risk: TestingRisk; readonly gaps: readonly TestGap[]; readonly limitations: readonly string[] } & Readonly<Record<string, unknown>>;
  readonly routing: readonly { readonly gapIds: readonly string[] }[];
  readonly trustedWriteAuthorization?: unknown;
}

export function testingPlannerRecords(context: TestingPlannerContext): PlannerRecordSet {
  const { requirements, analysis, routing } = context;
  const authorization = context.trustedWriteAuthorization === undefined ? {} : { trustedWriteAuthorization: context.trustedWriteAuthorization };
  return { mode: "testing", ids: requirementRecordIds(requirements),
    scoped: (ids) => {
      const selected = new Set(ids);
      const gaps = analysis.gaps.filter(({ id }) => selected.has(id));
      const surfaceIds = new Set(gaps.map(({ surfaceId }) => surfaceId));
      return { canonicalIssues: [], projectContext: { requirements: { ...scopedRequirements(requirements, ids), assumptions: requirements.assumptions },
        analysis: { ...analysis, gaps, risk: { ...analysis.risk, surfaces: analysis.risk.surfaces.filter(({ id }) => surfaceIds.has(id)) },
          gapIndex: analysis.gaps.map(({ id, surfaceId, category, priority }) => ({ id, surfaceId, category, priority })) },
        routing: routing.filter(({ gapIds }) => gapIds.some((id) => selected.has(id))), ...authorization } };
    },
    outlineContext: {
      requirements: { featureRequest: requirements.featureRequest, assumptions: requirements.assumptions, outOfScope: requirements.outOfScope, decision: requirements.decision, requirementIndex: requirementIndex(requirements) },
      analysis: { inputFingerprint: analysis.inputFingerprint, inventory: analysis.inventory, commands: analysis.commands, limitations: analysis.limitations,
        gapIndex: analysis.gaps.map(({ id, surfaceId, category, priority, suggestedPaths }) => ({ id, surfaceId, category, priority, suggestedPaths })),
        surfaceIndex: analysis.risk.surfaces.map(({ id, paths, severity, categories }) => ({ id, paths, severity, categories })) },
      routing, ...authorization,
    },
    addressed: (task) => task.addresses.requirements,
    diagnostics: requirementDiagnostics(requirements, "testing") };
}
