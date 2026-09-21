import { featureExplorationSchema, requirementsContractSchema, type FeatureExploration } from "@arbitra/schemas/requirements.js";
import type { RequirementsContract } from "@arbitra/workflow/nodes/requirements/index.js";
import type { RepositorySnapshot } from "./repository.js";

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
  for (const evidence of exploration.evidence) {
    const surface = surfaces.get(evidence.surfaceId); const file = files.get(evidence.path);
    if (surface === undefined || !surface.paths.includes(evidence.path) || file === undefined || evidence.endLine < evidence.startLine || evidence.endLine > file.lines.length
      || file.lines.slice(evidence.startLine - 1, evidence.endLine).join("\n") !== evidence.text) throw new Error("FEATURE_EXPLORATION_UNGROUNDED_EVIDENCE");
  }
  return exploration;
}
