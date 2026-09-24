import type { PlanIR } from "@arbitra/schemas/plan.js";
import type { CanonicalIssueSet } from "@arbitra/workflow/nodes/canonical-issues.js";
import { peerReviewBatches, segmentText, type PeerReviewSegment } from "./peer-review-batches.js";
import type { StructuredCritique } from "@arbitra/workflow/nodes/critic/node.js";
import type { RevisionResolution } from "@arbitra/workflow/nodes/revision.js";

export interface CriticRevisionContext { readonly priorCritique: StructuredCritique; readonly proposedResolutions: readonly RevisionResolution[] }

export interface CriticContextPart {
  readonly kind: "full" | "review" | "pair_check";
  readonly recordIds: readonly string[];
  readonly input: unknown;
  /** Present when two complete records cannot share a context: this record is read as
   * exact consecutive segments of its canonical JSON across several pair checks. */
  readonly segment?: PeerReviewSegment;
}

/** Stable durable identity material for a part; unsegmented parts keep their prior identity. */
export function criticPartIdentity(part: CriticContextPart): string {
  return JSON.stringify(part.segment === undefined ? [part.kind, part.recordIds] : [part.kind, part.recordIds, part.segment]);
}

/** Keep global relationships intact and cover every complete record and record pair.
 * A partial plan is explicitly labelled; it is never presented as the entire plan. */
/** Mode-specific complete records reviewed alongside the plan, e.g. Feature
 * requirements and grounded exploration surfaces. Each is a first-class record. */
export type CriticSupplementalRecords = Readonly<Record<string, readonly { readonly id: string }[]>>;

export async function criticContextParts(plan: PlanIR, issues: CanonicalIssueSet["issues"], necessaryContext: unknown, fits: (part: CriticContextPart) => Promise<boolean>, revisionContext: CriticRevisionContext | null = null, maximumRecords = 20, supplemental: CriticSupplementalRecords = {}): Promise<readonly CriticContextPart[]> {
  if (revisionContext !== null) {
    const ids = revisionContext.priorCritique.items.map(({ id }) => id);
    const resolutions = revisionContext.proposedResolutions.map(({ critiqueItemId }) => critiqueItemId);
    const blockingIds = revisionContext.priorCritique.items.filter(({ blocking }) => blocking).map(({ id }) => id);
    if (new Set(ids).size !== ids.length || new Set(resolutions).size !== resolutions.length || resolutions.some((id) => !blockingIds.includes(id)) || blockingIds.some((id) => !resolutions.includes(id))) throw new Error("INVALID_CRITIC_REVISION_CONTEXT");
  }
  const records = [...plan.tasks.map(({ id }) => `task:${id}`), ...issues.map(({ candidateId }) => `issue:${candidateId}`), ...plan.validationContract.validation.map(({ id }) => `validation:${id}`),
    ...(revisionContext === null ? [] : ["revision-summary", ...revisionContext.priorCritique.items.map(({ id }) => `revision:${id}`)]),
    ...Object.entries(supplemental).flatMap(([key, entries]) => entries.map(({ id }) => `${key}:${id}`))];
  if (new Set(records).size !== records.length) throw new Error("DUPLICATE_CRITIC_RECORD");
  const full: CriticContextPart = { kind: "full", recordIds: records, input: { plan, validationContract: plan.validationContract, canonicalIssues: issues, necessaryContext, ...(revisionContext === null ? {} : { revisionContext }), ...supplemental } };
  if (records.length <= maximumRecords && await fits(full)) return [full];
  const index = {
    tasks: plan.tasks.map(({ id, addresses, dependencies, scope }) => ({ id, addresses, dependencies, scope })),
    issueIds: issues.map(({ candidateId }) => candidateId),
    validationIds: plan.validationContract.validation.map(({ id }) => id),
    ...(revisionContext === null ? {} : { priorCritique: revisionContext.priorCritique.items.map(({ id, taskIds, issueIds, blocking }) => ({ id, taskIds, issueIds, blocking })), resolutionIds: revisionContext.proposedResolutions.map(({ critiqueItemId }) => critiqueItemId) }),
    ...(Object.keys(supplemental).length === 0 ? {} : { supplementalIds: Object.fromEntries(Object.entries(supplemental).map(([key, entries]) => [key, entries.map(({ id }) => id)])) }),
  };
  const recordValue = (recordId: string): unknown => {
    const [kind, ...rest] = recordId.split(":"); const id = rest.join(":");
    if (kind === "task") return plan.tasks.find((task) => task.id === id);
    if (kind === "issue") return issues.find(({ candidateId }) => candidateId === id);
    if (kind === "validation") return plan.validationContract.validation.find((entry) => entry.id === id);
    if (recordId === "revision-summary") return revisionContext?.priorCritique.summary;
    if (kind === "revision") return { item: revisionContext?.priorCritique.items.find((item) => item.id === id), proposedResolution: revisionContext?.proposedResolutions.find(({ critiqueItemId }) => critiqueItemId === id) };
    return supplemental[kind ?? ""]?.find((entry) => entry.id === id);
  };
  const part = (recordIds: readonly string[], kind: "review" | "pair_check", segment?: PeerReviewSegment): CriticContextPart => {
    const selected = new Set(recordIds.filter((id) => id !== segment?.candidateId));
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
      ...Object.fromEntries(Object.entries(supplemental).map(([key, entries]) => [key, entries.filter(({ id }) => selected.has(`${key}:${id}`))])),
      ...(segment === undefined ? {} : { segmentedRecord: { recordId: segment.candidateId, segment: segment.index + 1, segmentCount: segment.count,
        exactJsonText: segmentText(JSON.stringify(recordValue(segment.candidateId)), segment),
        instruction: "This record is too large to share a context with the other complete record. Its canonical JSON is split into exact consecutive segments across separate durable pair checks; together they contain the whole record. Judge relationships visible in this segment; do not treat text outside it as missing." } }),
    }, ...(segment === undefined ? {} : { segment }) };
  };
  if (records.length === 0) throw new Error("CRITIC_GLOBAL_CONTEXT_LIMIT_EXCEEDED");
  const batches = await peerReviewBatches(records, (batch) => fits(part(batch.candidateIds, batch.kind === "review" ? "review" : "pair_check", batch.segment)), maximumRecords);
  return batches.map((batch) => part(batch.candidateIds, batch.kind === "review" ? "review" : "pair_check", batch.segment));
}
