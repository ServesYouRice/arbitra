import { createHash } from "node:crypto";
import { approximateModules } from "@arbitra/core/preflight/modules.js";
import type { SourceFinding } from "@arbitra/schemas/finding.js";
import type { CanonicalIssue, CanonicalIssueSet } from "@arbitra/workflow/nodes/canonical-issues.js";
import type { AuditFinding } from "./auditors.js";
import { DISCOVERY_READ_BEYOND_UNIT_BYTES } from "./model-discovery.js";
import type { RepositorySnapshot } from "./repository.js";

/**
 * The optional variant search (`workflow.variantSearch`), between verification and planning: for each confirmed issue
 * at or above the plan's minimum severity, one model proposes the other places in the repository with the same defect.
 * It only proposes. What it proposes is validated against the snapshot as discovery's findings are, dropped when it
 * repeats a place already reported, and put to the checkers like any candidate; the variants they confirm join the
 * issue set with the issue they repeat as `variantOf`. This file holds the parts that need no model.
 */

/** The actor the variant search's findings are namespaced under, beside the auditors. */
export const VARIANT_SEARCH_ACTOR = "variant-search";
/** Confirmed issues one search call takes at most. Not measured yet: the replay on the finished runs sets it. */
export const VARIANT_SEARCH_SEEDS_PER_BATCH = 6;
/** The most characters of cited source one batch reads by itself, as a group of verification questions does. */
export const VARIANT_SEARCH_BATCH_SOURCE_CHARACTERS = 60_000;
/** Bytes of files the issues do not cite that one search call may read through the tools: as much as a discovery unit
 * may read beyond itself, so its findings are grounded the same way. Searches deliver paths and lines within the call's
 * own byte budget. */
export const VARIANT_SEARCH_READ_BYTES = DISCOVERY_READ_BEYOND_UNIT_BYTES;

export type VariantFinding = SourceFinding & { readonly variantOf: string };

/** What a search call is asked; the call adds its namespace, its issues and its read budget. */
export const VARIANT_SEARCH_INSTRUCTION = "Search this repository for variants of each supplied issue: other places with the same defect, such as a sibling handler of the same family, another call to the same callee used the same wrong way, the same flag or configuration value read the same wrong way, or code copied from the defective place. Each issue was confirmed against the source; its findings say where it is, what triggers it and what goes wrong. Search for the callee, flag, key or distinctive text first, then read the places the search finds. Report a place only when the source you read there shows the same defect, and only as a variant of the issue it repeats: never a place listed in alreadyReported, the issue's own places again, or a different defect. Return at most 40 findings, and an empty findings array when the source shows none. Each finding cites at least one location and one evidence item linked to a cited location; evidence text is an exact nonempty excerpt of its cited lines, quoted as read, at their original line numbers, and may be lines you read in another file. Matching text establishes a citation, not that the defect is confirmed: express uncertainty in status and confidence.";

const SEVERITY_ORDER: Readonly<Record<string, number>> = Object.freeze({ critical: 0, high: 1, medium: 2, low: 3, informational: 4 });

/** A confirmed issue whose variants are looked for, and the findings it stands for. */
export interface VariantSeed { readonly issue: CanonicalIssue; readonly findings: readonly AuditFinding[] }

/** The issues whose variants are looked for: those verification confirmed, at or above the plan's minimum severity. */
export function variantSeeds(issues: CanonicalIssueSet, findings: ReadonlyMap<string, AuditFinding>, minimumSeverity: string | undefined): readonly VariantSeed[] {
  const bar = SEVERITY_ORDER[minimumSeverity ?? "informational"] ?? 4;
  return issues.issues.filter((issue) => issue.verificationOutcome === "CONFIRMED" && (SEVERITY_ORDER[issue.severity] ?? 5) <= bar).flatMap((issue) => {
    const own = issue.sourceFindingIds.flatMap((id) => { const finding = findings.get(id); return finding === undefined ? [] : [finding]; });
    return own.length === 0 ? [] : [{ issue, findings: own }];
  });
}

export const pathsOfSeeds = (seeds: readonly VariantSeed[]): readonly string[] => [...new Set(seeds.flatMap(({ findings }) => findings.flatMap(({ locations }) => locations.map(({ path }) => path))))].sort();

/**
 * The seeds in batches, so the search makes few calls: a batch starts with the first seed not yet batched and takes later
 * seeds of the same module (the same file, for a file in none) while it holds at most `VARIANT_SEARCH_SEEDS_PER_BATCH`,
 * the files its seeds cite stay within `VARIANT_SEARCH_BATCH_SOURCE_CHARACTERS` and the call `fits`. Seeds stay in the
 * issue set's order, most severe first.
 */
export async function variantBatches(seeds: readonly VariantSeed[], snapshot: RepositorySnapshot, fits: (batch: readonly VariantSeed[]) => Promise<boolean>): Promise<readonly (readonly VariantSeed[])[]> {
  const moduleOf = new Map<string, string>();
  for (const { id, files } of approximateModules(snapshot.files.map(({ path, lines }) => ({ path, content: lines.join("\n") })))) for (const path of files) moduleOf.set(path, id);
  const keyOf = ({ findings }: VariantSeed) => { const path = findings[0]?.locations[0]?.path ?? ""; return moduleOf.get(path) ?? `file:${path}`; };
  const characters = new Map(snapshot.files.map(({ path, lines }) => [path, lines.reduce((sum, line) => sum + line.length + 1, 0)]));
  const size = (batch: readonly VariantSeed[]) => pathsOfSeeds(batch).reduce((sum, path) => sum + (characters.get(path) ?? 0), 0);
  const batches: VariantSeed[][] = []; const taken = new Set<string>();
  for (const [index, first] of seeds.entries()) {
    if (taken.has(first.issue.candidateId)) continue;
    const batch = [first]; taken.add(first.issue.candidateId);
    for (const next of seeds.slice(index + 1)) {
      if (batch.length >= VARIANT_SEARCH_SEEDS_PER_BATCH) break;
      if (taken.has(next.issue.candidateId) || keyOf(next) !== keyOf(first) || size([...batch, next]) > VARIANT_SEARCH_BATCH_SOURCE_CHARACTERS || !await fits([...batch, next])) continue;
      batch.push(next); taken.add(next.issue.candidateId);
    }
    batches.push(batch);
  }
  return batches;
}

/** A batch's identity, from the issues it searches: its activity, its record and the namespace of what it proposes. */
export function variantBatchId(batch: readonly VariantSeed[]): string {
  return `batch-${createHash("sha256").update(JSON.stringify(batch.map(({ issue }) => issue.candidateId))).digest("hex").slice(0, 16)}`;
}

/** The candidate a proposed variant becomes, named as clustering names a candidate of that one finding: the verifier
 * reads candidate IDs, and nothing in the question says a candidate is a variant. */
export function variantCandidateId(sourceFindingId: string): string {
  return `C-${createHash("sha256").update(JSON.stringify([sourceFindingId])).digest("hex").slice(0, 12)}`;
}

/** Every place the issue set already reports, as line ranges by file ("12-30"), overlapping ranges merged. */
export function reportedPlaces(findings: readonly AuditFinding[]): Readonly<Record<string, readonly string[]>> {
  const byPath = new Map<string, [number, number][]>();
  for (const { locations } of findings) for (const { path, startLine, endLine } of locations) byPath.set(path, [...byPath.get(path) ?? [], [startLine, endLine]]);
  return Object.fromEntries([...byPath].sort(([a], [b]) => a.localeCompare(b)).map(([path, ranges]) => [path, ranges.sort((a, b) => a[0] - b[0]).reduce<[number, number][]>((all, [start, end]) => {
    const last = all.at(-1);
    if (last !== undefined && start <= last[1] + 1) last[1] = Math.max(last[1], end); else all.push([start, end]);
    return all;
  }, []).map(([start, end]) => start === end ? `${start}` : `${start}-${end}`)]));
}

/** Why a proposed variant was dropped before verification, and what it repeats. */
export interface VariantDuplicate {
  readonly sourceFindingId: string;
  readonly variantOf: string;
  /** `restates_its_issue`: it cites no place its issue does not. `repeats_an_issue`: every place it adds is already a place of
   * one issue (its disposition is recorded: a variant of a rejected issue does not bring it back). `repeats_a_variant`:
   * every place it adds is a place an earlier variant adds. */
  readonly reason: "restates_its_issue" | "repeats_an_issue" | "repeats_a_variant";
  readonly duplicateOf: string;
  readonly disposition?: string;
}

type Place = { readonly path: string; readonly startLine: number; readonly endLine: number };
const overlaps = (a: Place, b: Place) => a.path === b.path && a.startLine <= b.endLine && b.startLine <= a.endLine;

/**
 * The proposed variants without those that repeat a place already reported. A variant's own places are those its issue
 * does not cite: a variant may cite its issue's lines beside its own (the callee both misuse). A variant with none restates
 * its issue; one whose every own place overlaps the places of one issue of the set (accepted, rejected, unverified or
 * below the plan) is that issue again, and a rejected one stays rejected; one whose every own place overlaps an earlier
 * variant's is that variant again. Two issues on overlapping lines can be two defects, but the search was told every
 * reported place and asked for other places, and this optional step adds no merge check of its own.
 */
export function withoutDuplicates(variants: readonly VariantFinding[], issues: readonly CanonicalIssue[], findings: ReadonlyMap<string, AuditFinding>): { readonly kept: readonly VariantFinding[]; readonly dropped: readonly VariantDuplicate[] } {
  const placesOf = (issue: CanonicalIssue): readonly Place[] => issue.sourceFindingIds.flatMap((id) => findings.get(id)?.locations ?? []);
  const issuePlaces = issues.map((issue) => ({ issue, places: placesOf(issue) }));
  const byId = new Map(issuePlaces.map((entry) => [entry.issue.candidateId, entry]));
  const kept: { finding: VariantFinding; own: readonly Place[] }[] = []; const dropped: VariantDuplicate[] = [];
  const covered = (own: readonly Place[], places: readonly Place[]) => own.every((place) => places.some((other) => overlaps(place, other)));
  for (const finding of variants) {
    const seed = byId.get(finding.variantOf);
    const own = finding.locations.filter((place) => !(seed?.places ?? []).some((other) => overlaps(place, other)));
    const record = (reason: VariantDuplicate["reason"], duplicateOf: string, disposition?: string) => dropped.push({ sourceFindingId: finding.sourceFindingId, variantOf: finding.variantOf, reason, duplicateOf, ...(disposition === undefined ? {} : { disposition }) });
    if (own.length === 0) { record("restates_its_issue", finding.variantOf); continue; }
    const matches = issuePlaces.filter(({ places }) => covered(own, places));
    const issue = (matches.find(({ issue: candidate }) => candidate.disposition === "rejected") ?? matches[0])?.issue;
    if (issue !== undefined) { record("repeats_an_issue", issue.candidateId, issue.disposition); continue; }
    const earlier = kept.find((entry) => covered(own, entry.own));
    if (earlier !== undefined) { record("repeats_a_variant", earlier.finding.sourceFindingId); continue; }
    kept.push({ finding, own });
  }
  return { kept: kept.map(({ finding }) => finding), dropped };
}
