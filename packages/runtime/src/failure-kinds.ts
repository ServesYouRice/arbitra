/**
 * What kind of stop a run's recorded failure reason (`<error name>: <message>`) is, and the facts its words need. The
 * run page builds its words from this (apps/web/src/app/words.ts) and the run helper decides from it whether to resume
 * (run-helper.ts), so the two can never disagree. Plain rules, no model call; this module imports nothing, so the web
 * app bundles it as it is.
 *
 * - `start-again`: the run's own settings or its project cause it, and a resume repeats it: start a new run.
 * - `fix-computer`: something on this computer (a sign-in, a key, a CLI, the disk, a sleep): fix it, then resume.
 * - `resume-now`: a model's service, its allowance or a call's time limit: resume (once the limit has reset).
 * - `inside-arbitra`: anything else stopped inside arbitra, where the same version stops the same way: update arbitra,
 *   then resume. veritra stopped four times so (October 25, 2026: a prompt over 1 MiB, two sizing limits, a changed
 *   call input), and each resumed once a newer arbitra fixed the cause, so a resume stays offered for after the update.
 *
 * Observed (inventory, October 25, 2026): a run whose snapshot was refused offered a resume that could only fail the
 * same way, and every unnamed failure said to resume.
 *
 * A call the computer's sleep stopped names the sleep, not a provider: the runtime records it as HostSuspendedError,
 * and a plain timeout is one the runtime found no sleep across. Observed live (October 26, 2026, macOS): a run that
 * failed in the Mac's dark wakes said "Provider openai failed after 3 attempts", which sent its tester after the wrong
 * cause.
 */
export const FAILURE_KINDS = ["resume-now", "fix-computer", "start-again", "inside-arbitra"] as const;
export type FailureKind = typeof FAILURE_KINDS[number];

/** One rule's reading of a reason: its kind, which rule named it, and what the reason says that the words name. */
export type FailureReading =
  | { readonly kind: "inside-arbitra"; readonly rule: "no-reason" }
  /** The computer slept from `from` to `to` (ISO-8601) while calls were in flight. */
  | { readonly kind: "fix-computer"; readonly rule: "host-suspended"; readonly from: string; readonly to: string }
  /** The project has more source files than `fileLimit`, which one run reads. */
  | { readonly kind: "start-again"; readonly rule: "repository-file-limit"; readonly fileLimit: number }
  | { readonly kind: "start-again"; readonly rule: "model-placeholder" }
  | { readonly kind: "start-again"; readonly rule: "account-ineligible" }
  | { readonly kind: "start-again"; readonly rule: "effort-unsupported" }
  /** Observed live (veritra, October 25, 2026): after a code change, a resume refused every recorded critic batch. */
  | { readonly kind: "start-again"; readonly rule: "activity-input-changed"; readonly activityId: string; /** The arbitra build the run started on. */ readonly startedOn: string | null }
  | { readonly kind: "fix-computer"; readonly rule: "repository-changed" }
  /** `cli`: the CLI that is signed out, as the reason names it. */
  | { readonly kind: "fix-computer"; readonly rule: "cli-signed-out"; readonly cli: string | null }
  /** `variable`: the environment variable that is not set. */
  | { readonly kind: "fix-computer"; readonly rule: "credential-missing"; readonly variable: string | null }
  | { readonly kind: "fix-computer"; readonly rule: "api-key-in-use" }
  | { readonly kind: "fix-computer"; readonly rule: "cli-not-started" }
  /** Observed live (October 26, 2026, macOS): the Codex CLI inside the ChatGPT app was too old for GPT-6.1 Sol. */
  | { readonly kind: "fix-computer"; readonly rule: "cli-too-old" }
  | { readonly kind: "fix-computer"; readonly rule: "cli-model-unavailable" }
  | { readonly kind: "fix-computer"; readonly rule: "cli-version-unsupported" }
  | { readonly kind: "fix-computer"; readonly rule: "auth-refused" }
  /** `resource`: the error code the computer refused with (`ENOSPC`, `EBUSY`). */
  | { readonly kind: "fix-computer"; readonly rule: "resource"; readonly resource: string }
  /** A profile reached its dollar cap with no fallback: the owner raises the cap on resume, so it is never resumed by itself. */
  | { readonly kind: "fix-computer"; readonly rule: "cost-cap"; readonly profile: string; readonly spent: string; readonly cap: string }
  /**
   * A model's allowance ran out. `provider`: the provider ID (`openai`); `cli`: the subscription's CLI as the reason
   * names it (`Codex CLI`); `resetsAt`: when it resets (ISO-8601), when the provider said.
   */
  | { readonly kind: "resume-now"; readonly rule: "usage-limit"; readonly provider: string | null; readonly cli: string | null; readonly resetsAt: string | null }
  | { readonly kind: "resume-now"; readonly rule: "time-limit"; readonly provider: string | null }
  | { readonly kind: "resume-now"; readonly rule: "provider-failure"; readonly provider: string | null }
  /** No rule names it. */
  | { readonly kind: "inside-arbitra"; readonly rule: "unnamed" };

export type FailureRule = FailureReading["rule"];

/** Whether a resume can help at all: only a stop the run's own settings or project cause repeats on every resume. */
export function resumable(kind: FailureKind): boolean { return kind !== "start-again"; }

const providerOf = (text: string): string | null => /\bProvider (\S+) (?:failed|reached)\b/u.exec(text)?.[1] ?? null;

/** The kind of stop a recorded failure reason is; the rules run in order, and the first that names it decides. */
export function readFailure(reason: string | null): FailureReading {
  const text = reason ?? "";
  if (text.trim() === "") return { kind: "inside-arbitra", rule: "no-reason" };
  const asleep = /^HostSuspendedError: The computer slept from (\S+) to (\S+) /u.exec(text);
  if (asleep !== null) return { kind: "fix-computer", rule: "host-suspended", from: asleep[1] ?? "", to: asleep[2] ?? "" };
  // Start again: the run's recorded settings or its project are the cause.
  const files = /REPOSITORY_FILE_LIMIT_EXCEEDED:(\d+)/u.exec(text);
  if (files !== null) return { kind: "start-again", rule: "repository-file-limit", fileLimit: Number(files[1]) };
  if (/MODEL_IDENTITY_PLACEHOLDER/u.test(text)) return { kind: "start-again", rule: "model-placeholder" };
  if (/CLI_ACCOUNT_INELIGIBLE/u.test(text)) return { kind: "start-again", rule: "account-ineligible" };
  if (/CLI_EFFORT_PARAMETER_UNSUPPORTED/u.test(text)) return { kind: "start-again", rule: "effort-unsupported" };
  const changed = /MODEL_ACTIVITY_INPUT_CHANGED:([^\s:]+)/u.exec(text);
  if (changed !== null) return { kind: "start-again", rule: "activity-input-changed", activityId: changed[1] ?? "", startedOn: /version it started on, "((?:[^"\\]|\\.)*)"/u.exec(text)?.[1] ?? null };
  // Fix it on this computer, then resume.
  if (/RUN_REPOSITORY_CHANGED/u.test(text)) return { kind: "fix-computer", rule: "repository-changed" };
  const signedOut = /CLI_NOT_LOGGED_IN: (.+?) is not signed in/u.exec(text);
  if (signedOut !== null) return { kind: "fix-computer", rule: "cli-signed-out", cli: signedOut[1] ?? null };
  const variable = /Credential environment variable (\S+) is not set/u.exec(text)?.[1];
  if (variable !== undefined || /PROVIDER_CREDENTIAL_MISSING/u.test(text)) return { kind: "fix-computer", rule: "credential-missing", variable: variable ?? null };
  if (/CLI_API_KEY_IN_USE/u.test(text)) return { kind: "fix-computer", rule: "api-key-in-use" };
  if (/CLI_NOT_INSTALLED|CLI_SPAWN_FAILED/u.test(text)) return { kind: "fix-computer", rule: "cli-not-started" };
  if (/CLI_TOO_OLD_FOR_MODEL/u.test(text)) return { kind: "fix-computer", rule: "cli-too-old" };
  if (/CLI_MODEL_UNAVAILABLE/u.test(text)) return { kind: "fix-computer", rule: "cli-model-unavailable" };
  if (/CLI_VERSION_UNSUPPORTED|CLI_VERSION_UNREADABLE/u.test(text)) return { kind: "fix-computer", rule: "cli-version-unsupported" };
  if (/\(AUTH: /u.test(text)) return { kind: "fix-computer", rule: "auth-refused" };
  const resource = /\b(ENOSPC|EMFILE|ENFILE|ENOMEM|EBUSY|EPERM|EACCES)\b/u.exec(text)?.[1];
  if (resource !== undefined) return { kind: "fix-computer", rule: "resource", resource };
  const capped = /MODEL_COST_CAP_REACHED:(\S+): \S+ has spent (\$[\d.]+) of its (\$[\d.]+) cap/u.exec(text);
  if (capped !== null) return { kind: "fix-computer", rule: "cost-cap", profile: capped[1] ?? "", spent: capped[2] ?? "", cap: capped[3] ?? "" };
  // Resume now: a model's service, its allowance or a call's time limit.
  if (/ProviderUsageLimitError|usage limit|usage allowance/iu.test(text)) {
    const until = /\buntil (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/u.exec(text)?.[1];
    return { kind: "resume-now", rule: "usage-limit", provider: providerOf(text), cli: /\bthe (.+?) subscription's usage allowance/u.exec(text)?.[1] ?? null,
      resetsAt: until !== undefined && Number.isFinite(Date.parse(until)) ? until : null };
  }
  if (/\bTIMEOUT\b|timed out/iu.test(text)) return { kind: "resume-now", rule: "time-limit", provider: providerOf(text) };
  if (/^ProviderInvocationFailure: .*\((?:HTTP|RATE_LIMIT|MALFORMED_RESPONSE|CANCELLED|UNKNOWN)\b/u.test(text)) return { kind: "resume-now", rule: "provider-failure", provider: providerOf(text) };
  // Update, then resume: arbitra's own check or defect, which the same version repeats.
  return { kind: "inside-arbitra", rule: "unnamed" };
}

/** What a resume the server refused is, from the refusal's message. */
export type RefusalReading =
  | { readonly rule: "run-already-live" }
  | { readonly rule: "run-not-resumable" }
  /** The resume was refused for a reason a failure rule names (`RUN_REPOSITORY_CHANGED`, a CLI signed out), or none. */
  | { readonly rule: "refused"; readonly failure: FailureReading };

export function readResumeRefusal(refusal: string): RefusalReading {
  if (/RUN_ALREADY_LIVE:/u.test(refusal)) return { rule: "run-already-live" };
  if (/RUN_NOT_RESUMABLE:/u.test(refusal)) return { rule: "run-not-resumable" };
  return { rule: "refused", failure: readFailure(refusal) };
}
