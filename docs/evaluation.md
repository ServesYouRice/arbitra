# Evaluation

arbitra's premise is that independent auditors find defects a single model misses. That is
a hypothesis, and this layer exists to test it — including the possibility that it is false
for a given repository, protocol or model set.

A tool that reports its third auditor produced noise is more trustworthy, and more useful,
than one that always finds twenty issues. It is also the only way anyone learns which models
are worth paying for.

## The measurement rule

**Never fabricate usage, cost or capability data.** An unmeasured value is `null`, and every
surface renders `null` as *unavailable* — never as zero. A measured zero and an absent
measurement are different claims, and the distinction is preserved from the query layer
(`packages/persistence/src/metrics/queries.ts`) through the CLI to the web view's
`measured()` helper in `apps/web/src/views/evaluation/api.ts`.

## Aggregation guard

The full identity tuple is recorded on every model activity trace
(`packages/persistence/src/trace.ts`). `MetricStore.query`
(`packages/persistence/src/metrics/query.ts`) **refuses** to aggregate across differing
model, harness or protocol identity unless that dimension is an explicit grouping key,
throwing `IncomparableIdentityError` with the message

```text
INCOMPARABLE_IDENTITY_MIX:<dimension>: group by <dimension> or narrow the filter
```

`protocolComparison(a, b)` refuses two different protocol identities outright with
`CrossProtocolComparisonError`, naming both. A number averaged across two protocol versions
is not a comparison; it is a misleading artefact, and the query layer will not produce one.

The guard lives at the query layer, not in a view. `GET /runs/:id/metrics` and
`POST /runs/compare` translate a refusal into HTTP 409 carrying the query layer's own
explanation, and the web view has no arithmetic in it — a test asserts that.

## Per-auditor metrics

`contributionQuery(filter)` returns one row per model identity:

```text
activityCount · successCount · refusalCount · errorCount · cacheHitRate · repairCount
recall · precision · falsePositiveRate
uniqueTrueContribution · marginalTrueContribution
repairFrequency · invalidEvidenceRate · refusalRate
costUsd · latencyMs · independenceGroup
```

The first row group comes from traces and is always available. The scoring columns come
from a ground-truth run and are `null` without one.

Every result carries its denominator — activity count, scored-auditor count, whether ground
truth was available — and the identity dimensions the rows are segmented by, so a comparison
cannot be misread.

## Per-run metrics

`costQuery(filter)`:

```text
consensusPrecision · consensusRecall · costPerTrueAcceptedIssue
verificationResolutionRate · cacheHitRate · escalatedPairs
securityOverlapBudget { budget, used, usage } · suppressionCandidateCount
totalCostUsd · currency
```

Two deliberate nulls: `verificationResolutionRate` is `null` when no verification items
existed rather than `1` or `0`, and `totalCostUsd` is `null` if *any* activity's cost is
unknown, rather than a partial sum presented as a total.

`verificationResolutionRate` is the number that says whether the Verification stage was
worth building. It is reported for that reason.

## Independence, and when it does not apply

`contributionQuery` returns:

```text
independence: { applicable, reason, groups }
```

Fewer than two scored auditors reports
`single_auditor_run_produces_no_independence_data`; no ground truth at all reports
`no_ground_truth_measurement`. A single-auditor `diff-fast` run generates no independence
data, and the UI says so rather than drawing an empty panel. An honest null result is as
legible as a positive one:

```text
3 auditors · 31 source findings · 2 accepted · 26 rejected as unsubstantiated
1 unexamined high-risk surface · 1 suppression candidate
```

That is a valid screen, and the Issue Board renders it above the filters, not behind them.

## The premise test

`packages/testing/src/metrics/premise.ts` — `scorePremiseRun(run, groundTruth)`.

A ground-truth fixture contains **defects and decoys**. Decoys matter: a model that reports
everything scores high recall and terrible precision, and only a decoy set makes that
visible. `PremiseGroundTruthItem` requires a detection criterion and a rationale for each,
so "matched" is a defined event rather than a judgement call.

The report contains:

```text
groundTruth { defects, decoys }
auditors[]  { recall, precision, falsePositiveRate,
              uniqueTrueContribution, marginalTrueContribution, marginalRecallGain,
              repairFrequency, invalidEvidenceRate, refusalRate, cost, latencyMs }
consensus   { acceptedIssueCount, trueAcceptedIssueCount, falseAcceptedIssueCount,
              precision, recall, costPerTrueAcceptedIssue }
result      { additionalAuditorUniqueContribution[], premiseSignal, interpretation }
limitations []
```

`premiseSignal` is `positive` only when an auditor after the first contributed a true
finding no earlier auditor found; `negative` when later auditors contributed only false
positives; `null` otherwise. `interpretation` is the literal
`"smoke_test_only_not_proof"` and cannot be set to anything else by the type.

### Live evaluation is still outstanding

`realPremiseMeasurementEnabled` requires `ARBITRA_PREMISE_REAL_MODELS=1` **and** a provider
key. This helper is an eligibility check, not a live evaluation runner.

The live runner is the P06 driver in `packages/testing/src/premise-evaluation/`. It runs
the public Orchestrator in Audit mode over checkouts that contain no answers, and follows
a prespecified protocol ([docs/qa/p06](qa/p06/PROTOCOL.md)). It keeps a resumable ledger,
scores the runs with `scorePremiseRun`, and imports every observation into the durable
corpus.

The first live results are interim. The run was stopped by quota, and every model was a
Gemini model, so the results say nothing about different model families. See
[docs/qa/p06/README.md](qa/p06/README.md).
The default suites run scripted auditors
(`packages/testing/src/scripted-auditor.ts`) over `packages/testing/src/fake-transport.ts`.

So the shipped premise measurement demonstrates that the **measurement** is deterministic
and correct. It does not demonstrate that multi-model auditing works. Every report says so
in its own `limitations`:

> One small fixture cannot prove or disprove the multi-auditor premise.
> Scripted auditors test deterministic measurement and orchestration, not real-model
> intelligence.
> Tool quality, scope selection, clustering and validation can affect observed recall.

## Corpora

`packages/core/src/eval/corpora.ts` defines the longitudinal store contracts —
`RealWorldOutcomeStore` for whether an accepted issue turned out to matter, and
`IndependenceCorpusStore` for independence observations. The observation types live in
`packages/schemas/src/evaluation-corpus.ts`. `InMemoryRealWorldOutcomeStore` and
`InMemoryIndependenceCorpusStore` remain for tests and ephemeral callers.
`packages/core/src/independence/report.ts` produces the independence report from that data.

### Durable corpus store

`packages/persistence/src/evaluation-corpus/` is the durable backend.
`EvaluationCorpusStore` owns one corpus directory; `DurableRealWorldOutcomeStore` and
`DurableIndependenceCorpusStore` implement the core interfaces over it (structurally,
because persistence sits below core). Besides observations it records:

```text
ground truth    GroundTruthVersion {groundTruthId, version, items[defect|decoy]}
                immutable per version, stored as a content-addressed artifact
run provenance  runId · mode (scripted|real_models) · snapshot {repository, sourceDigest, commit}
                protocol {id, version, hash} · harness {id, version, policyHash}
                models[] {auditorId, modelId, modelProfileVersion, transportId, transportVersion}
                groundTruth {groundTruthId, version} | null
adjudication    versioned ruling on one observation: judgment, adjudicator, rationale,
                adjudicatedAt, optional ground-truth item citation
```

The rules:

- **Idempotent import.** `import(bundle)` applies ground truth, runs, observations and
  adjudications as one atomic batch. A record whose identity already exists with identical
  content is counted `unchanged` and not rewritten; re-importing the same bundle writes
  nothing.
- **Conflicting identity fails.** The same run id with different provenance, a changed
  ground-truth version, a changed observation, an auditor that is not in the run's model
  identity, or an adjudication citing ground truth other than the run's raises
  `CorpusIdentityConflictError` (`CORPUS_IDENTITY_CONFLICT:<kind>:<key>`). The whole batch
  is rejected before anything is written. An observation needs registered provenance
  (`CORPUS_RUN_PROVENANCE_MISSING`).
- **Judgments are append-only.** The imported observation is judgment version 0.
  Adjudication `n` must follow `n-1` (`CORPUS_ADJUDICATION_VERSION_GAP` otherwise);
  resubmitting a recorded version with different content is a conflict, not an overwrite.
  `query()` returns the latest judgment; `history()` returns every version.
- **Unknown stays null.** `costUsd` and `latencyMs` are a non-negative number or `null`.
  Inputs are strictly shaped: unknown fields, such as an endpoint or key, are rejected.

`summarizeOutcomes` and `summarizeIndependence` carry a denominator (`runCount`,
`observationCount`, `runsWithGroundTruth`, `adjudicatedCount`, and requested
`unmatchedRunIds`), and every row keeps its own counts. Cost totals are `null` if any cost is
unknown and report `knownCount`/`unknownCount`; latency means cover known values only.
They refuse to mix model, harness, protocol, ground-truth version or execution mode
unless that dimension is in `groupBy`, raising `IncomparableCorpusAggregationError` with
the same `INCOMPARABLE_IDENTITY_MIX:<dimension>` message as the trace metrics.

### Reports

`exportReport(query, redactor)` builds a report as of the latest committed data batch. It
includes the query, summary, run provenance, ground-truth digests, each observation's imported
value, the judgment version used, and a digest of the journal prefix it was computed from.
Every string passes through the injected `CorpusRedactor` (the composition layer supplies
`redactSecrets` from `packages/security`, which persistence cannot import), and the report is
refused if a second redaction pass still finds anything. It is saved as a content-addressed
`corpus-report` artifact and journalled; exporting unchanged data again returns the same
artifact.

`reconstructReport(ref, redactor)` rebuilds the report from the journal prefix and
ground-truth artifacts, then requires byte equality with the saved artifact. If the history
changed, the rebuilt report differs, the redactor version differs or the artifact holds an
unredacted secret, it fails with `CorpusReportMismatchError`. Adjudications recorded after the
export do not alter the rebuilt report; they are returned as `supersededJudgments`
(`reportedVersion` → `currentVersion`), so a changed historical judgment is always explicit.

Nothing in the CLI, server or runtime constructed the in-memory corpora, so there is no
composition wiring to replace yet; a production evaluation driver that feeds these stores is
[P06](completion-plan.md#p06--measure-the-real-model-premise). The existing real-handoff
script uses scripted Audit responses to construct its plan before invoking an external
coding agent; it does not establish live multi-model Audit quality. Completion requires
saved real-run evidence and reproducible scoring, and does not require a positive result.

## Replay

`packages/core/src/replay/index.ts` re-runs a completed run from its persisted round-zero
findings under different policy overrides — consensus policy, maximum rounds, critic
enabled — without re-paying for discovery. `ReplayOverrides`, `ComparableRun` and
`ComparableIssue` make two runs comparable *only* where their identity permits it, and the
CLI exposes it as `replay` and `diff`.

This is what turns "would risk-weighted consensus have changed the answer?" from an opinion
into a measurement.

## Reporting

`apps/cli/src/commands/report.ts` renders the evaluation surface for a run and redacts its
output through `redactSecrets` (`packages/security/src/redaction.ts`), failing closed with
`report_redaction_failed` rather than printing anything a redaction pass could not clean.

## Not implemented

- **Benchmark UI, public leaderboards and learned routing** are out of scope entirely, not
  deferred.
- **Local embedding clustering** is v1.1, and conditional: the deterministic path in
  `packages/workflow/src/clustering/deterministic.ts` stands unless escalation metrics
  justify replacing it. Those metrics are recorded now
  (`clustering/escalate.ts`), which is the point. The P18 evaluation of a pinned local
  embedding model against a prespecified protocol rejected adoption on the authored
  corpus (weighted clustering error rose from 36 to 49); see
  [qa/p18](qa/p18/README.md). It is to be rerun on real-model findings.

## Runtime operational metrics

The localhost evaluation API now reads authoritative model trace journals directly,
without waiting for a SQLite rebuild. Rows remain separated by model, harness, and
exact protocol identity. Activity counts count recorded attempts; latency is the mean
recorded attempt duration. Token and cost totals stay null if any contributing value
is unknown. Cache rates use known cache-read/input-token totals. Verification resolution
includes deferred items in its denominator.

These operational measurements do not establish ground truth: precision, recall,
contribution, and measured independence remain unavailable without an evaluation corpus.
Protocol comparisons accept exact identities and optional runIds, refuse different
protocol identities, and report missing matching activity explicitly. The trace browser
is implemented through the runtime, HTTP routes and web Traces view; it exposes attempt
identity, usage, failures and immutable redacted artifacts. Browser acceptance QA and
indexing very large histories remain in the [completion plan](completion-plan.md).
