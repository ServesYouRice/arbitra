import { clustersFrom, deterministicClusteringStrategy, mergeParent, parentFrom, SAME_ANSWER_SIGNAL } from "./deterministic.js";
import type { AmbiguousPair, ClusterOperation, ClusteringMetrics, ClusteringResult, ClusteringStrategy, ClusterRelationship, ValidatedClusterInput } from "./types.js";

export interface SemanticClusteringDecision { readonly relationship: ClusterRelationship; readonly inputTokens: number | null; readonly outputTokens: number | null; readonly cost: number | null }
export interface SemanticClusteringPair { readonly left: ValidatedClusterInput; readonly right: ValidatedClusterInput; readonly signals: readonly string[] }
export interface SemanticClusteringRuntime { readonly capability: "fast" | "balanced"; classify(pair: SemanticClusteringPair): Promise<SemanticClusteringDecision>;
  /** Optional: classifies several pairs in as few calls as the runtime can. Decisions come back in pair order, with the number of calls made. */
  classifyMany?(pairs: readonly SemanticClusteringPair[]): Promise<{ readonly decisions: readonly SemanticClusteringDecision[]; readonly calls: number }> }
/** `escalateSharedLines`: every pair held back from one answer, and every pair whose findings cite overlapping
 * lines, is classified too, beyond `maximumEscalatedPairs`. */
export interface ClusterOptions { readonly strategy?: ClusteringStrategy; readonly semantic?: SemanticClusteringRuntime; readonly maximumEscalatedPairs?: number; readonly escalateSharedLines?: boolean }

export async function cluster(findings: readonly ValidatedClusterInput[], options: ClusterOptions = {}): Promise<ClusteringResult> {
  const strategy = options.strategy ?? deterministicClusteringStrategy;
  const base = strategy.cluster(findings); const bound = options.maximumEscalatedPairs ?? 0;
  if (!Number.isSafeInteger(bound) || bound < 0) throw new Error("INVALID_CLUSTERING_ESCALATION_LIMIT");
  const leading = base.ambiguousPairs.findIndex(({ signals }) => !signals.includes(SAME_ANSWER_SIGNAL) && !signals.includes("overlapping_lines"));
  const maximum = options.escalateSharedLines === true ? Math.max(bound, leading < 0 ? base.ambiguousPairs.length : leading) : bound;
  const byId = new Map(base.findings.map((finding) => [finding.finding.sourceFindingId, finding])); const parent = parentFrom(base.clusters); const operations: ClusterOperation[] = [...base.operations]; const pairs: AmbiguousPair[] = [];
  // The escalated pairs are the first `maximum` ambiguous pairs. Their decisions do not depend on one another,
  // so a runtime may take them together.
  const escalated: SemanticClusteringPair[] = [];
  for (const [index, pair] of base.ambiguousPairs.entries()) {
    if (index >= maximum || options.semantic === undefined) break;
    const left = byId.get(pair.leftId);
    const right = byId.get(pair.rightId);
    if (left === undefined || right === undefined) throw new Error(`AMBIGUOUS_PAIR_FINDING_MISSING:${pair.leftId}:${pair.rightId}`);
    escalated.push({ left, right, signals: pair.signals });
  }
  let decisions: readonly SemanticClusteringDecision[] = []; let calls = 0;
  if (options.semantic?.classifyMany !== undefined && escalated.length > 1) {
    const many = await options.semantic.classifyMany(escalated);
    if (many.decisions.length !== escalated.length) throw new Error("SEMANTIC_CLUSTERING_DECISION_COUNT_MISMATCH");
    decisions = many.decisions; calls = many.calls;
  } else if (options.semantic !== undefined) {
    const single: SemanticClusteringDecision[] = [];
    for (const pair of escalated) { single.push(await options.semantic.classify(pair)); calls += 1; }
    decisions = single;
  }
  let tokens: number | null = 0; let cost: number | null = 0;
  for (const [index, pair] of base.ambiguousPairs.entries()) {
    const decision = decisions[index];
    if (decision === undefined) { pairs.push(pair); continue; }
    tokens = tokens === null || decision.inputTokens === null || decision.outputTokens === null ? null : tokens + decision.inputTokens + decision.outputTokens; cost = cost === null || decision.cost === null ? null : cost + decision.cost;
    pairs.push(Object.freeze({ ...pair, relationship: decision.relationship }));
    if (decision.relationship === "same_root_cause") { mergeParent(parent, pair.leftId, pair.rightId); operations.push(Object.freeze({ type: "merge", sourceFindingIds: Object.freeze([pair.leftId, pair.rightId]), reason: "semantic" })); }
  }
  const metrics: ClusteringMetrics = Object.freeze({ deterministicPairsResolved: base.deterministicPairsResolved, escalatedPairs: decisions.length, semanticClusteringCalls: calls, semanticClusteringTokens: tokens, semanticClusteringCost: cost === null ? null : Math.round(cost * 1_000_000) / 1_000_000 });
  return Object.freeze({ clusters: clustersFrom(parent), ambiguousPairs: Object.freeze(pairs), operations: Object.freeze(operations), metrics });
}

export function recordSplit(result: ClusteringResult, sourceFindingId: string, candidateIds: readonly string[], reason: string): ClusteringResult {
  if (candidateIds.length < 2 || new Set(candidateIds).size !== candidateIds.length) throw new Error("INVALID_CLUSTER_SPLIT");
  const containing = result.clusters.find(({ sourceFindingIds }) => sourceFindingIds.includes(sourceFindingId)); if (containing === undefined) throw new Error(`UNKNOWN_CLUSTER_FINDING:${sourceFindingId}`);
  const remaining = containing.sourceFindingIds.filter((id) => id !== sourceFindingId); const replacements = candidateIds.map((candidateId) => Object.freeze({ clusterId: candidateId, sourceFindingIds: Object.freeze([sourceFindingId]) }));
  const clusters = [...result.clusters.filter((cluster) => cluster !== containing), ...(remaining.length === 0 ? [] : [Object.freeze({ ...containing, sourceFindingIds: Object.freeze(remaining) })]), ...replacements];
  return Object.freeze({ ...result, clusters: Object.freeze(clusters), operations: Object.freeze([...result.operations, Object.freeze({ type: "split" as const, sourceFindingId, candidateIds: Object.freeze([...candidateIds]), reason })]) });
}
