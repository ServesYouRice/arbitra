# Durability

The design rule: **a crash must never cost a second payment for work already done.** Every
mechanism below exists to make that true, and it was built before any model existed, because
retrofitting durability under a live orchestrator does not work.

## Activities

`packages/core/src/activity.ts` is the unit of durable work. `ActivityRuntime` wraps an
operation with a stable identity (`packages/core/src/activity-id.ts`), journals its
attempts, and stores its output as an artifact.

An activity is idempotent by construction: re-running one whose result is already journalled
returns the recorded result instead of re-executing. That is what makes retry, resume and
replay correct rather than merely likely.

The runner (`packages/core/src/runner/workflow-runner.ts`) never performs I/O or model calls
directly — it schedules activities. The ESLint rule
`tooling/eslint-rules/no-workflow-nondeterminism.cjs` enforces this across
`packages/{core,workflow,persistence}/src`: no `Date.now()`, no `Math.random()`, no direct
network access outside an activity. Time comes from `services/clock.ts`, randomness from
`services/rng.ts`.

## The journal

`packages/persistence/src/journal.ts` — `ActivityJournal`, an append-only log of:

```text
attempt_start   id, attempt, providerRequestId?
attempt_error   the failure, kept; a failed attempt is data, not noise
activity_end    the terminal record and its artifact reference
```

`providerRequestId` is recorded at attempt start so a crash between "provider accepted the
request" and "we recorded the response" is recoverable rather than ambiguous — that window
is exactly where double-billing happens.

`journal-load.ts` replays the log to reconstruct state. A partially written trailing record
is truncated rather than trusted: the log is the truth, and a torn tail is not part of it.

## fsync policy

`packages/persistence/src/fsync.ts` defines `DurabilityClass` and `FsyncPolicy`
(`DEFAULT_FSYNC_POLICY`, `shouldFsync`). Not everything deserves the same cost: a terminal
record that prevents re-paying for a model call is worth an fsync; a progress tick is not.
The policy makes that a declared decision per class rather than an accident of what someone
remembered to flush.

## Artifacts

`packages/persistence/src/artifact-store.ts` (`ArtifactStore`, `ArtifactRef`) is
content-addressed and write-once. The same bytes written twice are the same artifact, which
is what makes replay comparisons meaningful and what lets a resumed run reference work from
before the crash without copying it.

`packages/persistence/src/canonical-json.ts` gives byte-stable serialisation, so "the same
logical value" and "the same bytes" mean the same thing — the precondition for
content addressing, prompt-cache prefixes and artifact identity.

## Run state

`packages/core/src/runner/state-projection.ts` projects run state from the journal
(`projectRunState`, `projectRunner`). State is *derived*, never stored as a mutable field
that could disagree with the log.

`packages/core/src/runner/suspension.ts` handles the states that are not failures:

```text
SuspensionReason      why the run stopped
RunSuspendedError     thrown rather than continuing past a limit
suspendForBudget      budget exhaustion suspends; it does not overspend
resumeState           what a resumed run starts from
planResumeAfterSuspension   what still needs doing
projectedState        what the run looked like at the stop
```

A suspended run exits `3` (suspended or blocked) from the CLI — not `1`, and not `0`. See
`apps/cli/src/exit-policy.ts`.

`packages/core/src/runner/cancellation.ts` (`RunCancellation`) makes cancellation
cooperative and real: an `AbortSignal` reaches the harness tool loop and the provider
runtime, so a cancelled run stops paying rather than finishing quietly in the background.

## Crash semantics

| Failure point | What happens on restart |
|---|---|
| Before `attempt_start` | The activity has not begun; it runs. |
| After `attempt_start`, before the provider responds | `providerRequestId` is journalled; the attempt is recoverable rather than blindly retried. |
| After the response, before `activity_end` | The attempt is journalled as incomplete; the retry is bounded and visible. |
| After `activity_end` | The result is replayed from the artifact store. Nothing is re-paid. |
| Mid-write to the journal | The torn trailing record is truncated on load; the log stays consistent. |
| Mid-write to the evaluation corpus journal | Records after the last `commit`, and any torn line, are truncated on load; the import is retried idempotently. |
| `index.db` deleted | `packages/persistence/src/index-db/rebuild.ts` rebuilds it from the journal and traces, producing an identical query result. The index is a cache, never a source of truth. |

## Configuration drift

`packages/core/src/runner/config-drift.ts` hashes the resolved provider configuration
(`resolvedProviderConfigHash`) and reports drift (`detectConfigDrift`,
`ConfigDriftReport`). Resuming a run whose model or provider configuration changed since it
started is a reportable condition, because the resumed half would not be comparable to the
first half.

## Checkpoints

Feature requirements checkpoints are composed through
`packages/runtime/src/requirements-checkpoint.ts` and immutable run artifacts.
The current contract, approvals, revisions and proposals survive restart. Status exposes
pending ambiguity IDs; CLI and requirements HTTP routes inspect, revise and approve
the current version. Stale versions are rejected, edits clear approvals, and resuming
reuses only model stages matching the current contract. Interactive unresolved decisions
keep the run `BLOCKED`. See [Feature mode](workflows.md#feature-mode).

Generic `human` and `gate` nodes are durable too
(`packages/core/src/runner/graph-checkpoints.ts`, bound to the run directory by
`packages/runtime/src/graph-checkpoint-store.ts`). Each checkpoint version is published as
an immutable artifact. The current version is also named `checkpoint-<node>`. A version is
the hash of the node definition and its inputs. Decisions are create-once records under
`records/checkpoints/<node>/<version>.json`. The record is fsynced under a temporary name and
hard-linked into place, so a second response from any process fails instead of replacing
the first. A response for a superseded version is rejected as stale. The run policy
(`checkpointPolicy`) is saved in the run context. Restart, resume and replay use that saved
policy and the stored graph definition, not the current configuration. The server keeps no
checkpoint state of its own; the previous in-memory registry was removed. See
[Gates and human checkpoints](workflows.md#gates-and-human-checkpoints).

`packages/core/src/checkpoints.ts` is unrelated to graph nodes. It is the security
envelope's rule for when tainted writes or `requires_approval` commands need a checkpoint.
Dedicated web requirements controls remain P10. The web inspector answers only pending
generic human checkpoints.

## Traces and the rebuildable index

`packages/persistence/src/trace.ts` records one exhaustive terminal trace per model
activity — the full identity tuple, token usage, cost, cache hit rate, tool calls, repair
count, continuation state, and `outcome` as `success` · `refusal` · `error` · `cancelled`,
with refusals kept separate from errors.

`index-db/rebuild.ts` builds the SQLite query index from those traces and the journal. It
is disposable by design: delete it and it comes back identical.

## Evaluation corpora

`packages/persistence/src/evaluation-corpus/store.ts` (`EvaluationCorpusStore`) keeps
real-world outcomes, independence observations, run provenance, versioned ground truth,
adjudications and report exports in one corpus directory:

```text
<corpus>/corpus.jsonl                 append-only journal of canonical-JSON records
<corpus>/artifacts/<sha256>.ground-truth    immutable ground-truth versions
<corpus>/artifacts/<sha256>.corpus-report   exported, redacted reports
```

Every write is one batch: its records followed by `{t:"commit", batch, count}`, written in a
single append and flushed as the `expensive` durability class. Ground-truth and report
artifacts are written and flushed before the journal batch that references them, so an
orphaned artifact is possible but a dangling reference is not. Records carry the SHA-256
of their canonical content.

On load the journal is replayed through the same rules that validate imports. A torn
trailing line and complete records after the last commit are truncated, so a crash
mid-import leaves exactly the committed batches (`open()` reports the bytes and records
it rolled back). An invalid or conflicting record *before* the last commit, an
out-of-sequence batch, or a missing or mismatched ground-truth artifact fails closed with
`CorpusJournalCorruptError`; nothing is silently repaired. Imports are idempotent, so
repeating an interrupted import completes it. A failed append invalidates the in-memory
projection, and the next operation reloads and recovers.

The store serialises its own operations but assumes **one writer per corpus directory**;
it takes no cross-process lock. A second writer's conflicting records would make the
journal fail to load rather than be merged. Queries read the journal projection directly;
there is no SQLite projection for corpora yet.

## Recovery boundaries

- **Composed canonical turns.** The runtime rebuilds the tool loop from durable model
  activities and reuses completed recorded turns. Testing write tools bind each call to
  saved arguments/results and recover pending mutations through the workspace journal;
  restart must not repeat a completed write.
- **An interrupted provider request.** There is no mid-response recovery guarantee.
  A resumed attempt can issue another request, retaining the original budget reservation
  and unknown-usage accounting. The optional provider continuation store exists, but
  composed model activities currently disable provider-side continuation.
- **Generic checkpoints.** Feature requirements decisions and generic human-node decisions
  are durable. A decided checkpoint takes effect only when the operator resumes the run.
  Resume reuses the recorded decision for the current version and never asks again.
- **`.runs/` and `implementation/` are mandatory audit exclusions** — `MANDATORY_ROOTS` in
  `packages/security/src/exclusions.ts`, not a configurable default — so a run cannot read
  its own output or its own plan and mistake either for repository evidence.
