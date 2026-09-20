import { clustersFrom, deterministicClusteringStrategy, mergeParent, parentFrom } from "./deterministic.js";
import type { AmbiguousPair, ClusterOperation, ClusteringMetrics, ClusteringResult, ClusteringStrategy, ClusterRelationship, ValidatedClusterInput } from "./types.js";

export interface SemanticClusteringDecision { readonly relationship: ClusterRelationship; readonly inputTokens: number | null; readonly outputTokens: number | null; readonly cost: number | null }
export interface SemanticClusteringRuntime { readonly capability: "fast" | "balanced"; classify(pair: { readonly left: ValidatedClusterInput; readonly right: ValidatedClusterInput; readonly signals: readonly string[] }): Promise<SemanticClusteringDecision> }
export interface ClusterOptions { readonly strategy?: ClusteringStrategy; readonly semantic?: SemanticClusteringRuntime; readonly maximumEscalatedPairs?: number }

export async function cluster(findings: readonly ValidatedClusterInput[], options: ClusterOptions = {}): Promise<ClusteringResult> {
  const strategy = options.strategy ?? deterministicClusteringStrategy;
  const base = strategy.cluster(findings); const maximum = options.maximumEscalatedPairs ?? 0;
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error("INVALID_CLUSTERING_ESCALATION_LIMIT");
  const byId = new Map(base.findings.map((finding) => [finding.finding.sourceFindingId, finding])); const parent = parentFrom(base.clusters); const operations: ClusterOperation[] = [...base.operations]; const pairs: AmbiguousPair[] = [];
  let calls = 0; let tokens: number | null = 0; let cost: number | null = 0;
  for (const [index, pair] of base.ambiguousPairs.entries()) {
    if (index >= maximum || options.semantic === undefined) { pairs.push(pair); continue; }
    const left = byId.get(pair.leftId);
    const right = byId.get(pair.rightId);
    if (left === undefined || right === undefined) throw new Error(`AMBIGUOUS_PAIR_FINDING_MISSING:${pair.leftId}:${pair.rightId}`);
    const decision = await options.semantic.classify({ left, right, signals: pair.signals }); calls += 1; tokens = tokens === null || decision.inputTokens === null || decision.outputTokens === null ? null : tokens + decision.inputTokens + decision.outputTokens; cost = cost === null || decision.cost === null ? null : cost + decision.cost;
    pairs.push(Object.freeze({ ...pair, relationship: decision.relationship }));
    if (decision.relationship === "same_root_cause") { mergeParent(parent, pair.leftId, pair.rightId); operations.push(Object.freeze({ type: "merge", sourceFindingIds: Object.freeze([pair.leftId, pair.rightId]), reason: "semantic" })); }
  }
  const metrics: ClusteringMetrics = Object.freeze({ deterministicPairsResolved: base.deterministicPairsResolved, escalatedPairs: calls, semanticClusteringCalls: calls, semanticClusteringTokens: tokens, semanticClusteringCost: cost === null ? null : Math.round(cost * 1_000_000) / 1_000_000 });
  return Object.freeze({ clusters: clustersFrom(parent), ambiguousPairs: Object.freeze(pairs), operations: Object.freeze(operations), metrics });
}

export function recordSplit(result: ClusteringResult, sourceFindingId: string, candidateIds: readonly string[], reason: string): ClusteringResult {
  if (candidateIds.length < 2 || new Set(candidateIds).size !== candidateIds.length) throw new Error("INVALID_CLUSTER_SPLIT");
  const containing = result.clusters.find(({ sourceFindingIds }) => sourceFindingIds.includes(sourceFindingId)); if (containing === undefined) throw new Error(`UNKNOWN_CLUSTER_FINDING:${sourceFindingId}`);
  const remaining = containing.sourceFindingIds.filter((id) => id !== sourceFindingId); const replacements = candidateIds.map((candidateId) => Object.freeze({ clusterId: candidateId, sourceFindingIds: Object.freeze([sourceFindingId]) }));
  const clusters = [...result.clusters.filter((cluster) => cluster !== containing), ...(remaining.length === 0 ? [] : [Object.freeze({ ...containing, sourceFindingIds: Object.freeze(remaining) })]), ...replacements];
  return Object.freeze({ ...result, clusters: Object.freeze(clusters), operations: Object.freeze([...result.operations, Object.freeze({ type: "split" as const, sourceFindingId, candidateIds: Object.freeze([...candidateIds]), reason })]) });
}
