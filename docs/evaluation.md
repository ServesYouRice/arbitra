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

### It has not been run against real models

`realPremiseMeasurementEnabled` requires `ARBITRA_PREMISE_REAL_MODELS=1` **and** a provider
key. Neither is set in the default suites, which run scripted auditors
(`packages/testing/src/scripted-auditor.ts`) over `packages/testing/src/fake-transport.ts`.

So the shipped premise measurement demonstrates that the **measurement** is deterministic
and correct. It does not demonstrate that multi-model auditing works. Every report says so
in its own `limitations`:

> One small fixture cannot prove or disprove the multi-auditor premise.
> Scripted auditors test deterministic measurement and orchestration, not real-model
> intelligence.
> Tool quality, scope selection, clustering and validation can affect observed recall.

## Corpora

`packages/core/src/eval/corpora.ts` holds the longitudinal stores —
`RealWorldOutcomeStore` for whether an accepted issue turned out to matter, and
`IndependenceCorpusStore` for independence observations. The shipped implementations are
in-memory (`InMemoryRealWorldOutcomeStore`, `InMemoryIndependenceCorpusStore`): the
interfaces and the recorded data are real, the durable backend is not built.
`packages/core/src/independence/report.ts` produces the independence report from that data.

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
  (`clustering/escalate.ts`), which is the point.
