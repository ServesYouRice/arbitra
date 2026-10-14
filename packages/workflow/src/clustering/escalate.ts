import { clustersFrom, deterministicClusteringStrategy, mergeParent, parentFrom, SAME_ANSWER_SIGNAL, STRUCTURAL_SIGNAL } from "./deterministic.js";
import type { AmbiguousPair, ClusterOperation, ClusteringMetrics, ClusteringResult, ClusteringStrategy, ClusterRelationship, ValidatedClusterInput } from "./types.js";

export interface SemanticClusteringDecision { readonly relationship: ClusterRelationship; readonly inputTokens: number | null; readonly outputTokens: number | null; readonly cost: number | null }
export interface SemanticClusteringPair { readonly left: ValidatedClusterInput; readonly right: ValidatedClusterInput; readonly signals: readonly string[] }
export interface SemanticClusteringRuntime { readonly capability: "fast" | "balanced"; classify(pair: SemanticClusteringPair): Promise<SemanticClusteringDecision>;
  /** Optional: classifies several pairs in as few calls as the runtime can. Decisions come back in pair order, with the number of calls made. */
  classifyMany?(pairs: readonly SemanticClusteringPair[]): Promise<{ readonly decisions: readonly SemanticClusteringDecision[]; readonly calls: number }> }
/** The most pairs `escalateSharedLines` classifies in all, unless `maximumEscalatedPairs` asks for more. Since the
 * structural rule only proposes (October 14, 2026), every pair of findings citing one line is a proposal: 50 findings
 * on one line made 1,225 classifications, about 370,000 output tokens budgeted at 300 a pair. 300 pairs (90,000) is
 * over seven times the 40 overlapping pairs measured among a P20 pilot run's 53 accepted issues. */
export const MAXIMUM_SHARED_LINE_PAIRS = 300;
/** `escalateSharedLines`: every pair held back from one answer, every pair the structural rule would have joined,
 * and every pair whose findings cite overlapping lines, is classified too, beyond `maximumEscalatedPairs`, up to
 * `maximumSharedLinePairs` (default `MAXIMUM_SHARED_LINE_PAIRS`) in all. */
export interface ClusterOptions { readonly strategy?: ClusteringStrategy; readonly semantic?: SemanticClusteringRuntime; readonly maximumEscalatedPairs?: number; readonly escalateSharedLines?: boolean; readonly maximumSharedLinePairs?: number }

export async function cluster(findings: readonly ValidatedClusterInput[], options: ClusterOptions = {}): Promise<ClusteringResult> {
  const strategy = options.strategy ?? deterministicClusteringStrategy;
  // With shared lines escalated, the structural rule proposes its pairs to the semantic check instead of joining them.
  const base = strategy.cluster(findings, { proposeStructural: options.escalateSharedLines === true && options.semantic !== undefined }); const bound = options.maximumEscalatedPairs ?? 0;
  const ceiling = options.maximumSharedLinePairs ?? MAXIMUM_SHARED_LINE_PAIRS;
  if (!Number.isSafeInteger(bound) || bound < 0 || !Number.isSafeInteger(ceiling) || ceiling < 0) throw new Error("INVALID_CLUSTERING_ESCALATION_LIMIT");
  const leading = base.ambiguousPairs.findIndex(({ signals }) => !signals.includes(SAME_ANSWER_SIGNAL) && !signals.includes(STRUCTURAL_SIGNAL) && !signals.includes("overlapping_lines"));
  // The held pairs come first, then the overlapping ones by score, so a ceiling leaves out the weakest. A pair left
  // out is not merged: its findings reach verification as separate candidates. No stage after verification merges
  // accepted issues by the lines they cite; only a peer review round, where the run has one, may still join them.
  const maximum = options.escalateSharedLines === true ? Math.max(bound, Math.min(ceiling, leading < 0 ? base.ambiguousPairs.length : leading)) : bound;
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
