import { featureReviewSchema, type FeatureReview } from "@arbitra/schemas/feature-review.js";
import type { RequirementBehaviourConflict } from "@arbitra/schemas/documented-behaviour.js";
import { requirementsContractSchema, type FeatureExploration } from "@arbitra/schemas/requirements.js";
import { featureComplexityGate, type RequirementsContract } from "@arbitra/workflow/nodes/requirements/index.js";
import type { RunStore } from "./run-store.js";
import { anchorLineEvidence } from "./evidence-grounding.js";
import { blocksRequirements, groundRequirementConflicts } from "./documented-behaviour.js";
import type { RepositorySnapshot } from "./repository.js";
import { createHash } from "node:crypto";
import { canonicalJson } from "@arbitra/core/config/config-store.js";

export interface FeatureReviewerResult { readonly reviewerId: string; readonly independenceGroup: string; readonly review: FeatureReview }
/** A persisted review round. Exploration conflicts are recorded with it, so every later consensus sees them. */
export interface FeatureReviewRecord { readonly inputFingerprint: string; readonly reviewers: FeatureReviewerResult[]; readonly explorationConflicts?: readonly RequirementBehaviourConflict[] }

export async function requireFeatureReview(store: RunStore, requirements: RequirementsContract, exploration: FeatureExploration, snapshot: RepositorySnapshot): Promise<void> {
  const artifacts = await store.listArtifacts();
  if (!featureComplexityGate(requirements, exploration.preflight).stages.includes("targeted_review") && !artifacts.some(({ kind }) => kind === "feature-requirements-revisions")) return;
  const descriptor = artifacts.find(({ kind }) => kind === "feature-review-consensus");
  if (descriptor === undefined) throw new Error("FEATURE_PLAN_REVIEW_REQUIRED");
  const saved = await store.artifacts.get<FeatureReviewRecord>(descriptor.ref);
  if (saved.inputFingerprint !== featureReviewInputFingerprint(requirements, exploration, snapshot)) throw new Error("FEATURE_PLAN_REVIEW_STALE");
  const review = featureReviewConsensus(requirements, snapshot, saved.reviewers, saved.explorationConflicts);
  if (review.blockingRequirementIds.length > 0 || review.limitations.length > 0) throw new Error("FEATURE_PLAN_REVIEW_UNRESOLVED");
}

export async function reviewFeatureRounds(requirements: RequirementsContract, snapshot: RepositorySnapshot,
  reviewers: readonly { readonly reviewerId: string; readonly independenceGroup: string }[], maximumRounds: number,
  ports: {
    review(input: { readonly reviewerId: string; readonly round: number; readonly peerReviews: readonly FeatureReview[] }): Promise<unknown>;
    persist(round: number, reviewers: readonly FeatureReviewerResult[], consensus: ReturnType<typeof featureReviewConsensus>): Promise<void>;
  }, explorationConflicts: readonly RequirementBehaviourConflict[] = []) {
  if (!Number.isSafeInteger(maximumRounds) || maximumRounds < 1 || maximumRounds > 3) throw new Error("INVALID_FEATURE_REVIEW_ROUND_LIMIT");
  if (reviewers.length < 2 || new Set(reviewers.map(({ reviewerId }) => reviewerId)).size !== reviewers.length
    || new Set(reviewers.map(({ independenceGroup }) => independenceGroup)).size !== reviewers.length
    || reviewers.some(({ reviewerId, independenceGroup }) => reviewerId.trim() === "" || independenceGroup.trim() === "")) throw new Error("FEATURE_REVIEW_INDEPENDENCE_REQUIRED");
  let previous: readonly FeatureReviewerResult[] = [];
  // No reviewer round can accept a requirement the exploration names in a conflict.
  const conflicted = new Set(explorationConflicts.filter(blocksRequirements).flatMap(({ requirementIds }) => requirementIds));
  for (let round = 1; round <= maximumRounds; round += 1) {
    const settled = await Promise.allSettled(reviewers.map(async (reviewer) => ({ ...reviewer,
      review: validateFeatureReview(await ports.review({ reviewerId: reviewer.reviewerId, round,
        peerReviews: structuredClone(previous.filter(({ reviewerId }) => reviewerId !== reviewer.reviewerId).map(({ review }) => review)) }), requirements, snapshot),
    })));
    const failed = settled.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    const results = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const consensus = featureReviewConsensus(requirements, snapshot, results, explorationConflicts);
    await ports.persist(round, results, consensus);
    if (consensus.blockingRequirementIds.length === 0 && consensus.limitations.length === 0 || round === maximumRounds
      || consensus.blockingRequirementIds.length > 0 && consensus.blockingRequirementIds.every((id) => conflicted.has(id))) return consensus;
    previous = results;
  }
  throw new Error("FEATURE_REVIEW_ROUND_ABSENT");
}

export function featureReviewInputFingerprint(requirements: RequirementsContract, exploration: unknown, snapshot: RepositorySnapshot): string {
  return createHash("sha256").update(canonicalJson({ requirements, exploration: withoutEmptyConflicts(exploration), files: snapshot.files })).digest("hex");
}

/** An exploration without conflicts keeps the identity it had before conflicts were recorded. */
function withoutEmptyConflicts(exploration: unknown): unknown {
  if (typeof exploration !== "object" || exploration === null || !("documentedBehaviourConflicts" in exploration)) return exploration;
  const { documentedBehaviourConflicts, ...rest } = exploration;
  return Array.isArray(documentedBehaviourConflicts) && documentedBehaviourConflicts.length === 0 ? rest : exploration;
}

export function validateFeatureReview(value: unknown, requirements: RequirementsContract, snapshot: RepositorySnapshot): FeatureReview {
  const contract = requirementsContractSchema.parse(requirements);
  const review = groundFeatureReview(value, contract, snapshot);
  const ids = new Set([...contract.assumptions, ...contract.ambiguities, ...contract.acceptance].map(({ id }) => id));
  if (review.decisions.length !== ids.size || review.decisions.some(({ requirementId }) => !ids.has(requirementId))) throw new Error("FEATURE_REVIEW_REQUIREMENT_COVERAGE");
  return review;
}

/** Every quotation in a review, grounded: decision evidence and conflicts quote the snapshot, or
 * the request with a null path. Model calls parse with it, so a misquote is repaired. */
export function groundFeatureReview(value: unknown, requirements: RequirementsContract, snapshot: RepositorySnapshot): FeatureReview {
  const review = featureReviewSchema.parse(value);
  const ids = new Set([...requirements.assumptions, ...requirements.ambiguities, ...requirements.acceptance].map(({ id }) => id));
  const files = new Map(snapshot.files.map((file) => [file.path, file]));
  for (const decision of review.decisions) decision.evidence = decision.evidence.map((evidence) => {
    const { path, startLine, endLine } = evidence;
    if (path === null || startLine === null || endLine === null) {
      if (!requirements.featureRequest.includes(evidence.text)) throw new Error(`FEATURE_REVIEW_UNGROUNDED_EVIDENCE: evidence for ${decision.requirementId} has a null path, so its text must be an exact excerpt of the request`);
      return evidence;
    }
    const anchored = anchorLineEvidence({ ...evidence, path, startLine, endLine }, files.get(path));
    if (anchored === null) throw new Error(`FEATURE_REVIEW_UNGROUNDED_EVIDENCE: evidence for ${decision.requirementId} must quote whole lines of ${path} exactly`);
    return anchored;
  });
  review.documentedBehaviourConflicts = groundRequirementConflicts(review.documentedBehaviourConflicts, ids, snapshot, requirements.featureRequest);
  return review;
}

/** Preserve disagreement and proposals; reviews never mutate operator-approved defaults. A requirement
 * that any reviewer or the exploration says adopts, or leaves open, behaviour its documentation
 * contradicts is never accepted. */
export function featureReviewConsensus(requirements: RequirementsContract, snapshot: RepositorySnapshot, reviewers: readonly FeatureReviewerResult[], explorationConflicts: readonly RequirementBehaviourConflict[] = []) {
  if (reviewers.length < 2 || reviewers.some(({ reviewerId, independenceGroup }) => reviewerId.trim() === "" || independenceGroup.trim() === "")
    || new Set(reviewers.map(({ reviewerId }) => reviewerId)).size !== reviewers.length
    || new Set(reviewers.map(({ independenceGroup }) => independenceGroup)).size !== reviewers.length) throw new Error("FEATURE_REVIEW_INDEPENDENCE_REQUIRED");
  const validated = reviewers.map((reviewer) => ({ ...reviewer, review: validateFeatureReview(reviewer.review, requirements, snapshot) }));
  const conflicts = [...validated.flatMap(({ reviewerId, review }) => review.documentedBehaviourConflicts.map((conflict) => ({ reportedBy: reviewerId, ...conflict }))),
    ...explorationConflicts.map((conflict) => ({ reportedBy: "exploration", ...conflict }))].filter(blocksRequirements);
  const decisions = [...requirements.assumptions, ...requirements.ambiguities, ...requirements.acceptance].map(({ id }) => {
    const votes = validated.map(({ reviewerId, review }) => {
      const decision = review.decisions.find(({ requirementId }) => requirementId === id);
      if (decision === undefined) throw new Error("FEATURE_REVIEW_REQUIREMENT_COVERAGE");
      return { reviewerId, ...decision };
    });
    const named = conflicts.filter(({ requirementIds }) => requirementIds.includes(id));
    const disposition = votes.every(({ disposition }) => disposition === "accept") ? named.length === 0 ? "accepted" as const : "unresolved" as const
      : votes.every(({ disposition, proposedChange }) => disposition === "revise" && proposedChange === votes[0]?.proposedChange) ? "revision_required" as const : "unresolved" as const;
    return { requirementId: id, disposition, votes, ...(named.length === 0 ? {} : { documentedBehaviourConflicts: named }) };
  });
  return { decisions, blockingRequirementIds: decisions.filter(({ disposition }) => disposition !== "accepted").map(({ requirementId }) => requirementId), limitations: validated.flatMap(({ reviewerId, review }) => review.limitations.map((limitation) => ({ reviewerId, limitation }))) };
}
