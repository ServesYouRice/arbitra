import { describe, expect, it } from "vitest";
import { changedFiles, failureWords } from "../src/app/words.js";

/** A provider failure as the runtime records it (`ProviderInvocationRuntime.invoke`). */
const provider = (id: string, code: string, detail: string): string =>
  `ProviderInvocationFailure: Provider ${id} failed after 1 attempt (${code}: ${detail}); completed artifacts are preserved and the run may resume with degraded completeness.`;

describe("what a failure means for the person", () => {
  // Every failed run's server status says `resumable: true`: whether resuming can help is in the reason.
  it("offers no resume where resuming repeats the failure, and says to start again", () => {
    for (const reason of ["Error: REPOSITORY_FILE_LIMIT_EXCEEDED:400", "Error: MODEL_IDENTITY_PLACEHOLDER:auditor-a",
      provider("openai", "INVALID_REQUEST", "CLI_MODEL_UNAVAILABLE: Codex CLI refused the configured model for this subscription."),
      provider("openai", "INVALID_REQUEST", "CLI_EFFORT_PARAMETER_UNSUPPORTED: Codex CLI accepts effort parameters model_reasoning_effort")]) {
      const words = failureWords(reason);
      expect(words.resumable, reason).toBe(false);
      expect(words.todo, reason).toMatch(/^Start a new audit .*Resuming this run would stop the same way\.$/u);
    }
    expect(failureWords(provider("openai", "INVALID_REQUEST", "CLI_MODEL_UNAVAILABLE: Codex CLI refused the configured model for this subscription.")).what)
      .toBe("A model in the lineup is not offered to the account its CLI is signed in to.");
  });

  // veritra (October 25, 2026) stopped four times on these; each resumed once a newer arbitra fixed its cause.
  it("says a stop inside arbitra needs a newer arbitra first, and keeps resume for after the update", () => {
    for (const reason of ["Error: Prompt free text exceeds 1 MiB.", "Error: PEER_CANDIDATE_CONTEXT_LIMIT_EXCEEDED:task:TASK-001",
      "Error: PLANNER_REVISION_ITEM_CONTEXT_LIMIT_EXCEEDED:critic/review/797dd4a3c05400e1756dbd7b/PC-012-ENDPOINT-READINESS", "Error: MODEL_ACTIVITY_INPUT_CHANGED",
      "TypeError: Cannot read properties of undefined (reading 'tasks')", provider("google", "INVALID_REQUEST", "CLI_PROMPT_TOO_LARGE: the Antigravity CLI keeps at most 1048576 bytes of a prompt")]) {
      const words = failureWords(reason);
      expect(words.resumable, reason).toBe(true);
      expect(words.what, reason).toBe("The run stopped on an error inside arbitra, not at a model.");
      expect(words.todo, reason).toMatch(/^Resuming with this version of arbitra stops the same way\. Update arbitra, then resume/u);
    }
  });

  it("names what to fix on this computer before resuming", () => {
    const signedOut = failureWords(provider("anthropic", "AUTH", "CLI_NOT_LOGGED_IN: Claude Code is not signed in to a subscription. Run `claude auth login`."));
    expect(signedOut).toMatchObject({ what: "Claude Code is not signed in on this computer.", resumable: true });
    expect(signedOut.todo).toMatch(/^Sign in to it \(the details say how\), then resume the run\./u);
    const key = failureWords(provider("openai", "AUTH", "Credential environment variable OPENAI_API_KEY is not set"));
    expect(key).toMatchObject({ what: "A model's API key is not set on this computer.", resumable: true });
    expect(key.todo).toMatch(/^Set OPENAI_API_KEY, restart arbitra, then resume the run\./u);
    expect(failureWords(provider("anthropic", "INVALID_REQUEST", "CLI_NOT_INSTALLED: claude was not found on PATH. Install Claude Code.")))
      .toMatchObject({ what: "A model's CLI could not be started on this computer.", resumable: true });
    expect(failureWords("Error: ENOSPC: no space left on device, write")).toMatchObject({ what: "This computer refused arbitra a file or resource it needed (ENOSPC).", resumable: true });
  });

  it("says to resume now when a model's service or a call's time limit stopped it", () => {
    expect(failureWords("ProviderInvocationFailure: Provider openai failed after 3 attempts (TIMEOUT: Provider stage timed out after 900000ms)")).toMatchObject({ what: "A model call kept running past its time limit.", resumable: true });
    const upstream = failureWords(provider("anthropic", "HTTP", "CLI_UPSTREAM_ERROR: Claude Code could not reach its service"));
    expect(upstream).toMatchObject({ what: "A model call failed: the model's service or its CLI did not answer as expected.", resumable: true });
    expect(upstream.todo).toMatch(/^Resume the run: it goes on from where it stopped/u);
    expect(failureWords(null)).toMatchObject({ what: "The run stopped on an error, and no reason was recorded.", resumable: true });
  });

  // Observed live (October 27, 2026, v0.3.1, macOS): the edited files had to be found with `find -newer`.
  it("reads the files a refused resume names as changed, as the control plane answers it", () => {
    const refusal = "RUN_REPOSITORY_CHANGED:run-1: the repository no longer holds the files the run read. Put them back as they were to resume it, or start an incremental audit of the project as it is now with this run as its base (run <config> --incremental run-1), which reuses the discovery it finished.";
    expect(changedFiles(`${refusal} 3 files changed since the run read them (1 changed, 1 added, 1 removed): changed README.md, added docs/a, b.md, removed scripts/old.sh (RUN_API_409)`)).toEqual({ total: 3, more: 0,
      files: [{ path: "README.md", change: "changed" }, { path: "docs/a, b.md", change: "added" }, { path: "scripts/old.sh", change: "removed" }] });
    const many = Array.from({ length: 10 }, (_, index) => `changed src/${index}.ts`).join(", ");
    expect(changedFiles(`Error: ${refusal} 14 files changed since the run read them (14 changed): ${many} and 4 more`)).toMatchObject({ total: 14, more: 4 });
    expect(changedFiles(`${refusal} 14 files changed since the run read them (14 changed): ${many} and 4 more`)?.files).toHaveLength(10);
    // A run recorded before arbitra kept its files' hashes names none.
    expect(changedFiles(refusal)).toBeNull();
    expect(failureWords(refusal)).toMatchObject({ what: "The project's files changed after the run read them, so the run cannot go on from where it stopped.", resumable: true });
  });
});
