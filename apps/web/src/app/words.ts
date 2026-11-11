/**
 * One word per idea (docs/DESIGN-LANGUAGE.md, "Words"). Every main line of the run page takes its words from here:
 * the steps, the verdicts, how long something took, and what a failure means for the person. Recorded codes stay in
 * the details and the copied report.
 */
import type { FinderCoverage } from "@arbitra/schemas/run-progress.js";
import { readFailure, readResumeRefusal, resumable, type FailureReading } from "@arbitra/runtime/failure-kinds.js";

import { formatTime } from "./format.js";

export type Mode = "audit" | "feature" | "testing";
export interface StepNode { readonly id: string; readonly kind: string; readonly label: string }

/** A step's name as a heading: "Find issues". An Audit's steps have fixed names; other graphs keep their labels. */
export function stepName(node: StepNode, mode: Mode): string {
  if (mode !== "audit") return node.label;
  if (node.kind === "deterministic") return "Read the project";
  if (node.kind === "model") return node.id === "planner" ? "Write the plan" : node.id === "critic" ? "Review the plan" : "Find issues";
  if (node.kind === "loop") return "Merge duplicates";
  if (node.kind === "subgraph") return "Check each issue";
  return node.label;
}

/** The same step as what the run is doing: "Finding issues". */
export function stepDoing(node: StepNode, mode: Mode): string {
  const name = stepName(node, mode);
  const doing: Readonly<Record<string, string>> = { "Read the project": "Reading the project", "Find issues": "Finding issues", "Merge duplicates": "Merging duplicates",
    "Check each issue": "Checking each issue", "Write the plan": "Writing the plan", "Review the plan": "Reviewing the plan" };
  return doing[name] ?? name;
}

/** Short words for a step in a list of times: "finding 53 min, checking 19, plan 26". */
export function stepShort(node: StepNode, mode: Mode): string {
  const name = stepName(node, mode);
  const short: Readonly<Record<string, string>> = { "Read the project": "reading", "Find issues": "finding", "Merge duplicates": "merging", "Check each issue": "checking", "Write the plan": "plan", "Review the plan": "review" };
  return short[name] ?? name.toLowerCase();
}

/** A length of time as people say it: "under a minute", "53 min", "1 h 06". */
export function duration(milliseconds: number): string {
  const minutes = Math.floor(Math.max(0, milliseconds) / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")}`;
}

/** A stage's clock in a graph box: "0:01", "1:06". */
export function clock(milliseconds: number): string {
  const minutes = Math.floor(Math.max(0, milliseconds) / 60_000);
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

/** 15800000 → "15.8M"; 213000 → "213K". */
export function tokenWords(value: number): string {
  return value >= 1_000_000 ? `${Number((value / 1_000_000).toFixed(1))}M` : value >= 1_000 ? `${Math.round(value / 1_000)}K` : String(value);
}

export function counted(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en")} ${count === 1 ? one : many}`;
}

/** Why a finder left a part of the project unread, as a person says it (the causes `discovery-declined-*` records). */
const NOT_READ: Readonly<Record<string, (count: number) => string>> = Object.freeze({
  provider_failed: (count: number) => `${counted(count, "call")} failed`,
  provider_refused: (count: number) => `${count.toLocaleString("en")} declined by the provider`,
  reply_rejected: (count: number) => `${count.toLocaleString("en")} with no usable reply`,
});

/**
 * How much of the project a finished finder read: "27 of 32 parts read (5 not read: 3 calls failed, 2 with no usable
 * reply)", or with `brief` "27 of 32 parts read, 5 not read". A finder that read 5 of 32 is not a third opinion.
 */
export function partsReadWords(coverage: FinderCoverage, brief = false): string {
  const notRead = coverage.units - coverage.answered;
  const read = `${coverage.answered.toLocaleString("en")} of ${counted(coverage.units, "part")} read`;
  if (notRead === 0) return read;
  if (brief) return `${read}, ${notRead.toLocaleString("en")} not read`;
  const causes = Object.entries(coverage.notExamined).sort(([left], [right]) => left.localeCompare(right)).map(([cause, count]) => NOT_READ[cause]?.(count) ?? `${count.toLocaleString("en")} ${cause.replaceAll("_", " ")}`);
  return `${read} (${notRead.toLocaleString("en")} not read: ${causes.join(", ")})`;
}

/** Severity words in severity order; the record says "informational", people say "info". */
export const SEVERITIES = ["critical", "high", "medium", "low", "informational"] as const;
export type Severity = typeof SEVERITIES[number];
export function severityWord(severity: string): string { return severity === "informational" ? "info" : severity; }

/** What the check decided about an issue, in its four words, in the order the Issues tab groups them. */
export const VERDICTS = ["confirmed", "unsettled", "rejected", "not checked"] as const;
export type Verdict = typeof VERDICTS[number];

/** How strong a model a task needs, in the words the plan uses: the planner's `frontier` is the strongest model. */
export const TIER_WORDS: Readonly<Record<string, string>> = Object.freeze({ frontier: "strongest", balanced: "mid", fast: "light" });
export function tierWord(tier: string): string { return TIER_WORDS[tier] ?? tier; }

/** How a check that is not a model's question read the code, as a person says it. */
const CHECK_METHODS: Readonly<Record<string, string>> = Object.freeze({
  cited_lines: "arbitra reading the cited lines", symbol_or_call_path: "arbitra following the call path", dependency_or_import_path: "arbitra following the imports",
  route_config_middleware: "arbitra reading the routes and middleware", bounded_deterministic_check: "a deterministic check", allowlisted_safe_test: "running an allowed test",
});
export function checkMethodWords(method: string | null): string | null { return method === null ? null : CHECK_METHODS[method] ?? null; }

/** What came of an issue the executing agent worked on, as recorded in results.json. */
export const RESULT_WORDS: Readonly<Record<string, string>> = Object.freeze({ fixed: "Fixed", no_change_needed: "No change needed", not_reproducible: "Not reproducible", blocked: "Blocked" });

/** The step a model activity belongs to, as the run is doing it, from the stage its ID starts with: "reviewing the plan". */
function activityStep(activityId: string): string {
  const stage = activityId.split("/")[0] ?? "";
  if (stage.startsWith("auditor-")) return "finding issues";
  const steps: Readonly<Record<string, string>> = { "peer-review": "merging duplicates", "peer-conflict": "merging duplicates", "semantic-clustering": "merging duplicates",
    verification: "checking each issue", "variant-search": "searching for variants", planner: "writing the plan", critic: "reviewing the plan", "critique-check": "reviewing the plan" };
  return steps[stage] ?? stage;
}

/** A span the computer slept during a run (ISO-8601). */
export interface Slept { readonly from: string; readonly to: string }
/** How long the computer must be awake after a sleep before a call starts (packages/providers/src/suspend.ts). */
const AWAKE_SETTLE_MS = 120_000;

/**
 * When the computer slept during a run, from its `host_suspended` events, as the run report reads them: a Mac asleep
 * wakes in the dark for under a minute every quarter hour, and suspends apart by less than two minutes are one sleep.
 */
export function sleptSpans(events: readonly { readonly t: string; readonly from?: string; readonly to?: string }[]): readonly Slept[] {
  const spans: { from: number; to: number }[] = [];
  const suspends = events.flatMap(({ t, from, to }) => t === "host_suspended" && from !== undefined && to !== undefined && Number.isFinite(Date.parse(from)) && Number.isFinite(Date.parse(to))
    ? [{ from: Date.parse(from), to: Date.parse(to) }] : []).sort((a, b) => a.from - b.from);
  for (const suspend of suspends) {
    const last = spans.at(-1);
    if (last !== undefined && suspend.from - last.to < AWAKE_SETTLE_MS) last.to = Math.max(last.to, suspend.to);
    else spans.push({ ...suspend });
  }
  return spans.map(({ from, to }) => ({ from: new Date(from).toISOString(), to: new Date(to).toISOString() }));
}

/** "The computer slept from 26 Oct, 10:37 to 26 Oct, 11:56; calls in flight were sent again." Null when it did not sleep. */
export function sleptWords(spans: readonly Slept[]): string | null {
  return spans.length === 0 ? null : `The computer slept ${spans.map(({ from, to }) => `from ${formatTime(from)} to ${formatTime(to)}`).join(" and ")}; calls in flight were sent again.`;
}

const AWAKE = "Keep the computer awake while the run works (on a Mac, with its lid open), then resume the run: it goes on from where it stopped, and calls already finished are kept.";

/** What a failure means for the person: what happened, what to do, and whether resuming can help. */
export interface FailureWords { readonly what: string; readonly todo: string; readonly resumable: boolean }

const KEPT = "What it finished is kept.";
const AGAIN = "Resuming this run would stop the same way.";
const SEND = "If it stops the same way again, copy the report below and send it to whoever helps you.";

/**
 * What a failure means for the person, read from its recorded reason (`<error name>: <message>`). The control plane
 * says `resumable` of every run that is not done, so whether resuming can help is decided by the reason's kind, which
 * packages/runtime/src/failure-kinds.ts reads, the same reading the run helper resumes by: these are only its words.
 */
export function failureWords(reason: string | null, mode: Mode = "audit"): FailureWords {
  const reading = readFailure(reason);
  return { ...readingWords(reading, mode), resumable: resumable(reading.kind) };
}

function readingWords(reading: FailureReading, mode: Mode): { readonly what: string; readonly todo: string } {
  const run = mode === "audit" ? "audit" : `${mode} run`;
  switch (reading.rule) {
    case "no-reason": return { what: "The run stopped on an error, and no reason was recorded.", todo: `Resume it to go on from where it stopped. ${KEPT} ${SEND}` };
    case "host-suspended": return { what: `The computer slept from ${formatTime(reading.from)} to ${formatTime(reading.to)} while the run's model calls were in flight, and they could not finish across it.`, todo: AWAKE };
    case "repository-file-limit": return { what: `The project has more than ${reading.fileLimit.toLocaleString("en")} source files, more than one run reads.`, todo: `Start a new ${run} that reads some folders of the project, or leaves some out. ${AGAIN}` };
    case "model-placeholder": return { what: "A model in the lineup is a placeholder, not a model this computer can run.", todo: `Start a new ${run} with a model chosen for each step. ${AGAIN}` };
    case "account-ineligible": return { what: "A model in the lineup is not offered to the account its CLI is signed in to.", todo: `Start a new ${run} with another model for that step. ${AGAIN}` };
    case "effort-unsupported": return { what: "A model refused the effort the lineup gives it.", todo: `Start a new ${run} with another effort for that step. ${AGAIN}` };
    case "activity-input-changed": return { what: `This version of arbitra asks for the work of ${activityStep(reading.activityId)} differently from the version the run started on, so it cannot reuse what the run recorded there.`,
      todo: `${reading.startedOn === null ? "Resume it with the arbitra version it started on" : `It started on arbitra ${reading.startedOn}. Resume it with that version`}, or start a new run. Resuming it with this version would stop the same way.` };
    case "repository-changed": return { what: "The project's files changed after the run read them, so the run cannot go on from where it stopped.", todo: `Put the files back as they were to resume, or start a new ${run} of the project as it is now.` };
    case "cli-signed-out": return { what: `${reading.cli ?? "A model's CLI"} is not signed in on this computer.`, todo: `Sign in to it (the details say how), then resume the run. ${KEPT}` };
    case "credential-missing": return { what: "A model's API key is not set on this computer.", todo: `Set ${reading.variable ?? "the key"}, restart arbitra, then resume the run. ${KEPT}` };
    case "api-key-in-use": return { what: "Claude Code used an API key where the lineup runs through its subscription, so nothing was sent.", todo: `Remove the key from the environment arbitra runs in, restart arbitra, then resume the run. ${KEPT}` };
    case "cli-not-started": return { what: "A model's CLI could not be started on this computer.", todo: `Install it, or make it findable as the details say, then resume the run. ${KEPT}` };
    // Observed live (October 26, 2026, macOS): the words said the account was not offered the model, when updating the CLI and resuming was the fix.
    case "cli-too-old": return { what: "A model's CLI on this computer is too old for a model in the lineup.", todo: `Install the current version of that CLI (the details say how), then resume the run. ${KEPT}` };
    case "cli-model-unavailable": return { what: "A model's CLI refused a model in the lineup: the account's plan may not include it, or the CLI is older than the model.", todo: `Update that CLI (the details name it) and resume the run, or start a new ${run} with another model for that step. ${KEPT}` };
    case "cli-version-unsupported": return { what: "A model's CLI is a version arbitra does not support.", todo: `Install a version the details name, or update arbitra, then resume the run. ${KEPT}` };
    case "auth-refused": return { what: "A model's provider refused the sign-in or key on this computer.", todo: `Check the key or sign in again, restart arbitra, then resume the run. ${KEPT}` };
    case "resource": return { what: `This computer refused arbitra a file or resource it needed (${reading.resource}).`, todo: `Free what the details name, such as disk space or a file another program holds, then resume the run. ${KEPT}` };
    case "usage-limit": return { what: "A model's usage limit was reached.", todo: "Resume the run once the limit has reset. Everything it has done is kept." };
    case "time-limit": return { what: "A model call kept running past its time limit.", todo: "Resume the run: it goes on from where it stopped, and calls already finished are kept." };
    case "provider-failure": return { what: "A model call failed: the model's service or its CLI did not answer as expected.", todo: `Resume the run: it goes on from where it stopped, and calls already finished are kept. ${SEND}` };
    case "unnamed": return { what: "The run stopped on an error inside arbitra, not at a model.", todo: "Resuming with this version of arbitra stops the same way. Update arbitra, then resume: what the run finished is kept. If the update does not fix it, copy the report below and send it to whoever helps you." };
  }
}

/**
 * What a resume the server refused means for the person, from the refusal's message: why it did not go on, and what to
 * do. A refusal no named reason covers says to try again, and to copy the details if it is refused the same way.
 */
export function resumeRefusalWords(refusal: string, mode: Mode = "audit"): { readonly what: string; readonly todo: string } {
  const reading = readResumeRefusal(refusal);
  if (reading.rule === "run-already-live") return { what: "arbitra is already working on this run, so nothing was started.", todo: "Wait for the run to stop, or reload the page to see where it stands." };
  if (reading.rule === "run-not-resumable") return { what: "This run cannot be resumed in the state it is in, so nothing was started.", todo: "Reload the page to see what the run can do now." };
  if (reading.failure.rule !== "unnamed") { const named: FailureWords = { ...readingWords(reading.failure, mode), resumable: resumable(reading.failure.kind) }; return named; }
  return { what: "The resume was refused, so the run is as it was.", todo: "Try again. If it is refused the same way, copy the details below and send them to whoever helps you." };
}

/** A run event as the helper's words read it: a `helper_action` event (packages/runtime/src/run-helper.ts) or any other. */
export interface HelperEvent { readonly t: string; readonly action?: string; readonly reason?: string; readonly kind?: string; readonly result?: string; readonly until?: string; readonly at?: string }

const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * What the run helper did about the run's stops, from its events: each resume ("Resumed by the helper at 26 Oct, 14:02,
 * because a model's usage limit was reached."), and while the run is stopped, what it is doing now: waiting until a
 * time, or leaving a stop it would resume to the person, and why. Its reason is read with the same words as the page's.
 */
export function helperWords(events: readonly HelperEvent[], stopped: boolean, mode: Mode = "audit"): readonly string[] {
  const actions = events.filter(({ t }) => t === "helper_action");
  const lines = actions.filter(({ action }) => action === "resume").map(({ at, reason }) => `Resumed by the helper at ${formatTime(at ?? null)}, because ${lowerFirst(failureWords(reason ?? null, mode).what)}`);
  const last = actions.at(-1);
  // Only the helper's action after the run's last stop says where it stands now; a run working again has none.
  if (!stopped || last === undefined || events.at(-1) !== last) return lines;
  if (last.action === "wait" && last.until !== undefined) return [...lines, `The helper waits until ${formatTime(last.until)}. ${last.result ?? ""}`.trim()];
  if (last.action === "leave" && last.kind === "resume-now") return [...lines, `The helper did not resume it: ${lowerFirst(last.result ?? "")}`];
  if (last.action === "resume-refused") return [...lines, `The helper tried to resume it, and ${lowerFirst(last.result ?? "")}`];
  return lines;
}

/** Whether the helper is waiting to resume the run now, from its events. */
export function helperWaiting(events: readonly HelperEvent[]): boolean {
  const last = events.at(-1);
  return last?.t === "helper_action" && last.action === "wait";
}

/** The files a refusal names as changed since the run read them, and how many it names in all. */
export interface ChangedFiles { readonly total: number; readonly files: readonly { readonly path: string; readonly change: "changed" | "added" | "removed" }[]; readonly more: number }

/**
 * The files a `RUN_REPOSITORY_CHANGED` refusal names (`… 5 files changed since the run read them (3 changed, 2 added):
 * changed README.md, added scripts/new.sh and 3 more`), as the orchestrator words it; null when it names none. A
 * control-plane error ends with its status (`(RUN_API_409)`), which is not part of the list.
 */
export function changedFiles(text: string | null): ChangedFiles | null {
  const match = /RUN_REPOSITORY_CHANGED:[\s\S]*? (\d+) files? changed since the run read them \([^)]*\): ([\s\S]+?)(?: and (\d+) more)?(?: \(RUN_API_\d+\))?$/u.exec(text ?? "");
  if (match === null) return null;
  const files = (match[2] ?? "").split(/, (?=(?:changed|added|removed) )/u).flatMap((entry) => {
    const named = /^(changed|added|removed) ([\s\S]+)$/u.exec(entry);
    return named === null ? [] : [{ change: named[1] as "changed" | "added" | "removed", path: named[2] ?? "" }];
  });
  return { total: Number(match[1]), files, more: Number(match[3] ?? 0) };
}

/** A failed run reads plainly first: the code and message go in the details. */
export function failureDetail(reason: string | null): string { return reason ?? "no reason recorded"; }
