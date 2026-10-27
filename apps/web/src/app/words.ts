/**
 * One word per idea (docs/DESIGN-LANGUAGE.md, "Words"). Every main line of the run page takes its words from here:
 * the steps, the verdicts, how long something took, and what a failure means for the person. Recorded codes stay in
 * the details and the copied report.
 */

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

/** What a failure means for the person: what happened, what to do, and whether resuming can help. */
export interface FailureWords { readonly what: string; readonly todo: string; readonly resumable: boolean }

const KEPT = "What it finished is kept.";
const AGAIN = "Resuming this run would stop the same way.";
const SEND = "If it stops the same way again, copy the report below and send it to whoever helps you.";

/**
 * What a failure means for the person, read from its recorded reason (`<error name>: <message>`). The control plane
 * says `resumable` of every run that is not done, so whether resuming can help is decided here, by the reason:
 *
 * - the run's own settings or project cause it, and a resume repeats it: start a new run, and no resume is offered;
 * - something on this computer (a sign-in, a key, a CLI, the disk): fix it, then resume;
 * - a model's service or a call's time limit: resume now;
 * - anything else stopped inside arbitra, where the same version stops the same way: update arbitra, then resume.
 *   veritra stopped four times so (October 25, 2026: a prompt over 1 MiB, two sizing limits, a changed call input),
 *   and each resumed once a newer arbitra fixed the cause, so resume stays offered for after the update.
 *
 * Observed (inventory, October 25, 2026): a run whose snapshot was refused offered a resume that could only fail the
 * same way, and every unnamed failure said to resume.
 */
export function failureWords(reason: string | null, mode: Mode = "audit"): FailureWords {
  const text = reason ?? "";
  const run = mode === "audit" ? "audit" : `${mode} run`;
  if (text.trim() === "") return { what: "The run stopped on an error, and no reason was recorded.", todo: `Resume it to go on from where it stopped. ${KEPT} ${SEND}`, resumable: true };
  // Start again: the run's recorded settings or its project are the cause.
  const files = /REPOSITORY_FILE_LIMIT_EXCEEDED:(\d+)/u.exec(text);
  if (files !== null) return { what: `The project has more than ${Number(files[1]).toLocaleString("en")} source files, more than one run reads.`, todo: `Start a new ${run} that reads some folders of the project, or leaves some out. ${AGAIN}`, resumable: false };
  if (/MODEL_IDENTITY_PLACEHOLDER/u.test(text)) return { what: "A model in the lineup is a placeholder, not a model this computer can run.", todo: `Start a new ${run} with a model chosen for each step. ${AGAIN}`, resumable: false };
  if (/CLI_MODEL_UNAVAILABLE|CLI_ACCOUNT_INELIGIBLE/u.test(text)) return { what: "A model in the lineup is not offered to the account its CLI is signed in to.", todo: `Start a new ${run} with another model for that step. ${AGAIN}`, resumable: false };
  if (/CLI_EFFORT_PARAMETER_UNSUPPORTED/u.test(text)) return { what: "A model refused the effort the lineup gives it.", todo: `Start a new ${run} with another effort for that step. ${AGAIN}`, resumable: false };
  // Observed live (veritra, October 25, 2026): after a code change, a resume refused every recorded critic batch.
  const changed = /MODEL_ACTIVITY_INPUT_CHANGED:([^\s:]+)/u.exec(text);
  if (changed !== null) {
    const startedOn = /version it started on, "((?:[^"\\]|\\.)*)"/u.exec(text)?.[1];
    return { what: `This version of arbitra asks for the work of ${activityStep(changed[1] ?? "")} differently from the version the run started on, so it cannot reuse what the run recorded there.`,
      todo: `${startedOn === undefined ? "Resume it with the arbitra version it started on" : `It started on arbitra ${startedOn}. Resume it with that version`}, or start a new run. Resuming it with this version would stop the same way.`, resumable: false };
  }
  // Fix it on this computer, then resume.
  if (/RUN_REPOSITORY_CHANGED/u.test(text)) return { what: "The project's files changed after the run read them, so the run cannot go on from where it stopped.", todo: `Put the files back as they were to resume, or start a new ${run} of the project as it is now.`, resumable: true };
  const signedOut = /CLI_NOT_LOGGED_IN: (.+?) is not signed in/u.exec(text);
  if (signedOut !== null) return { what: `${signedOut[1] ?? "A model's CLI"} is not signed in on this computer.`, todo: `Sign in to it (the details say how), then resume the run. ${KEPT}`, resumable: true };
  const variable = /Credential environment variable (\S+) is not set/u.exec(text)?.[1];
  if (variable !== undefined || /PROVIDER_CREDENTIAL_MISSING/u.test(text)) return { what: "A model's API key is not set on this computer.", todo: `Set ${variable ?? "the key"}, restart arbitra, then resume the run. ${KEPT}`, resumable: true };
  if (/CLI_API_KEY_IN_USE/u.test(text)) return { what: "Claude Code used an API key where the lineup runs through its subscription, so nothing was sent.", todo: `Remove the key from the environment arbitra runs in, restart arbitra, then resume the run. ${KEPT}`, resumable: true };
  if (/CLI_NOT_INSTALLED|CLI_SPAWN_FAILED/u.test(text)) return { what: "A model's CLI could not be started on this computer.", todo: `Install it, or make it findable as the details say, then resume the run. ${KEPT}`, resumable: true };
  if (/CLI_VERSION_UNSUPPORTED|CLI_VERSION_UNREADABLE/u.test(text)) return { what: "A model's CLI is a version arbitra does not support.", todo: `Install a version the details name, or update arbitra, then resume the run. ${KEPT}`, resumable: true };
  if (/\(AUTH: /u.test(text)) return { what: "A model's provider refused the sign-in or key on this computer.", todo: `Check the key or sign in again, restart arbitra, then resume the run. ${KEPT}`, resumable: true };
  const resource = /\b(ENOSPC|EMFILE|ENFILE|ENOMEM|EBUSY|EPERM|EACCES)\b/u.exec(text)?.[1];
  if (resource !== undefined) return { what: `This computer refused arbitra a file or resource it needed (${resource}).`, todo: `Free what the details name, such as disk space or a file another program holds, then resume the run. ${KEPT}`, resumable: true };
  // Resume now: a model's service, its allowance or a call's time limit.
  if (/ProviderUsageLimitError|usage limit|usage allowance/iu.test(text)) return { what: "A model's usage limit was reached.", todo: "Resume the run once the limit has reset. Everything it has done is kept.", resumable: true };
  if (/\bTIMEOUT\b|timed out/iu.test(text)) return { what: "A model call kept running past its time limit.", todo: "Resume the run: it goes on from where it stopped, and calls already finished are kept.", resumable: true };
  if (/^ProviderInvocationFailure: .*\((?:HTTP|RATE_LIMIT|MALFORMED_RESPONSE|CANCELLED|UNKNOWN)\b/u.test(text)) return { what: "A model call failed: the model's service or its CLI did not answer as expected.", todo: `Resume the run: it goes on from where it stopped, and calls already finished are kept. ${SEND}`, resumable: true };
  // Update, then resume: arbitra's own check or defect, which the same version repeats.
  return { what: "The run stopped on an error inside arbitra, not at a model.", todo: "Resuming with this version of arbitra stops the same way. Update arbitra, then resume: what the run finished is kept. If the update does not fix it, copy the report below and send it to whoever helps you.", resumable: true };
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
