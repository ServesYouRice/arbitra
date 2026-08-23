import { createHash } from "node:crypto";
import type { AmbiguousPair, ClusterOperation, ClusteringStrategy, FindingCluster, StrategyResult, ValidatedClusterInput } from "./types.js";

export const deterministicClusteringStrategy: ClusteringStrategy = Object.freeze({ id: "structural-v1", cluster: deterministicCluster });

export function deterministicCluster(inputs: readonly ValidatedClusterInput[]): StrategyResult {
  const findings = [...inputs].sort((a, b) => a.finding.sourceFindingId.localeCompare(b.finding.sourceFindingId));
  if (findings.some(({ validation }) => validation !== "accepted")) throw new Error("CLUSTERING_REQUIRES_VALIDATED_FINDINGS");
  const ids = findings.map(({ finding }) => finding.sourceFindingId); if (new Set(ids).size !== ids.length) throw new Error("DUPLICATE_CLUSTER_SOURCE_FINDING");
  const parent = new Map(ids.map((id) => [id, id])); const ambiguousPairs: AmbiguousPair[] = []; const operations: ClusterOperation[] = []; let deterministicPairsResolved = 0;
  for (let left = 0; left < findings.length; left += 1) for (let right = left + 1; right < findings.length; right += 1) {
    const a = findings[left]!.finding; const b = findings[right]!.finding;
    if (fingerprint(a) === fingerprint(b)) { union(parent, a.sourceFindingId, b.sourceFindingId); operations.push(Object.freeze({ type: "merge", sourceFindingIds: Object.freeze([a.sourceFindingId, b.sourceFindingId]), reason: "exact" })); deterministicPairsResolved += 1; continue; }
    const result = signals(a, b);
    if (result.score >= 5) { union(parent, a.sourceFindingId, b.sourceFindingId); operations.push(Object.freeze({ type: "merge", sourceFindingIds: Object.freeze([a.sourceFindingId, b.sourceFindingId]), reason: "structural" })); deterministicPairsResolved += 1; }
    else if (result.score <= 1) deterministicPairsResolved += 1;
    else ambiguousPairs.push(Object.freeze({ leftId: a.sourceFindingId, rightId: b.sourceFindingId, signals: Object.freeze(result.names), score: result.score, relationship: null }));
  }
  return Object.freeze({ findings: Object.freeze(findings), clusters: clustersFrom(parent), ambiguousPairs: Object.freeze(ambiguousPairs), operations: Object.freeze(operations), deterministicPairsResolved });
}

export function clustersFrom(parent: Map<string, string>): readonly FindingCluster[] {
  const groups = new Map<string, string[]>(); for (const id of [...parent.keys()].sort()) { const root = find(parent, id); const values = groups.get(root) ?? []; values.push(id); groups.set(root, values); }
  return Object.freeze([...groups.values()].map((sourceFindingIds) => Object.freeze({ clusterId: clusterId(sourceFindingIds), sourceFindingIds: Object.freeze(sourceFindingIds) })).sort((a, b) => a.clusterId.localeCompare(b.clusterId)));
}
export function mergeParent(parent: Map<string, string>, left: string, right: string): void { union(parent, left, right); }
export function parentFrom(clusters: readonly FindingCluster[]): Map<string, string> { const parent = new Map<string, string>(); for (const cluster of clusters) for (const id of cluster.sourceFindingIds) { parent.set(id, id); if (id !== cluster.sourceFindingIds[0]) union(parent, cluster.sourceFindingIds[0]!, id); } return parent; }

function signals(a: ValidatedClusterInput["finding"], b: ValidatedClusterInput["finding"]): { score: number; names: string[] } {
  let score = 0; const names: string[] = []; const add = (name: string, value: number) => { names.push(name); score += value; };
  const samePaths = a.locations.some((x) => b.locations.some((y) => x.path === y.path)); if (samePaths) add("same_path", 1);
  if (a.locations.some((x) => b.locations.some((y) => x.path === y.path && x.startLine <= y.endLine && y.startLine <= x.endLine))) add("overlapping_lines", 3);
  if (a.locations.some((x) => x.symbol !== undefined && b.locations.some((y) => y.symbol === x.symbol))) add("same_symbol", 2);
  for (const field of ["route", "endpoint", "component"] as const) if (a[field] !== undefined && a[field] === b[field]) add(`same_${field}`, 2);
  if (a.category === b.category) add("same_category", 1);
  const mechanismsA = new Set([...(a.failureMechanisms ?? []), ...keywords(`${a.title} ${a.problem}`)]); const mechanismsB = new Set([...(b.failureMechanisms ?? []), ...keywords(`${b.title} ${b.problem}`)]);
  if ([...mechanismsA].some((item) => mechanismsB.has(item))) add("same_failure_mechanism", 2);
  if (normalize(a.recommendedFix) !== "" && normalize(a.recommendedFix) === normalize(b.recommendedFix)) add("same_remediation", 1);
  return { score, names };
}
function keywords(text: string): string[] { return ["race", "authorization", "authentication", "injection", "overflow", "timeout", "deadlock", "leak", "traversal", "validation"].filter((word) => text.toLocaleLowerCase("en-US").includes(word)); }
function normalize(value: string): string { return value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/gu, " ").trim(); }
function fingerprint(finding: ValidatedClusterInput["finding"]): string { return JSON.stringify({ category: finding.category, title: normalize(finding.title), problem: normalize(finding.problem), locations: [...finding.locations].map(({ path, startLine, endLine, symbol }) => ({ path, startLine, endLine, symbol: symbol ?? null })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), recommendedFix: normalize(finding.recommendedFix) }); }
function find(parent: Map<string, string>, id: string): string { const value = parent.get(id); if (value === undefined) throw new Error(`UNKNOWN_CLUSTER_FINDING:${id}`); if (value === id) return id; const root = find(parent, value); parent.set(id, root); return root; }
function union(parent: Map<string, string>, left: string, right: string): void { const a = find(parent, left); const b = find(parent, right); if (a !== b) parent.set(a < b ? b : a, a < b ? a : b); }
function clusterId(ids: readonly string[]): string { return `C-${createHash("sha256").update(JSON.stringify([...ids].sort())).digest("hex").slice(0, 12)}`; }
