/** A pair check may carry one record as consecutive exact segments of its canonical
 * JSON when two complete records cannot share a context. The other record stays whole. */
export interface PeerReviewSegment { readonly candidateId: string; readonly index: number; readonly count: number }
export interface PeerReviewBatch { readonly kind: "review" | "merge_check"; readonly candidateIds: readonly string[]; readonly segment?: PeerReviewSegment;
  /** Present on a packed pair check: the cross-batch candidate pairs it covers. */
  readonly pairs?: readonly (readonly [string, string])[] }

export const MAXIMUM_PAIR_SEGMENTS = 16;

/** Exact, complete segmentation: concatenating every segment restores `text`. */
export function segmentText(text: string, segment: Pick<PeerReviewSegment, "index" | "count">): string {
  if (!Number.isSafeInteger(segment.count) || segment.count < 1 || !Number.isSafeInteger(segment.index) || segment.index < 0 || segment.index >= segment.count) throw new Error("INVALID_PAIR_SEGMENT");
  const size = Math.ceil(text.length / segment.count);
  return text.slice(segment.index * size, (segment.index + 1) * size);
}

/** Partition full reviews, then cover every pair separated by the partition.
 * Pair checks only propose merges, so they cannot duplicate candidate votes. Pairs are packed
 * into as few calls as fit, as the critic packs its own. Observed live (P20 pilot): one pair per
 * call asked one reviewer for 1,140 calls of about 59,000 tokens over 68 candidates in two batches. */
export async function peerReviewBatches(candidateIds: readonly string[], fits: (batch: PeerReviewBatch) => Promise<boolean>, maximumCandidates = 20, maximumPackedCandidates = maximumCandidates, admits?: (batch: PeerReviewBatch) => Promise<boolean>): Promise<readonly PeerReviewBatch[]> {
  const primary = await reviewPartition(candidateIds, (ids) => fits({ kind: "review", candidateIds: ids }), maximumCandidates, admits === undefined ? undefined : (ids) => admits({ kind: "review", candidateIds: ids }));
  const result: PeerReviewBatch[] = primary.map((ids): PeerReviewBatch => ({ kind: "review", candidateIds: ids }));
  const rank = new Map(candidateIds.map((id, position) => [id, position]));
  const key = (left: string, right: string) => JSON.stringify([left, right]);
  const pending = new Map<string, readonly [string, string]>();
  for (let a = 0; a < primary.length; a += 1) for (const right of primary.slice(a + 1)) for (const leftId of primary[a] ?? []) for (const rightId of right) pending.set(key(leftId, rightId), [leftId, rightId]);
  const covered = (members: ReadonlySet<string>) => [...pending.values()].filter(([left, right]) => members.has(left) && members.has(right));
  // A check of one pair keeps its earlier shape, so its durable identity is unchanged.
  const packed = (members: ReadonlySet<string>): PeerReviewBatch => {
    const pairs = covered(members); const [only] = pairs;
    return pairs.length === 1 && only !== undefined ? { kind: "merge_check", candidateIds: only } : { kind: "merge_check", candidateIds: [...members].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0)), pairs };
  };
  while (pending.size > 0) {
    const [first] = pending.values(); if (first === undefined) break;
    const [leftId, rightId] = first;
    if (!await fits({ kind: "merge_check", candidateIds: [leftId, rightId] })) {
      const segmented = await segmentedPair(leftId, rightId, fits);
      if (segmented === null) throw new Error(`PEER_PAIR_CONTEXT_LIMIT_EXCEEDED:${leftId}:${rightId}`);
      result.push(...segmented);
      pending.delete(key(leftId, rightId)); continue;
    }
    // Grow the call by the candidate that adds the most uncovered pairs, while the call still fits.
    const members = new Set([leftId, rightId]); const tried = new Set<string>();
    while (members.size < Math.max(2, maximumPackedCandidates)) {
      let best: string | undefined; let bestGain = 0;
      for (const id of candidateIds) {
        if (members.has(id) || tried.has(id)) continue;
        const gain = [...members].filter((member) => pending.has(key(id, member)) || pending.has(key(member, id))).length;
        if (gain > bestGain) { best = id; bestGain = gain; }
      }
      if (best === undefined) break;
      tried.add(best);
      if (await fits(packed(new Set([...members, best])))) members.add(best);
    }
    result.push(packed(members));
    for (const [left, right] of covered(members)) pending.delete(key(left, right));
  }
  return result;
}

/**
 * A pair check proposes merges and nothing else: at most one for a single pair. A packed check
 * may propose several, none sharing a candidate, so it cannot contradict itself. It may merge any
 * candidates it presents, not only a listed pair: the model has both candidates whole in front of
 * it, and a merge that overlaps another reviewer's is settled as a conflict like any other.
 * Observed live (P20 pilot): four packed checks were refused for merging two candidates of one
 * review batch, and each refusal cost a repair call.
 */
export function assertMergeCheckOperations(operations: readonly { readonly type: string; readonly sourceCandidateIds?: readonly string[] }[], part: PeerReviewBatch): void {
  if (operations.some(({ type }) => type !== "merge") || part.pairs === undefined && operations.length > 1) throw new Error("INVALID_PEER_PAIR_OPERATIONS");
  if (part.pairs === undefined) return;
  const merged = new Set<string>();
  for (const { sourceCandidateIds = [] } of operations) {
    if (sourceCandidateIds.some((id) => merged.has(id))) throw new Error("INVALID_PEER_PAIR_OPERATIONS: a candidate may appear in one merge only; put every candidate that shares one root cause in a single merge");
    for (const id of sourceCandidateIds) merged.add(id);
  }
}

/** Greedy in-order partition into review batches of complete records that fit. A record that fits no batch even
 * alone is still reviewed alone when `admits` takes it as required input. */
export async function reviewPartition(candidateIds: readonly string[], fits: (candidateIds: readonly string[]) => Promise<boolean>, maximumCandidates = 20, admits?: (candidateIds: readonly string[]) => Promise<boolean>): Promise<readonly (readonly string[])[]> {
  if (!Number.isSafeInteger(maximumCandidates) || maximumCandidates < 1) throw new Error("INVALID_PEER_BATCH_LIMIT");
  if (new Set(candidateIds).size !== candidateIds.length) throw new Error("DUPLICATE_PEER_BATCH_CANDIDATE");
  const result: string[][] = [];
  let current: string[] = [];
  for (const id of candidateIds) {
    const proposed = [...current, id];
    if (proposed.length <= maximumCandidates && await fits(proposed)) { current = proposed; continue; }
    if (current.length > 0) result.push(current);
    if (!await fits([id])) {
      if (await admits?.([id]) !== true) throw new Error(`PEER_CANDIDATE_CONTEXT_LIMIT_EXCEEDED:${id}`);
      // Admitted only as required input: nothing else shares its batch.
      result.push([id]); current = [];
      continue;
    }
    current = [id];
  }
  if (current.length > 0) result.push(current);
  return result;
}

/** Keep one record complete and read the other in the fewest exact segments that fit. */
export async function segmentedPair(leftId: string, rightId: string, fits: (batch: PeerReviewBatch) => Promise<boolean>): Promise<readonly PeerReviewBatch[] | null> {
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
