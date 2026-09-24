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
| `index.db` deleted | `packages/persistence/src/index-db/rebuild.ts` rebuilds it from the journal and traces, producing an identical query result. The index is a cache, never a source of truth. |
| `model-activity.index.db` deleted, stale or corrupt | The next trace query re-derives it from the committed trace log; responses and trace IDs are unchanged. |

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

The generic policy helpers in `packages/core/src/checkpoints.ts` and the server's
`CheckpointRegistry` are separate groundwork. That registry is in-memory and does not
establish generic durable graph checkpoints. Dedicated web requirements controls and
generic human/gate composition remain completion tasks P09/P10; the current UI should
not be described as able to answer every durable checkpoint.

## Traces and the rebuildable index

`packages/persistence/src/trace.ts` records one exhaustive terminal trace per model
activity — the full identity tuple, token usage, cost, cache hit rate, tool calls, repair
count, continuation state, and `outcome` as `success` · `refusal` · `error` · `cancelled`,
with refusals kept separate from errors.

`index-db/rebuild.ts` builds the SQLite query index from those traces and the journal. It
is disposable by design: delete it and it comes back identical.

The trace browser uses a second, per-run derived index:
`packages/persistence/src/trace-index.ts` keeps `metrics/model-activity.index.db` beside
`metrics/model-activity.jsonl` (SQLite through the built-in `node:sqlite`, no native
dependency). It stores only filter columns (node, model, protocol, outcome, activity) and
the byte range of each **committed** — newline-terminated — non-empty line, so trace IDs
remain the positions `loadActivityTraces` assigns. The log stays authoritative:

- **Catch-up, not rescans.** Each query stats the log and indexes only bytes past the last
  committed offset it recorded. Bytes after the final newline are a torn or in-flight tail
  and are never indexed or served; once a writer completes or repairs that tail, the next
  query indexes it.
- **Staleness checks.** A log shorter than the indexed prefix, or a changed first/last
  indexed line (SHA-256 anchors), discards the index and re-derives it from the log. An
  unreadable database, a wrong format/run ID, or a row count that disagrees with its IDs
  does the same.
- **Every served record comes from the log.** Page and detail responses re-read each
  record's byte range, require it to start and end on line boundaries, parse and validate
  it, and compare it with its index row and the requested filter. A mismatch is treated as
  index corruption: the index is rebuilt and the query retried once. Unserved rows are not
  re-verified per query, so a silently altered row that is never served could skew a filtered
  `total` until the next rebuild; `rebuildTraceIndex` re-derives everything on demand.
- **Log errors are not masked.** An invalid committed line or a foreign run ID fails the
  query with the same error the full-scan loader raises; rebuilding cannot fix the log.

`packages/runtime/test/trace-index.test.ts` compares indexed and full-scan responses over
filter and pagination combinations after append, writer restart, torn tails, explicit
rebuild, index deletion or tampering, and log truncation/replacement.

**Size target and budget.** `pnpm --filter @arbitra/runtime bench:traces` generates a
100 000-trace run (about 91 MB of JSONL) and, per warm browser request, requires p95
latency ≤ 50 ms, ≤ 256 KiB read from the log and ≤ 16 MiB transient heap growth. Observed
on an Apple-silicon Mac (Node 22.23, commit base 391d3e4): cold index build 2.1 s
(17 MB index); warm p95 2–10 ms for first, deep (offset 99 975), node-filtered, 100-row and
detail requests, 17–19 ms for a three-filter composition and the activity-substring filter,
reading 2.6–93 KB of log and allocating under 1 MB. The previous full-scan path took
≈1.0–1.1 s per page, read all 91 MB and grew the heap by ≈490 MB. Filtered totals and the
activity substring still scan index rows (not the log), so their cost grows with history
length; the first query on a large, never-indexed run pays the cold build once.

## Recovery boundaries

- **Composed canonical turns.** The runtime rebuilds the tool loop from durable model
  activities and reuses completed recorded turns. Testing write tools bind each call to
  saved arguments/results and recover pending mutations through the workspace journal;
  restart must not repeat a completed write.
- **An interrupted provider request.** There is no mid-response recovery guarantee.
  A resumed attempt can issue another request, retaining the original budget reservation
  and unknown-usage accounting. The optional provider continuation store exists, but
  composed model activities currently disable provider-side continuation.
- **Generic checkpoints.** Feature requirements decisions are durable; the separate
  in-memory generic server checkpoint registry is not.
- **`.runs/` and `implementation/` are mandatory audit exclusions** — `MANDATORY_ROOTS` in
  `packages/security/src/exclusions.ts`, not a configurable default — so a run cannot read
  its own output or its own plan and mistake either for repository evidence.
