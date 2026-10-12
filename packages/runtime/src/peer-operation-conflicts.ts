import type { IssueOperation } from "@arbitra/core/issue-board/operations.js";

export interface PeerOperationConflict {
  readonly candidateIds: readonly string[];
  readonly operationIds: readonly string[];
  readonly reason: "overlapping_structural_edits" | "contradictory_severity" | "contradictory_blocker";
  readonly proposals: readonly IssueOperation[];
}

/** The conflicts that involve at least one of the given candidates. */
export function conflictsInvolving(conflicts: readonly PeerOperationConflict[], candidateIds: readonly string[]): readonly PeerOperationConflict[] {
  const wanted = new Set(candidateIds);
  return conflicts.filter((conflict) => conflict.candidateIds.some((id) => wanted.has(id)));
}

/** A conflict without the bodies of its proposals: which candidates it ties together, and how. */
export function conflictOutline(conflict: PeerOperationConflict): { candidateIds: readonly string[]; operationIds: readonly string[]; reason: PeerOperationConflict["reason"]; proposalTypes: readonly string[] } {
  return { candidateIds: conflict.candidateIds, operationIds: conflict.operationIds, reason: conflict.reason, proposalTypes: conflict.proposals.map(({ type }) => type) };
}

const isConflict = (entry: unknown): entry is PeerOperationConflict => typeof entry === "object" && entry !== null
  && Array.isArray((entry as { candidateIds?: unknown }).candidateIds) && Array.isArray((entry as { proposals?: unknown }).proposals);
const outlined = (entries: unknown): unknown[] | undefined => Array.isArray(entries) && entries.some(isConflict) ? entries.map((entry) => isConflict(entry) ? conflictOutline(entry) : entry) : undefined;

/** A stage input with the unresolved peer operations it carries reduced to their outlines, or undefined when it
 * carries none in full. A verification question carries them at the top, a planner stage in its project context. */
export function withConflictOutlines(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  const direct = outlined(record["unresolvedPeerOperations"]);
  if (direct !== undefined) return { ...record, unresolvedPeerOperations: direct };
  const context = record["projectContext"];
  if (typeof context !== "object" || context === null || Array.isArray(context)) return undefined;
  const nested = outlined((context as Record<string, unknown>)["unresolvedPeerOperations"]);
  return nested === undefined ? undefined : { ...record, projectContext: { ...context, unresolvedPeerOperations: nested } };
}

/** Do not choose a structural claim by reviewer order. Preserve every overlapping
 * proposal for verification/planning and keep the original claims active. */
export function adjudicatePeerOperations(operations: readonly IssueOperation[]): { accepted: readonly IssueOperation[]; conflicts: readonly PeerOperationConflict[] } {
  const conflicts: PeerOperationConflict[] = [];
  const deferred = new Set<string>();
  const structural = operations.filter((operation) => operation.type === "merge" || operation.type === "split");
  const touched = (operation: IssueOperation): readonly string[] => operation.type === "merge" ? operation.sourceCandidateIds : [operation.candidateId];
  const remaining = new Set(structural);
  while (remaining.size > 0) {
    const first = remaining.values().next().value;
    if (first === undefined) break;
    remaining.delete(first);
    const group: IssueOperation[] = [first]; const ids = new Set(touched(first));
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const operation of remaining) if (touched(operation).some((id) => ids.has(id))) {
        remaining.delete(operation); group.push(operation); touched(operation).forEach((id) => ids.add(id)); expanded = true;
      }
    }
    if (group.length > 1) record(group, [...ids], "overlapping_structural_edits");
  }
  for (const type of ["change_severity", "change_blocker"] as const) {
    const groups = new Map<string, IssueOperation[]>();
    for (const operation of operations) if (operation.type === type) groups.set(operation.candidateId, [...(groups.get(operation.candidateId) ?? []), operation]);
    for (const [id, group] of groups) {
      const values = group.map((operation) => operation.type === "change_severity" ? operation.severity : operation.type === "change_blocker" ? operation.blocker : null);
      if (new Set(values).size > 1) record(group, [id], type === "change_severity" ? "contradictory_severity" : "contradictory_blocker");
    }
  }
  return { accepted: operations.filter(({ operationId }) => !deferred.has(operationId)), conflicts: conflicts.sort((a, b) => a.operationIds.join().localeCompare(b.operationIds.join())) };

  function record(proposals: readonly IssueOperation[], candidateIds: readonly string[], reason: PeerOperationConflict["reason"]): void {
    for (const { operationId } of proposals) deferred.add(operationId);
    conflicts.push({ candidateIds: [...candidateIds].sort(), operationIds: proposals.map(({ operationId }) => operationId).sort(), reason, proposals: [...proposals].sort((a, b) => a.operationId.localeCompare(b.operationId)) });
  }
}
