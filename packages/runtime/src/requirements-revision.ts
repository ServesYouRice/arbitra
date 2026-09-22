import { canonicalJson } from "@arbitra/core/config/config-store.js";
import { requirementsRevisionSchema, requirementsRevisionProposalSchema, type RequirementsRevision } from "@arbitra/schemas/requirements-revision.js";
import type { RequirementsContract } from "@arbitra/schemas/requirements.js";
import type { RequirementsCheckpoint } from "./requirements-checkpoint.js";
import type { RunStore } from "./run-store.js";
import type { RepositorySnapshot } from "./repository.js";
import { featureReviewConsensus, type FeatureReviewerResult } from "./feature-review.js";

export function validateRequirementsRevision(value: unknown, contract: RequirementsContract, blockingIds: readonly string[]): RequirementsRevision {
  const revised = requirementsRevisionSchema.parse(value);
  const original = new Map<string, string>(); const next = new Map<string, string>();
  for (const kind of ["assumptions", "ambiguities", "acceptance"] as const) {
    contract[kind].forEach(({ id }) => original.set(id, kind));
    revised.draft[kind].forEach(({ id }) => next.set(id, kind));
  }
  if (!sameIds([...original.keys()], revised.lineage.map(({ previousRequirementId }) => previousRequirementId))) throw new Error("REQUIREMENTS_REVISION_LINEAGE_INCOMPLETE");
  if (!sameIds(blockingIds, revised.resolutions.map(({ requirementId }) => requirementId))) throw new Error("REQUIREMENTS_REVISION_RESOLUTIONS_INCOMPLETE");
  const referenced = new Set<string>();
  for (const item of revised.lineage) {
    const kind = original.get(item.previousRequirementId);
    if (new Set(item.nextRequirementIds).size !== item.nextRequirementIds.length || item.nextRequirementIds.some((id) => next.get(id) !== kind)
      || next.has(item.previousRequirementId) && !item.nextRequirementIds.includes(item.previousRequirementId)) throw new Error("REQUIREMENTS_REVISION_LINEAGE_INVALID");
    if (kind === "acceptance" && item.nextRequirementIds.length === 0) throw new Error("REQUIREMENTS_REVISION_ACCEPTANCE_DROPPED");
    const ambiguity = contract.ambiguities.find(({ id }) => id === item.previousRequirementId);
    if (ambiguity?.blastRadius === "high" && !item.nextRequirementIds.some((id) => revised.draft.ambiguities.some((candidate) => candidate.id === id && candidate.blastRadius === "high"))) throw new Error("REQUIREMENTS_REVISION_APPROVAL_BYPASSED");
    item.nextRequirementIds.forEach((id) => referenced.add(id));
  }
  if (!sameIds([...next.keys()].filter((id) => !referenced.has(id)), revised.addedRequirementIds)
    || revised.addedRequirementIds.some((id) => original.has(id))) throw new Error("REQUIREMENTS_REVISION_ADDED_IDS_INVALID");
  if (contract.outOfScope.some((constraint) => !revised.draft.outOfScope.includes(constraint))) throw new Error("REQUIREMENTS_REVISION_SCOPE_WIDENED");
  const { assumptions, ambiguities, acceptance, outOfScope } = contract;
  if (canonicalJson(revised.draft) === canonicalJson({ assumptions, ambiguities, acceptance, outOfScope })) throw new Error("REQUIREMENTS_REVISION_NO_CHANGE");
  return revised;
}

export async function readRequirementsProposal(store: RunStore, artifactId: string) {
  const artifact = await store.readArtifact(artifactId);
  if (!artifact.descriptor.kind.startsWith("requirements-revision-proposal-")) throw new Error("INVALID_REQUIREMENTS_REVISION_ARTIFACT");
  return requirementsRevisionProposalSchema.parse(JSON.parse(artifact.content));
}

export async function applyRequirementsProposal(store: RunStore, checkpoint: RequirementsCheckpoint, artifactId: string, snapshot: RepositorySnapshot) {
  const proposal = await readRequirementsProposal(store, artifactId);
  const current = await checkpoint.current();
  if (current?.artifactId !== proposal.baseArtifactId) throw new Error("STALE_REQUIREMENTS_CHECKPOINT");
  const reviewArtifact = await store.readArtifact(proposal.reviewArtifactId);
  if (!reviewArtifact.descriptor.kind.startsWith("requirements-revision-review-")) throw new Error("INVALID_REQUIREMENTS_REVISION_REVIEW");
  const reviewed = JSON.parse(reviewArtifact.content) as { inputFingerprint: string; reviewers: FeatureReviewerResult[] };
  if (reviewed.inputFingerprint !== proposal.inputFingerprint) throw new Error("REQUIREMENTS_REVISION_REVIEW_STALE");
  const consensus = featureReviewConsensus(current.contract, snapshot, reviewed.reviewers);
  if (consensus.blockingRequirementIds.length === 0 || consensus.limitations.length > 0) throw new Error("REQUIREMENTS_REVISION_REVIEW_INVALID");
  const revision = validateRequirementsRevision(proposal.revision, current.contract, consensus.blockingRequirementIds);
  // Checkpoint revision serializes the comparison and commit and clears approvals.
  return checkpoint.revise(proposal.baseArtifactId, revision.draft);
}

/** Resolution claims follow a draft through renewed approvals, but not an unrelated edit. */
export async function requirementsRevisionContext(store: RunStore, contract: RequirementsContract) {
  const pointer = (await store.listArtifacts()).find(({ kind }) => kind === "requirements-revision-proposal-current");
  if (pointer === undefined) return undefined;
  const current = await store.artifacts.get<{ artifactId: string }>(pointer.ref);
  const proposal = await readRequirementsProposal(store, current.artifactId);
  const { assumptions, ambiguities, acceptance, outOfScope } = contract;
  if (canonicalJson({ assumptions, ambiguities, acceptance, outOfScope }) !== canonicalJson(proposal.revision.draft)) return undefined;
  const originalRequirements: unknown = JSON.parse((await store.readArtifact(proposal.baseArtifactId)).content);
  const review = JSON.parse((await store.readArtifact(proposal.reviewArtifactId)).content) as { reviewers: { review: unknown }[] };
  return { originalRequirements, originalReviews: review.reviewers.map(({ review }) => review), proposedResolutions: proposal.revision.resolutions, lineage: proposal.revision.lineage, addedRequirementIds: proposal.revision.addedRequirementIds };
}

function sameIds(expected: readonly string[], actual: readonly string[]): boolean {
  return new Set(expected).size === expected.length && new Set(actual).size === actual.length && expected.length === actual.length && expected.every((id) => actual.includes(id));
}
