import { featureExplorationSchema, requirementsContractSchema, type FeatureExploration } from "@arbitra/schemas/requirements.js";
import { createHash } from "node:crypto";
import type { RequirementsContract } from "@arbitra/workflow/nodes/requirements/index.js";
import { anchorLineEvidence } from "./evidence-grounding.js";
import type { PlannerCompositionPort, PlannerStage } from "./planner-context.js";
import type { RepositorySnapshot } from "./repository.js";
import { requirementIndex } from "./requirement-records.js";

/** Exploration may propose scope, but every surface must retain grounded source evidence. */
export function validateFeatureExploration(value: unknown, requirements: RequirementsContract, snapshot: RepositorySnapshot): FeatureExploration {
  const contract = requirementsContractSchema.parse(requirements);
  const exploration = featureExplorationSchema.parse(value);
  const requirementIds = new Set([...contract.assumptions, ...contract.ambiguities, ...contract.acceptance].map(({ id }) => id));
  const files = new Map(snapshot.files.map((file) => [file.path, file]));
  const surfaces = new Map(exploration.preflight.affectedSurfaces.map((surface) => [surface.id, surface]));
  for (const surface of surfaces.values()) {
    if (surface.relevantTo.some((id) => !requirementIds.has(id))) throw new Error(`FEATURE_EXPLORATION_UNKNOWN_REQUIREMENT:${surface.id}`);
    for (const path of surface.paths) {
      if (!files.has(path)) throw new Error(`FEATURE_EXPLORATION_UNKNOWN_PATH:${path}`);
      if (!exploration.evidence.some((evidence) => evidence.surfaceId === surface.id && evidence.path === path)) throw new Error(`FEATURE_EXPLORATION_EVIDENCE_MISSING:${surface.id}:${path}`);
    }
  }
  exploration.evidence = exploration.evidence.map((evidence) => {
    const surface = surfaces.get(evidence.surfaceId);
    const anchored = surface === undefined || !surface.paths.includes(evidence.path) ? null : anchorLineEvidence(evidence, files.get(evidence.path));
    if (anchored === null) throw new Error("FEATURE_EXPLORATION_UNGROUNDED_EVIDENCE");
    return anchored;
  });
  return exploration;
}

/** Requirement records (assumptions, ambiguities and acceptance) for `ids` with their defaults;
 * the request, scope exclusions and a complete requirement index stay global. */
function explorationRequirements(requirements: RequirementsContract, ids: readonly string[]) {
  const selected = new Set(ids);
  return { ...requirements, assumptions: requirements.assumptions.filter(({ id }) => selected.has(id)), ambiguities: requirements.ambiguities.filter(({ id }) => selected.has(id)), acceptance: requirements.acceptance.filter(({ id }) => selected.has(id)),
    decision: { ...requirements.decision, acceptedDefaults: requirements.decision.acceptedDefaults.filter(({ ambiguityId }) => selected.has(ambiguityId)) },
    requirementScope: { completeRequirementSet: false, requirementIds: ids, requirementIndex: requirementIndex(requirementsContractSchema.parse(requirements)) } };
}

/** One exploration when it fits; otherwise durable requirement batches. Surfaces sharing an ID
 * merge by union of paths, categories and requirement links; exact evidence is retained and
 * batch metrics merge as conservative upper bounds so routing never under-reports risk. */
export async function exploreWithContext(requirements: RequirementsContract, snapshot: RepositorySnapshot, port: PlannerCompositionPort, maximumRecords: number): Promise<FeatureExploration> {
  const full: PlannerStage = { activityId: "exploration/full", instruction: "", input: { requirements }, schema: featureExplorationSchema, jsonSchema: featureExplorationSchema.toJSONSchema() };
  if (await port.fits(full)) return validateFeatureExploration(await port.call(full), requirements, snapshot);
  const ids = [...requirements.assumptions, ...requirements.ambiguities, ...requirements.acceptance].map(({ id }) => id);
  const request = (batch: readonly string[]): PlannerStage => ({ activityId: `exploration/batch/${createHash("sha256").update(JSON.stringify(batch)).digest("hex").slice(0, 24)}`,
    instruction: "Explore affected surfaces for one batch of approved Feature requirements: the complete requirement set cannot share one exploration context or response. Explore the requirement records in requirementScope.requirementIds and map every surface to recorded requirement IDs from the complete requirementIndex. Other batches are explored separately; surfaces with the same ID are merged by union, so reuse a surface ID only for the same code surface. Report the risk metrics for this batch.",
    input: { requirements: explorationRequirements(requirements, batch) }, schema: featureExplorationSchema, jsonSchema: featureExplorationSchema.toJSONSchema() });
  const batches: string[][] = []; let current: string[] = [];
  for (const id of ids) {
    if (current.length < maximumRecords && await port.fits(request([...current, id]))) { current.push(id); continue; }
    if (current.length > 0) batches.push(current);
    if (!await port.fits(request([id]))) throw new Error(`FEATURE_EXPLORATION_REQUIREMENT_CONTEXT_EXCEEDED:${id}`);
    current = [id];
  }
  if (current.length > 0) batches.push(current);
  if (batches.length === 0) throw new Error("MODEL_REQUIRED_CONTEXT_LIMIT_EXCEEDED");
  await port.publish("exploration-batches", batches.map((requirementIds) => ({ activityId: request(requirementIds).activityId, requirementIds })));
  const parts: FeatureExploration[] = [];
  for (const batch of batches) parts.push(validateFeatureExploration(await port.call(request(batch)), requirements, snapshot));
  const union = (left: readonly string[], right: readonly string[]) => [...new Set([...left, ...right])];
  const surfaces = new Map<string, FeatureExploration["preflight"]["affectedSurfaces"][number]>();
  for (const surface of parts.flatMap(({ preflight }) => preflight.affectedSurfaces)) {
    const existing = surfaces.get(surface.id);
    surfaces.set(surface.id, existing === undefined ? surface : { id: surface.id, paths: union(existing.paths, surface.paths), riskCategories: union(existing.riskCategories, surface.riskCategories), relevantTo: union(existing.relevantTo, surface.relevantTo) });
  }
  const evidence = [...new Map(parts.flatMap((part) => part.evidence).map((entry) => [JSON.stringify(entry), entry])).values()];
  const sum = (select: (part: FeatureExploration) => number) => parts.reduce((total, part) => total + select(part), 0);
  const merged = validateFeatureExploration({ summary: parts.map(({ summary }) => summary).join("\n"), evidence, limitations: [...new Set(parts.flatMap(({ limitations }) => limitations))],
    preflight: { affectedSurfaces: [...surfaces.values()], securitySensitiveSurfaceCount: Math.min(surfaces.size, sum(({ preflight }) => preflight.securitySensitiveSurfaceCount)),
      migrationInvolvement: parts.some(({ preflight }) => preflight.migrationInvolvement), architectureBreadth: sum(({ preflight }) => preflight.architectureBreadth), testingComplexity: sum(({ preflight }) => preflight.testingComplexity) } }, requirements, snapshot);
  await port.publish("exploration-composition", { kind: "requirement_batches_merged_by_surface", batches: batches.length, surfaces: surfaces.size, metrics: "conservative_upper_bound_of_batch_metrics" });
  return merged;
}
