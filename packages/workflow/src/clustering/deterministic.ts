import { createHash } from "node:crypto";
import type { AmbiguousPair, ClusterOperation, ClusteringStrategy, FindingCluster, StrategyResult, ValidatedClusterInput } from "./types.js";

export const deterministicClusteringStrategy: ClusteringStrategy = Object.freeze({ id: "structural-v3", cluster: deterministicCluster });
/** The signal of a pair held back because both findings came in one answer. */
export const SAME_ANSWER_SIGNAL = "same_answer";

/** A prompt-injection report is about repository text aimed at the auditor, never the defect beside
 * it, so it clusters only with other such reports (observed: the P18 real-model corpus merged it with
 * the auth bypass below the planted comment in 8 of 9 runs). Other categories stay a scored signal:
 * real duplicates are filed under different categories. */
const ISOLATED_CATEGORIES: ReadonlySet<string> = new Set(["PROMPT_INJECTION"]);

/** One auditor lists a defect once in one answer, so two findings of one answer are two defects however close
 * they sit: the structural rule never puts them in one cluster, directly or through a third finding. Such a pair
 * is left for the bounded semantic check, first in line. Structural merges are made strongest first (score, then
 * how much of the cited lines the two share), so of an answer's two findings the closer match joins a third.
 * Observed live (P20 pilot): every structural merge of a one-auditor run (13, 9 and 12 in three runs) joined two
 * findings of one answer; one put a planted high-severity defect under the title of a low-severity finding, the
 * check rejected that title and the defect was lost. On the labelled corpora the rule takes false merges from
 * 11 to 2 (authored) and from 22 to 19 (P06 real models) and loses no true merge. */
export function deterministicCluster(inputs: readonly ValidatedClusterInput[]): StrategyResult {
  const findings = [...inputs].sort((a, b) => a.finding.sourceFindingId.localeCompare(b.finding.sourceFindingId));
  if (findings.some(({ validation }) => validation !== "accepted")) throw new Error("CLUSTERING_REQUIRES_VALIDATED_FINDINGS");
  const ids = findings.map(({ finding }) => finding.sourceFindingId); if (new Set(ids).size !== ids.length) throw new Error("DUPLICATE_CLUSTER_SOURCE_FINDING");
  const parent = new Map(ids.map((id) => [id, id])); const ambiguousPairs: AmbiguousPair[] = []; const operations: ClusterOperation[] = []; let deterministicPairsResolved = 0;
  const answers = new Map(findings.map((input) => [input.finding.sourceFindingId, new Set([answerOf(input)])]));
  const join = (left: string, right: string): void => {
    const merged = new Set([...answers.get(find(parent, left)) ?? [], ...answers.get(find(parent, right)) ?? []]);
    union(parent, left, right); answers.set(find(parent, left), merged);
  };
  const structural: { readonly a: string; readonly b: string; readonly score: number; readonly names: readonly string[]; readonly shared: number }[] = [];
  for (let left = 0; left < findings.length; left += 1) {
    const a = requiredFinding(findings, left);
    for (let right = left + 1; right < findings.length; right += 1) {
      const b = requiredFinding(findings, right);
      if (fingerprint(a) === fingerprint(b)) { join(a.sourceFindingId, b.sourceFindingId); operations.push(Object.freeze({ type: "merge", sourceFindingIds: Object.freeze([a.sourceFindingId, b.sourceFindingId]), reason: "exact" })); deterministicPairsResolved += 1; continue; }
      if (a.category !== b.category && (ISOLATED_CATEGORIES.has(a.category) || ISOLATED_CATEGORIES.has(b.category))) { deterministicPairsResolved += 1; continue; }
      const result = signals(a, b);
      if (result.score >= 5) structural.push({ a: a.sourceFindingId, b: b.sourceFindingId, score: result.score, names: result.names, shared: sharedLines(a, b) });
      else if (result.score <= 1) deterministicPairsResolved += 1;
      else ambiguousPairs.push(Object.freeze({ leftId: a.sourceFindingId, rightId: b.sourceFindingId, signals: Object.freeze(result.names), score: result.score, relationship: null }));
    }
  }
  const held: AmbiguousPair[] = [];
  for (const pair of structural.sort((x, y) => y.score - x.score || y.shared - x.shared || x.a.localeCompare(y.a) || x.b.localeCompare(y.b))) {
    const left = find(parent, pair.a); const right = find(parent, pair.b);
    if (left !== right && [...answers.get(left) ?? []].some((answer) => answers.get(right)?.has(answer) === true)) {
      held.push(Object.freeze({ leftId: pair.a, rightId: pair.b, signals: Object.freeze([...pair.names, SAME_ANSWER_SIGNAL]), score: pair.score, relationship: null }));
      continue;
    }
    join(pair.a, pair.b); operations.push(Object.freeze({ type: "merge", sourceFindingIds: Object.freeze([pair.a, pair.b]), reason: "structural" })); deterministicPairsResolved += 1;
  }
  // After the held pairs, the pairs that cite overlapping lines come first: of the ambiguous pairs, those are the
  // likely duplicates (design audit: duplicates are keyed by location and defect). Observed live (P20 pilot): with
  // the first 20 pairs checked in id order, 40 pairs of one run's 53 accepted issues overlapped.
  const ranked = [...ambiguousPairs].sort((x, y) => Number(y.signals.includes("overlapping_lines")) - Number(x.signals.includes("overlapping_lines")) || y.score - x.score || x.leftId.localeCompare(y.leftId) || x.rightId.localeCompare(y.rightId));
  return Object.freeze({ findings: Object.freeze(findings), clusters: clustersFrom(parent), ambiguousPairs: Object.freeze([...held, ...ranked]), operations: Object.freeze(operations), deterministicPairsResolved });
}

/** The answer a finding came in: its id without the last part (auditor and scope in a model audit, auditor and
 * rule in a scripted one), or the auditor when the id has one part. */
function answerOf(input: ValidatedClusterInput): string {
  const id = input.finding.sourceFindingId; const cut = id.lastIndexOf("/");
  return cut < 0 ? input.auditorId : id.slice(0, cut);
}

/** The largest share of their cited lines two findings have in common in one file: 1 when the ranges are equal. */
function sharedLines(a: ValidatedClusterInput["finding"], b: ValidatedClusterInput["finding"]): number {
  let best = 0;
  for (const x of a.locations) for (const y of b.locations) {
    if (x.path !== y.path) continue;
    const common = Math.min(x.endLine, y.endLine) - Math.max(x.startLine, y.startLine) + 1;
    if (common > 0) best = Math.max(best, common / (Math.max(x.endLine, y.endLine) - Math.min(x.startLine, y.startLine) + 1));
  }
  return best;
}

export function clustersFrom(parent: Map<string, string>): readonly FindingCluster[] {
  const groups = new Map<string, string[]>(); for (const id of [...parent.keys()].sort()) { const root = find(parent, id); const values = groups.get(root) ?? []; values.push(id); groups.set(root, values); }
  return Object.freeze([...groups.values()].map((sourceFindingIds) => Object.freeze({ clusterId: clusterId(sourceFindingIds), sourceFindingIds: Object.freeze(sourceFindingIds) })).sort((a, b) => a.clusterId.localeCompare(b.clusterId)));
}
export function mergeParent(parent: Map<string, string>, left: string, right: string): void { union(parent, left, right); }
export function parentFrom(clusters: readonly FindingCluster[]): Map<string, string> {
  const parent = new Map<string, string>();
  for (const cluster of clusters) {
    const firstId = cluster.sourceFindingIds[0];
    if (firstId === undefined) throw new Error("EMPTY_FINDING_CLUSTER");
    for (const id of cluster.sourceFindingIds) {
      parent.set(id, id);
      if (id !== firstId) union(parent, firstId, id);
    }
  }
  return parent;
}

function requiredFinding(findings: readonly ValidatedClusterInput[], index: number): ValidatedClusterInput["finding"] {
  const input = findings[index];
  if (input === undefined) throw new RangeError(`Missing clustering input at index ${index}`);
  return input.finding;
}

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
