export interface PeerReviewBatch { readonly kind: "review" | "merge_check"; readonly candidateIds: readonly string[] }

/** Partition full reviews, then cover every pair separated by the partition.
 * Pair checks only propose merges, so they cannot duplicate candidate votes. */
export async function peerReviewBatches(candidateIds: readonly string[], fits: (batch: PeerReviewBatch) => Promise<boolean>, maximumCandidates = 20): Promise<readonly PeerReviewBatch[]> {
  if (!Number.isSafeInteger(maximumCandidates) || maximumCandidates < 1) throw new Error("INVALID_PEER_BATCH_LIMIT");
  if (new Set(candidateIds).size !== candidateIds.length) throw new Error("DUPLICATE_PEER_BATCH_CANDIDATE");
  const result: PeerReviewBatch[] = [];
  let current: string[] = [];
  for (const id of candidateIds) {
    const proposed = [...current, id];
    if (proposed.length <= maximumCandidates && await fits({ kind: "review", candidateIds: proposed })) { current = proposed; continue; }
    if (current.length > 0) result.push({ kind: "review", candidateIds: current });
    if (!await fits({ kind: "review", candidateIds: [id] })) throw new Error(`PEER_CANDIDATE_CONTEXT_LIMIT_EXCEEDED:${id}`);
    current = [id];
  }
  if (current.length > 0) result.push({ kind: "review", candidateIds: current });
  const primary = [...result];
  for (let a = 0; a < primary.length; a += 1) {
    for (const right of primary.slice(a + 1)) for (const leftId of primary[a]?.candidateIds ?? []) for (const rightId of right.candidateIds) {
      const batch: PeerReviewBatch = { kind: "merge_check", candidateIds: [leftId, rightId] };
      if (!await fits(batch)) throw new Error(`PEER_PAIR_CONTEXT_LIMIT_EXCEEDED:${leftId}:${rightId}`);
      result.push(batch);
    }
  }
  return result;
}
