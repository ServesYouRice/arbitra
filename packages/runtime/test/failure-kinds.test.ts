import { describe, expect, it } from "vitest";
import { FAILURE_KINDS, readFailure, readResumeRefusal, resumable, type FailureKind } from "../src/failure-kinds.js";

/** A provider failure as the runtime records it (`ProviderInvocationRuntime.invoke`). */
const provider = (id: string, code: string, detail: string): string =>
  `ProviderInvocationFailure: Provider ${id} failed after 1 attempt (${code}: ${detail}); completed artifacts are preserved and the run may resume with degraded completeness.`;
const USAGE = "ProviderUsageLimitError: Provider openai reached its usage limit (QUOTA: CLI_USAGE_LIMIT_REACHED: the Codex CLI subscription's usage allowance is exhausted until 2026-10-25T11:46:00.000Z); the run pauses with its completed work kept and goes on when resumed after the reset.";
const SLEPT = "HostSuspendedError: The computer slept from 2026-10-26T10:37:00.000Z to 2026-10-26T11:56:00.000Z while the call was in flight";

describe("the kind of stop a failure reason is", () => {
  it("says to start again where resuming repeats the failure", () => {
    for (const reason of ["Error: REPOSITORY_FILE_LIMIT_EXCEEDED:400", "Error: MODEL_IDENTITY_PLACEHOLDER:auditor-a",
      provider("google", "AUTH", "CLI_ACCOUNT_INELIGIBLE: Gemini CLI no longer serves this Google account's tier"),
      provider("openai", "INVALID_REQUEST", "CLI_EFFORT_PARAMETER_UNSUPPORTED: Codex CLI accepts effort parameters model_reasoning_effort"),
      "ModelActivityInputChangedError: MODEL_ACTIVITY_INPUT_CHANGED:critic/review/1: the version it started on, \"0.3.1\""]) {
      expect(readFailure(reason).kind, reason).toBe("start-again");
    }
    expect(readFailure("Error: REPOSITORY_FILE_LIMIT_EXCEEDED:400")).toEqual({ kind: "start-again", rule: "repository-file-limit", fileLimit: 400 });
    expect(readFailure("ModelActivityInputChangedError: MODEL_ACTIVITY_INPUT_CHANGED:critic/review/1: the version it started on, \"0.3.1\""))
      .toEqual({ kind: "start-again", rule: "activity-input-changed", activityId: "critic/review/1", startedOn: "0.3.1" });
  });

  // veritra (October 25, 2026) stopped four times on these; each resumed once a newer arbitra fixed its cause.
  it("reads a stop no rule names as inside arbitra", () => {
    for (const reason of ["Error: Prompt free text exceeds 1 MiB.", "Error: PEER_CANDIDATE_CONTEXT_LIMIT_EXCEEDED:task:TASK-001",
      "Error: PLANNER_REVISION_ITEM_CONTEXT_LIMIT_EXCEEDED:critic/review/797dd4a3c05400e1756dbd7b/PC-012-ENDPOINT-READINESS", "Error: MODEL_ACTIVITY_INPUT_CHANGED",
      "TypeError: Cannot read properties of undefined (reading 'tasks')", provider("google", "INVALID_REQUEST", "CLI_PROMPT_TOO_LARGE: the Antigravity CLI keeps at most 1048576 bytes of a prompt")]) {
      expect(readFailure(reason), reason).toEqual({ kind: "inside-arbitra", rule: "unnamed" });
    }
    expect(readFailure(null)).toEqual({ kind: "inside-arbitra", rule: "no-reason" });
    expect(readFailure("  ")).toEqual({ kind: "inside-arbitra", rule: "no-reason" });
  });

  it("names what to fix on this computer, with the facts the words need", () => {
    expect(readFailure(provider("anthropic", "AUTH", "CLI_NOT_LOGGED_IN: Claude Code is not signed in to a subscription. Run `claude auth login`.")))
      .toEqual({ kind: "fix-computer", rule: "cli-signed-out", cli: "Claude Code" });
    expect(readFailure(provider("openai", "AUTH", "Credential environment variable OPENAI_API_KEY is not set"))).toEqual({ kind: "fix-computer", rule: "credential-missing", variable: "OPENAI_API_KEY" });
    expect(readFailure("Error: PROVIDER_CREDENTIAL_MISSING")).toEqual({ kind: "fix-computer", rule: "credential-missing", variable: null });
    expect(readFailure(provider("anthropic", "INVALID_REQUEST", "CLI_NOT_INSTALLED: claude was not found on PATH. Install Claude Code."))).toMatchObject({ kind: "fix-computer", rule: "cli-not-started" });
    expect(readFailure(provider("openai", "INVALID_REQUEST", "CLI_TOO_OLD_FOR_MODEL: Codex CLI 0.158.0 does not know gpt-6.1-sol, which needs 0.162.0 or later."))).toMatchObject({ kind: "fix-computer", rule: "cli-too-old" });
    expect(readFailure(provider("openai", "INVALID_REQUEST", "CLI_MODEL_UNAVAILABLE: Codex CLI 0.158.0 refused gpt-6.1-sol"))).toMatchObject({ kind: "fix-computer", rule: "cli-model-unavailable" });
    expect(readFailure("Error: ENOSPC: no space left on device, write")).toEqual({ kind: "fix-computer", rule: "resource", resource: "ENOSPC" });
    expect(readFailure("RUN_REPOSITORY_CHANGED:run-1: the repository no longer holds the files the run read.")).toEqual({ kind: "fix-computer", rule: "repository-changed" });
    expect(readFailure(SLEPT)).toEqual({ kind: "fix-computer", rule: "host-suspended", from: "2026-10-26T10:37:00.000Z", to: "2026-10-26T11:56:00.000Z" });
  });

  it("says to resume now when a model's service, its allowance or a call's time limit stopped it", () => {
    expect(readFailure(USAGE)).toEqual({ kind: "resume-now", rule: "usage-limit", provider: "openai", cli: "Codex CLI", resetsAt: "2026-10-25T11:46:00.000Z" });
    expect(readFailure("ProviderUsageLimitError: Provider anthropic reached its usage limit (QUOTA: credit balance is too low)"))
      .toEqual({ kind: "resume-now", rule: "usage-limit", provider: "anthropic", cli: null, resetsAt: null });
    expect(readFailure("ProviderInvocationFailure: Provider openai failed after 3 attempts (TIMEOUT: Provider stage timed out after 900000ms)")).toEqual({ kind: "resume-now", rule: "time-limit", provider: "openai" });
    expect(readFailure(provider("anthropic", "HTTP", "CLI_UPSTREAM_ERROR: Claude Code could not reach its service"))).toEqual({ kind: "resume-now", rule: "provider-failure", provider: "anthropic" });
  });

  it("has one reason of each kind, and offers a resume for every kind but start-again", () => {
    const one: Readonly<Record<FailureKind, string>> = { "resume-now": USAGE, "fix-computer": SLEPT, "start-again": "Error: MODEL_IDENTITY_PLACEHOLDER:auditor-a", "inside-arbitra": "Error: something new" };
    for (const kind of FAILURE_KINDS) expect(readFailure(one[kind]).kind).toBe(kind);
    expect(FAILURE_KINDS.filter(resumable)).toEqual(["resume-now", "fix-computer", "inside-arbitra"]);
  });

  it("reads a refused resume: already live, not resumable, or a failure a rule names", () => {
    expect(readResumeRefusal("RUN_ALREADY_LIVE:run-1")).toEqual({ rule: "run-already-live" });
    expect(readResumeRefusal("Error: RUN_NOT_RESUMABLE:run-1 (RUN_API_409)")).toEqual({ rule: "run-not-resumable" });
    expect(readResumeRefusal("RUN_REPOSITORY_CHANGED:run-1: …")).toEqual({ rule: "refused", failure: { kind: "fix-computer", rule: "repository-changed" } });
    expect(readResumeRefusal("Error: something new")).toEqual({ rule: "refused", failure: { kind: "inside-arbitra", rule: "unnamed" } });
  });
});
