import type { PlanIR } from "@arbitra/schemas/plan.js";
import type { CanonicalIssueSet } from "@arbitra/workflow/nodes/canonical-issues.js";
import { reviewPartition, segmentedPair, segmentText, type PeerReviewSegment } from "./peer-review-batches.js";
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
  /** Present on a packed pair check: the cross-batch record pairs it covers. */
  readonly pairs?: readonly (readonly [string, string])[];
}

/** Stable durable identity material for a part; unsegmented, unpacked parts keep their prior identity. */
export function criticPartIdentity(part: CriticContextPart): string {
  if (part.pairs !== undefined) return JSON.stringify([part.kind, part.recordIds, part.pairs]);
  return JSON.stringify(part.segment === undefined ? [part.kind, part.recordIds] : [part.kind, part.recordIds, part.segment]);
}

/** Keep global relationships intact and cover every complete record and record pair.
 * A partial plan is explicitly labelled; it is never presented as the entire plan. */
/** Mode-specific complete records reviewed alongside the plan, e.g. Feature
 * requirements and grounded exploration surfaces. Each is a first-class record. */
export type CriticSupplementalRecords = Readonly<Record<string, readonly { readonly id: string }[]>>;

export async function criticContextParts(plan: PlanIR, issues: CanonicalIssueSet["issues"], necessaryContext: unknown, fits: (part: CriticContextPart) => Promise<boolean>, revisionContext: CriticRevisionContext | null = null, maximumRecords = 20, supplemental: CriticSupplementalRecords = {}, admits?: (part: CriticContextPart) => Promise<boolean>, pairChecks = true): Promise<readonly CriticContextPart[]> {
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
    // A task's files show which tasks of other batches change the same code; its components and interfaces are read with the task.
    tasks: plan.tasks.map(({ id, addresses, dependencies, scope }) => ({ id, addresses, dependencies, files: scope.likelyFiles })),
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
  // A batch carries the plan-wide notes that name one of its records or none, the routing of its own tasks, and not the
  // planner's reasoning about the whole plan. Observed live (veritra, a 227-task plan of 1.4 MB): the rest of the plan
  // beside one task was 370 KB, more than the critic's whole context at the run's bytes a token, so no batch fit.
  const knownIds = [...plan.tasks.map(({ id }) => id), ...issues.map(({ candidateId }) => candidateId), ...plan.validationContract.validation.map(({ id }) => id)];
  const naming = knownIds.length === 0 ? null : new RegExp([...knownIds].sort((a, b) => b.length - a.length).map((id) => id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|"), "gu");
  const notes = <T>(entries: readonly T[], text: (entry: T) => string) => entries.map((entry) => ({ entry, names: new Set(naming === null ? [] : text(entry).match(naming) ?? []) }));
  const planNotes = { implementationStrategy: notes(plan.implementationStrategy, String), dependencies: notes(plan.dependencies, String), rolloutConcerns: notes(plan.rolloutConcerns, String),
    migrationConcerns: notes(plan.migrationConcerns, String), unresolvedQuestions: notes(plan.unresolvedQuestions, ({ question }) => question) };
  const part = (recordIds: readonly string[], kind: "review" | "pair_check", segment?: PeerReviewSegment, pairs?: readonly (readonly [string, string])[]): CriticContextPart => {
    const selected = new Set(recordIds.filter((id) => id !== segment?.candidateId));
    const validationContract = { ...plan.validationContract, validation: plan.validationContract.validation.filter(({ id }) => selected.has(`validation:${id}`)) };
    const own = new Set([...selected].map((recordId) => recordId.slice(recordId.indexOf(":") + 1)));
    const about = <T>(scoped: readonly { entry: T; names: ReadonlySet<string> }[]) => scoped.filter(({ names }) => names.size === 0 || [...names].some((id) => own.has(id))).map(({ entry }) => entry);
    return { kind, recordIds, input: {
      reviewScope: pairs === undefined
        ? { kind, recordIds, completePlan: false, globalIndex: index, instruction: "Other full records are reviewed in separate durable batches. Use global maps for relationships; do not report a missing record merely because it is outside this batch." }
        : { kind, recordIds, pairs, completePlan: false, globalIndex: index, instruction: "Each record here was already reviewed in full in its own batch. Check only relationships between the listed record pairs; do not repeat findings about a single record, and do not report a missing record merely because it is outside this batch." },
      plan: { ...plan, reasoningOutcome: "Left out of this batch: the planner's reasoning about the whole plan is read with the complete plan only.",
        implementationStrategy: about(planNotes.implementationStrategy), dependencies: about(planNotes.dependencies), rolloutConcerns: about(planNotes.rolloutConcerns),
        migrationConcerns: about(planNotes.migrationConcerns), unresolvedQuestions: about(planNotes.unresolvedQuestions),
        routingRecommendations: plan.routingRecommendations.filter(({ taskId }) => selected.has(`task:${taskId}`)),
        tasks: plan.tasks.filter(({ id }) => selected.has(`task:${id}`)), validationContract },
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
    }, ...(segment === undefined ? {} : { segment }), ...(pairs === undefined ? {} : { pairs }) };
  };
  if (records.length === 0) throw new Error("CRITIC_GLOBAL_CONTEXT_LIMIT_EXCEEDED");
  const primary = await reviewPartition(records, (ids) => fits(part(ids, "review")), maximumRecords, admits === undefined ? undefined : (ids) => admits(part(ids, "review")));
  const parts = primary.map((ids) => part(ids, "review"));
  // Without pair checks every record is still read whole in its own batch, with the global index of the plan;
  // records of different batches are not read together. Observed live (P20 pilot): 96 of 107 critic calls on one
  // plan were pair checks.
  if (!pairChecks) return parts;
  // Cover every cross-batch pair. A critique has no one-operation-per-call limit, so pairs are
  // packed into as few calls as fit (observed live: 152 one-pair checks for one revised plan).
  const rank = new Map(records.map((id, position) => [id, position]));
  const key = (left: string, right: string) => JSON.stringify([left, right]);
  const pending = new Map<string, readonly [string, string]>();
  for (let a = 0; a < primary.length; a += 1) for (const right of primary.slice(a + 1)) for (const leftId of primary[a] ?? []) for (const rightId of right) pending.set(key(leftId, rightId), [leftId, rightId]);
  const covered = (members: ReadonlySet<string>) => [...pending.values()].filter(([left, right]) => members.has(left) && members.has(right));
  const packed = (members: ReadonlySet<string>): CriticContextPart => {
    const pairs = covered(members); const [only] = pairs;
    return pairs.length === 1 && only !== undefined ? part(only, "pair_check") : part([...members].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0)), "pair_check", undefined, pairs);
  };
  while (pending.size > 0) {
    const [first] = pending.values(); if (first === undefined) break;
    const [leftId, rightId] = first;
    if (!await fits(part([leftId, rightId], "pair_check"))) {
      const segmented = await segmentedPair(leftId, rightId, (batch) => fits(part(batch.candidateIds, "pair_check", batch.segment)));
      if (segmented === null) throw new Error(`PEER_PAIR_CONTEXT_LIMIT_EXCEEDED:${leftId}:${rightId}`);
      parts.push(...segmented.map((batch) => part(batch.candidateIds, "pair_check", batch.segment)));
      pending.delete(key(leftId, rightId)); continue;
    }
    const members = new Set([leftId, rightId]); const tried = new Set<string>();
    while (members.size < maximumRecords) {
      let best: string | undefined; let bestGain = 0;
      for (const id of records) {
        if (members.has(id) || tried.has(id)) continue;
        const gain = [...members].filter((member) => pending.has(key(id, member)) || pending.has(key(member, id))).length;
        if (gain > bestGain) { best = id; bestGain = gain; }
      }
      if (best === undefined) break;
      tried.add(best);
      if (await fits(packed(new Set([...members, best])))) members.add(best);
    }
    parts.push(packed(members));
    for (const [left, right] of covered(members)) pending.delete(key(left, right));
  }
  return parts;
}
