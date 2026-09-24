/** A pair check may carry one record as consecutive exact segments of its canonical
 * JSON when two complete records cannot share a context. The other record stays whole. */
export interface PeerReviewSegment { readonly candidateId: string; readonly index: number; readonly count: number }
export interface PeerReviewBatch { readonly kind: "review" | "merge_check"; readonly candidateIds: readonly string[]; readonly segment?: PeerReviewSegment }

export const MAXIMUM_PAIR_SEGMENTS = 16;

/** Exact, complete segmentation: concatenating every segment restores `text`. */
export function segmentText(text: string, segment: Pick<PeerReviewSegment, "index" | "count">): string {
  if (!Number.isSafeInteger(segment.count) || segment.count < 1 || !Number.isSafeInteger(segment.index) || segment.index < 0 || segment.index >= segment.count) throw new Error("INVALID_PAIR_SEGMENT");
  const size = Math.ceil(text.length / segment.count);
  return text.slice(segment.index * size, (segment.index + 1) * size);
}

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
      if (await fits(batch)) { result.push(batch); continue; }
      const segmented = await segmentedPair(leftId, rightId, fits);
      if (segmented === null) throw new Error(`PEER_PAIR_CONTEXT_LIMIT_EXCEEDED:${leftId}:${rightId}`);
      result.push(...segmented);
    }
  }
  return result;
}

/** Keep one record complete and read the other in the fewest exact segments that fit. */
async function segmentedPair(leftId: string, rightId: string, fits: (batch: PeerReviewBatch) => Promise<boolean>): Promise<readonly PeerReviewBatch[] | null> {
  for (let count = 2; count <= MAXIMUM_PAIR_SEGMENTS; count += 1) {
    for (const split of [rightId, leftId]) {
      const batches = Array.from({ length: count }, (_, index): PeerReviewBatch => ({ kind: "merge_check", candidateIds: [leftId, rightId], segment: { candidateId: split, index, count } }));
      let admitted = true;
      for (const batch of batches) if (!await fits(batch)) { admitted = false; break; }
      if (admitted) return batches;
    }
  }
  return null;
}
