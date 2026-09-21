import type { PlanIR } from "@arbitra/schemas/plan.js";
import type { CanonicalIssueSet } from "@arbitra/workflow/nodes/canonical-issues.js";
import { peerReviewBatches } from "./peer-review-batches.js";
import type { StructuredCritique } from "@arbitra/workflow/nodes/critic/node.js";
import type { RevisionResolution } from "@arbitra/workflow/nodes/revision.js";

export interface CriticRevisionContext { readonly priorCritique: StructuredCritique; readonly proposedResolutions: readonly RevisionResolution[] }

export interface CriticContextPart {
  readonly kind: "full" | "review" | "pair_check";
  readonly recordIds: readonly string[];
  readonly input: unknown;
}

/** Keep global relationships intact and cover every complete record and record pair.
 * A partial plan is explicitly labelled; it is never presented as the entire plan. */
export async function criticContextParts(plan: PlanIR, issues: CanonicalIssueSet["issues"], necessaryContext: unknown, fits: (part: CriticContextPart) => Promise<boolean>, revisionContext: CriticRevisionContext | null = null): Promise<readonly CriticContextPart[]> {
  if (revisionContext !== null) {
    const ids = revisionContext.priorCritique.items.map(({ id }) => id);
    const resolutions = revisionContext.proposedResolutions.map(({ critiqueItemId }) => critiqueItemId);
    const blockingIds = revisionContext.priorCritique.items.filter(({ blocking }) => blocking).map(({ id }) => id);
    if (new Set(ids).size !== ids.length || new Set(resolutions).size !== resolutions.length || resolutions.some((id) => !blockingIds.includes(id)) || blockingIds.some((id) => !resolutions.includes(id))) throw new Error("INVALID_CRITIC_REVISION_CONTEXT");
  }
  const records = [...plan.tasks.map(({ id }) => `task:${id}`), ...issues.map(({ candidateId }) => `issue:${candidateId}`), ...plan.validationContract.validation.map(({ id }) => `validation:${id}`),
    ...(revisionContext === null ? [] : ["revision-summary", ...revisionContext.priorCritique.items.map(({ id }) => `revision:${id}`)])];
  const full: CriticContextPart = { kind: "full", recordIds: records, input: { plan, validationContract: plan.validationContract, canonicalIssues: issues, necessaryContext, ...(revisionContext === null ? {} : { revisionContext }) } };
  if (await fits(full)) return [full];
  const index = {
    tasks: plan.tasks.map(({ id, addresses, dependencies, scope }) => ({ id, addresses, dependencies, scope })),
    issueIds: issues.map(({ candidateId }) => candidateId),
    validationIds: plan.validationContract.validation.map(({ id }) => id),
    ...(revisionContext === null ? {} : { priorCritique: revisionContext.priorCritique.items.map(({ id, taskIds, issueIds, blocking }) => ({ id, taskIds, issueIds, blocking })), resolutionIds: revisionContext.proposedResolutions.map(({ critiqueItemId }) => critiqueItemId) }),
  };
  const part = (recordIds: readonly string[], kind: "review" | "pair_check"): CriticContextPart => {
    const selected = new Set(recordIds);
    const validationContract = { ...plan.validationContract, validation: plan.validationContract.validation.filter(({ id }) => selected.has(`validation:${id}`)) };
    return { kind, recordIds, input: {
      reviewScope: { kind, recordIds, completePlan: false, globalIndex: index, instruction: "Other full records are reviewed in separate durable batches. Use global maps for relationships; do not report a missing record merely because it is outside this batch." },
      plan: { ...plan, tasks: plan.tasks.filter(({ id }) => selected.has(`task:${id}`)), validationContract },
      validationContract,
      canonicalIssues: issues.filter(({ candidateId }) => selected.has(`issue:${candidateId}`)), necessaryContext,
      ...(revisionContext === null ? {} : { revisionContext: {
        priorCritique: { summary: selected.has("revision-summary") ? revisionContext.priorCritique.summary : "Prior summary is supplied in a separate review record.", items: revisionContext.priorCritique.items.filter(({ id }) => selected.has(`revision:${id}`)) },
        proposedResolutions: revisionContext.proposedResolutions.filter(({ critiqueItemId }) => selected.has(`revision:${critiqueItemId}`)),
      } }),
    } };
  };
  if (records.length === 0) throw new Error("CRITIC_GLOBAL_CONTEXT_LIMIT_EXCEEDED");
  const batches = await peerReviewBatches(records, (batch) => fits(part(batch.candidateIds, batch.kind === "review" ? "review" : "pair_check")));
  return batches.map((batch) => part(batch.candidateIds, batch.kind === "review" ? "review" : "pair_check"));
}
