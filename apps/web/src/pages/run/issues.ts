import { useMemo } from "react";
import type { ArtifactDescriptor } from "../../api/artifacts.js";
import { useLoaded, type Loaded, type RunOverview } from "../../api/runs.js";
import { useApis } from "../../app/apis.js";
import { checkMethodWords, SEVERITIES, type Verdict } from "../../app/words.js";
import type { PersistedFinding, PersistedIssue, PersistedIssueSet, PersistedLocation } from "../../views/issue-board/model.js";
import { RUN_ARTIFACT_KINDS, useRunArtifact, type RunArtifact } from "../../views/issue-board/run-artifacts.js";
import type { PersistedPlan } from "../../views/plan/traceability.js";
import type { TraceApi } from "../../views/traces/api.js";
import { stepModels } from "./facts.js";
import { attemptLabel, configuredChecker } from "./models.js";

/**
 * What the check decided about an issue, counted as `confirmed-yield.ts` counts it, so the Issues tab's groups and the
 * Summary's counts agree: confirmed is upheld by the check; rejected is refused, by the check or the reviewers;
 * unsettled is a question the code could not answer; the rest were not checked (below the plan's bar, or left open).
 */
export function verdictOf(issue: Pick<PersistedIssue, "disposition" | "verificationOutcome">): Verdict {
  if (issue.verificationOutcome === "CONFIRMED" && (issue.disposition === "accepted" || issue.disposition === "verified_single_source")) return "confirmed";
  if (issue.disposition === "rejected") return "rejected";
  if (issue.verificationOutcome === "STILL_NEEDS_VERIFICATION") return "unsettled";
  return "not checked";
}

/** The finders of an issue: source finding IDs begin with the finder, and peer review's carry `review-<round>` next. */
export function findersOf(sourceFindingIds: readonly string[]): readonly string[] {
  const finder = (id: string) => id.split("/")[0] ?? id;
  const discovered = sourceFindingIds.filter((id) => !/^review-\d+$/u.test(id.split("/")[1] ?? ""));
  return [...new Set((discovered.length === 0 ? sourceFindingIds : discovered).map(finder))];
}

/** A place as a person reads it: `src/a.ts:40`; with its range, `src/a.ts:40–52`. */
export function placeText({ path, startLine }: PersistedLocation): string { return `${path}:${startLine}`; }
export function placeRange({ path, startLine, endLine }: PersistedLocation): string { return endLine > startLine ? `${path}:${startLine}–${endLine}` : `${path}:${startLine}`; }

/** One issue as the Issues tab shows it, joined from the run's records; nothing here is computed that the run did not record. */
export interface IssueView {
  readonly issue: PersistedIssue;
  readonly verdict: Verdict;
  readonly places: readonly PersistedLocation[];
  readonly evidence: readonly { readonly id: string; readonly text: string; readonly place: string | null }[];
  /** Each finder by model and effort (a scripted run's by its detector). */
  readonly foundBy: readonly string[];
  /** Who checked it, by model and effort as its recorded attempt ran, else as the configuration assigns it; null when nothing checked it. */
  readonly checkedBy: string | null;
  /** The check's method when it was not a model's question. */
  readonly method: string | null;
  /** The plan's tasks that fix it. */
  readonly tasks: readonly { readonly id: string; readonly title: string }[];
  /** Below the plan's severity bar, so the check skipped it. */
  readonly belowBar: boolean;
}

interface VerificationOperation { readonly candidateId: string; readonly verification?: { readonly activityId?: string; readonly method?: string } }
interface BelowPlanScope { readonly candidateIds?: readonly string[] }

/** Most severe first; issues of one severity keep the order the run recorded them in. */
export function bySeverity<T extends { readonly issue: { readonly severity: string } }>(views: readonly T[]): readonly T[] {
  return [...views].sort((a, b) => SEVERITIES.indexOf(a.issue.severity as typeof SEVERITIES[number]) - SEVERITIES.indexOf(b.issue.severity as typeof SEVERITIES[number]));
}

/** Whether an issue's title, the finder's words or a place contain every word of `query`. */
export function matches(view: IssueView, query: string): boolean {
  const text = [view.issue.claim.title, view.issue.claim.description, ...view.places.map(placeRange)].join("\n").toLowerCase();
  return query.toLowerCase().split(/\s+/u).filter((word) => word !== "").every((word) => text.includes(word));
}

export interface IssuesData {
  readonly issueSet: RunArtifact<PersistedIssueSet>;
  readonly views: readonly IssueView[];
  /** The records still loading or unreadable, in words: places, checkers and tasks may show as missing until they load. */
  readonly pending: readonly string[];
}

/**
 * The records the Issues tab joins: the issue set, the findings with their places and evidence, the verification
 * operations (which attempt checked each issue), the issues below the plan's bar, the plan's tasks, and the
 * verification stage's model attempts, whose model and effort name the checker each issue actually had.
 */
export function useIssues(runId: string, overview: RunOverview | null, artifacts: readonly ArtifactDescriptor[], refreshKey: unknown): IssuesData {
  const { artifacts: api, traces } = useApis();
  const has = (kind: string) => artifacts.some((artifact) => artifact.kind === kind) ? runId : null;
  const issueSet = useRunArtifact<PersistedIssueSet>(api, runId, RUN_ARTIFACT_KINDS.canonicalIssues, refreshKey);
  const findings = useRunArtifact<readonly PersistedFinding[]>(api, has(RUN_ARTIFACT_KINDS.sourceFindings), RUN_ARTIFACT_KINDS.sourceFindings, refreshKey);
  const operations = useRunArtifact<readonly VerificationOperation[]>(api, has("verification-operations"), "verification-operations", refreshKey);
  const below = useRunArtifact<BelowPlanScope>(api, has("verification-below-plan-scope"), "verification-below-plan-scope", refreshKey);
  const plan = useRunArtifact<PersistedPlan>(api, has(RUN_ARTIFACT_KINDS.plan), RUN_ARTIFACT_KINDS.plan, refreshKey);
  const attempts = useCheckAttempts(traces, overview?.executor === "models" ? runId : null, refreshKey);
  const configuration = overview?.configuration ?? null;
  const views = useMemo(() => {
    if (issueSet.value === null) return [];
    const byFinding = new Map((findings.value ?? []).map((finding) => [finding.sourceFindingId, finding]));
    const activities = new Map((operations.value ?? []).map(({ candidateId, verification }) => [candidateId, verification]));
    const belowBar = new Set(below.value?.candidateIds ?? []);
    const models = stepModels(overview);
    const scripted = overview?.executor === "scripted";
    return issueSet.value.issues.map((issue): IssueView => {
      const linked = issue.sourceFindingIds.flatMap((id) => byFinding.get(id) ?? []);
      const places = linked.flatMap(({ locations }) => locations);
      const located = new Map(places.map((location) => [location.id, location]));
      const verdict = verdictOf(issue);
      const verification = activities.get(issue.candidateId);
      const method = verification?.method ?? null;
      const recorded = verification?.activityId === undefined ? undefined : attempts.value?.get(verification.activityId);
      const checkedBy = issue.verificationOutcome === null && verification === undefined ? null
        : method !== null && method !== "single_model_question" ? checkMethodWords(method) ?? method
        : recorded !== undefined ? attemptLabel(configuration, recorded.modelId, recorded.level) : configuredChecker(configuration, issue.severity);
      return {
        issue, verdict, places,
        evidence: linked.flatMap(({ evidence }) => evidence.map(({ id, text, locationIds }) => {
          const place = locationIds.map((locationId) => located.get(locationId)).find((location) => location !== undefined);
          return { id, text, place: place === undefined ? null : placeRange(place) };
        })),
        foundBy: scripted ? ["scripted detectors"] : [...new Set(findersOf(issue.sourceFindingIds).map((finder) => models.get(finder) ?? finder))],
        checkedBy, method: method === "single_model_question" ? null : method,
        tasks: (plan.value?.tasks ?? []).filter(({ addresses }) => addresses.issues.includes(issue.candidateId)).map(({ id, title }) => ({ id, title })),
        belowBar: belowBar.has(issue.candidateId),
      };
    });
  }, [issueSet.value, findings.value, operations.value, below.value, plan.value, attempts.value, overview, configuration]);
  const pending = ([["the places and evidence", findings], ["who checked each issue", operations], ["the plan's tasks", plan]] as const)
    .flatMap(([label, artifact]) => artifact.state === "loading" ? [`reading ${label}`] : artifact.state === "error" ? [`${label} could not be read`] : []);
  return { issueSet, views, pending };
}

export type CheckAttempts = ReadonlyMap<string, { readonly modelId: string; readonly level: string | null; readonly attempt: number }>;
// The Issues tab and the details panel read the same attempts; one read per client serves both for a run event.
const attemptCaches = new WeakMap<TraceApi, Map<string, Promise<CheckAttempts>>>();

/** The verification stage's recorded attempts: for each activity, the model and effort level of its last attempt. */
export function useCheckAttempts(traces: TraceApi, runId: string | null, refreshKey: unknown): Loaded<CheckAttempts> {
  return useLoaded(runId === null ? null : `check-attempts:${runId}`, () => {
    const attemptReads = attemptCaches.get(traces) ?? new Map<string, Promise<CheckAttempts>>();
    attemptCaches.set(traces, attemptReads);
    const key = `${runId ?? ""}\u0000${String(refreshKey)}`;
    const known = attemptReads.get(key);
    if (known !== undefined) return known;
    const read = readCheckAttempts(traces, runId ?? "");
    attemptReads.set(key, read);
    read.catch(() => attemptReads.delete(key));
    for (const oldest of attemptReads.keys()) { if (attemptReads.size <= 4) break; attemptReads.delete(oldest); }
    return read;
  }, refreshKey);
}

async function readCheckAttempts(traces: TraceApi, runId: string): Promise<CheckAttempts> {
  const attempts = new Map<string, { readonly modelId: string; readonly level: string | null; readonly attempt: number }>();
  // A run checks a few hundred issues; the pages stop at fifty, well past any run recorded.
  for (let offset: number | null = 0, page = 0; offset !== null && page < 50; page += 1) {
    const read = await traces.list(runId, { nodeId: "verification" }, offset, 100);
    for (const { trace } of read.entries) {
      // An attempt's activity carries its turn (`…/question/turn-0`); the operation names the activity.
      const activity = trace.activityId.replace(/\/turn-\d+$/u, "");
      const known = attempts.get(activity);
      if (known === undefined || trace.attempt >= known.attempt) attempts.set(activity, { modelId: trace.modelId, level: trace.effortResolved, attempt: trace.attempt });
    }
    offset = read.nextOffset;
  }
  return attempts;
}
