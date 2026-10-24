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
measurement are different claims, and the distinction is preserved from
`packages/runtime/src/evaluation-metrics.ts` through `GET /runs/:id/metrics` to the web view's
`measured()` helper in `apps/web/src/views/evaluation/api.ts`.

## Aggregation guard

The full identity tuple is recorded on every model activity trace
(`packages/persistence/src/trace.ts`). `queryActivityTraces`
(`packages/persistence/src/metrics/query.ts`) **refuses** to aggregate across differing
model, harness or protocol identity unless that dimension is an explicit grouping key,
throwing `IncomparableIdentityError` with the message

```text
INCOMPARABLE_IDENTITY_MIX:<dimension>: group by <dimension> or narrow the filter
```

`POST /runs/compare` takes an exact protocol identity and optional run IDs for each side, and
refuses two different protocol identities outright with `CrossProtocolComparisonError`
(`packages/runtime/src/control-plane-core.ts`), naming both. A number averaged across two
protocol versions is not a comparison; it is a misleading artefact. A side with no recorded
activity for its exact protocol identity is reported as `NO_MATCHING_PROVIDER_ACTIVITY`.

`GET /runs/:id/metrics` and `POST /runs/compare` translate a refusal into HTTP 409 carrying the
refusal's own explanation. The web view imports no persistence code and derives no metric — a
test asserts that.

## What a run's metrics contain

`evaluationMetrics` (`packages/runtime/src/evaluation-metrics.ts`) computes the Evaluation tab
(`apps/web/src/views/evaluation/`) from the run's trace journal and artifacts. It reads the
journal directly, so it never waits for an index rebuild. The plain-text run report
(`packages/runtime/src/run-report.ts`, served at `GET /diagnostics/runs/:runId`) prints the same
confirmed-issue and plan results.

### Checked against the source

`confirmedYield` (`packages/runtime/src/confirmed-yield.ts`) leads the tab:

```text
candidates · confirmed (by severity) · rejected · unsettled · acceptedUnchecked · notChecked
tokens · tokensPerConfirmed
auditors[] { auditorId, modelId, findings, confirmed, confirmedAlone, discoveryTokens }
```

An issue is confirmed when targeted verification answered `CONFIRMED` from the source and the
issue was accepted, or, in a one-auditor run, verified as single-source. That is not ground
truth; no answer key checked it, and the tab says so. An issue accepted without a check is
counted apart, never as confirmed; `unsettled` counts issues the source could not settle.
`tokens` sums the input and output tokens the run's traces recorded, and `tokensPerConfirmed`
divides it by the confirmed count. Per auditor, `findings` and `confirmed` count its discovery
findings only, and `confirmedAlone` counts the confirmed issues no other auditor reported in
discovery: what an auditor adds in peer review was written after reading the others' findings,
so it cannot count as found alone.

### Plan carried out

`planResults` (`packages/runtime/src/plan-results.ts`) reads `results.json` from the newest
saved plan for the run under `.arbitra/plans/` (written by `POST /handoff/runs/:runId`). The
coding agent that carries out the plan fills in each issue's `result` (`fixed`,
`not_reproducible`, `no_change_needed` or `blocked`) and `failedBefore`: whether a test failed on
the unchanged code for the issue's reason. The metrics report how many issues were reported, the
count of each result, how many a failing test proved (`provenByFailingTest`) and how many no test
could show (`notProvenByTest`). The file is written by an agent, so every field is checked and
anything else is ignored. `planResults` is `null` when no plan was saved or none parses.

### Operational rows and run totals

One row per model, harness and protocol identity: activity, success, refusal and error counts,
repair count, refusal rate, cost, mean recorded attempt latency, cache hit rate (cache-read over
input tokens, `null` unless both are known), and the harness `measurementClass`, which marks
native-harness rows. Activity counts count recorded attempts. The scoring columns — recall,
precision, false-positive rate, unique and marginal true contribution, repair frequency,
invalid-evidence rate and independence group — need ground truth and are `null` in a run; the
tab shows them as unavailable. The denominator (activity count, scored auditors, whether ground
truth was available) and the segmentation are shown above the rows, so a comparison cannot be
misread.

The run totals:

```text
totalCostUsd · currency · inputTokens · outputTokens · cacheReadTokens · cacheWriteTokens
cacheHitRate · verificationResolutionRate · escalatedPairs · suppressionCandidateCount
consensusPrecision · consensusRecall · costPerTrueAcceptedIssue · securityOverlapBudget
```

A cost or token total is `null` if *any* contributing value is unknown, rather than a partial
sum presented as a total. `inputTokens` counts whole prompts; the part read from a prompt cache
and the part written to one are reported apart, because every vendor prices a cached token at a
tenth of an input token or less. A token budget compared across runs should weigh them.

`verificationResolutionRate` is resolved disputes over verification items, deferred items
included, and `null` when there were none rather than `1` or `0`. It is the number that says
whether the Verification stage was worth building, and it is reported for that reason.
`suppressionCandidateCount` counts the canonical issues' suppression candidates, which the
shipped pipelines leave empty: the deterministic computation in
`packages/security/src/suppression.ts` is not wired into a run. The last four totals need ground
truth or an overlap allocation that a run does not record, and are always `null`.

## Independence, and when it does not apply

The metrics carry:

```text
independence: { applicable, reason, groups }
```

Measured independence needs ground truth, which a product run does not have. A run reports
`applicable: false` with `no_ground_truth_measurement`, or `no_recorded_provider_activity` when
no model ran, and the tab says so rather than drawing an empty panel. Independence is measured
against a corpus with ground truth ([Corpora](#corpora)). An honest null result is as legible as
a positive one:

```text
3 auditors · 31 source findings · 2 accepted · 26 rejected
unexamined surfaces · 1
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

`premiseSignal` is `"positive"` when an auditor after the first found a true defect no
other auditor found; `"negative"` when none did and a later auditor reported a false
positive; the string `"null"` otherwise. `interpretation` is the literal
`"smoke_test_only_not_proof"` and cannot be set to anything else by the type.

### Live evaluation

`realPremiseMeasurementEnabled` requires `ARBITRA_PREMISE_REAL_MODELS=1` **and** a provider
key. This helper is an eligibility check, not a live evaluation runner.

The live runner is the P06 driver in `packages/testing/src/premise-evaluation/`. It runs
the public Orchestrator in Audit mode over checkouts that contain no answers, and follows
a prespecified protocol ([docs/qa/p06](qa/p06/PROTOCOL.md)). It keeps a resumable ledger,
scores the runs with `scorePremiseRun`, and imports every observation into the durable
corpus.

The results are in [docs/qa/p06-subscription](qa/p06-subscription/README.md). Protocol 2.1.0
ran three model families (Claude, GPT and Gemini) through the subscription CLIs and completed
all 15 runs on September 28, 2026; every prespecified comparison was insufficient evidence.
Earlier runs are kept and never pooled with it: protocol 2.0.0 closed at run 2 on its per-run
token cap, and version 1 ([docs/qa/p06](qa/p06/README.md)) used only Gemini models and was
stopped by quota.

The default suites score scripted auditors (`packages/testing/src/scripted-auditor.ts`).
So the shipped premise measurement demonstrates that the **measurement** is deterministic
and correct. It does not demonstrate that multi-model auditing works. Every scripted report
says so in its own `limitations`:

> One small fixture cannot prove or disprove the multi-auditor premise.
> Scripted auditors test deterministic measurement and orchestration, not real-model
> intelligence.
> Tool quality, scope selection, clustering and validation can affect observed recall.

## Corpora

Two longitudinal corpora hold real-world outcomes (whether an accepted issue turned out to
matter) and independence observations; their types live in
`packages/schemas/src/evaluation-corpus.ts`.

### Durable corpus store

`packages/persistence/src/evaluation-corpus/` stores them. `EvaluationCorpusStore` owns one
corpus directory; `DurableRealWorldOutcomeStore` and `DurableIndependenceCorpusStore` append to
and query its two observation corpora. Besides observations it records:

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

The CLI, server and runtime do not open a corpus; the
[P06](completion-plan.md#p06--measure-the-real-model-premise) driver
(`packages/testing/src/premise-evaluation/`) feeds the durable store. The real-handoff script
(`packages/testing/scripts/run-real-handoff.ts`) uses scripted Audit responses to construct its
plan before invoking an external coding agent; it does not establish live multi-model Audit
quality.

## Replay

`packages/core/src/replay/index.ts` re-runs a completed run from its persisted round-zero
findings under different policy overrides — consensus policy, maximum rounds, critic
enabled — without re-paying for discovery. `ReplayOverrides`, `ComparableRun` and
`ComparableIssue` make two runs comparable *only* where their identity permits it, and the
CLI exposes it as `replay` and `diff`.

This is what turns "would risk-weighted consensus have changed the answer?" from an opinion
into a measurement.

## Reporting

`apps/cli/src/commands/report.ts` prints a run's summary with its gate — for an Audit, the issue
counts, coverage and recorded limitations — and redacts its output through `redactSecrets`
(`packages/security/src/redaction.ts`), failing closed with `report_redaction_failed` rather
than printing anything a redaction pass could not clean. The metrics above are served over HTTP
and in the plain-text run report, not by this command.

## Not implemented

- **Benchmark UI, public leaderboards and learned routing** are out of scope entirely, not
  deferred.
- **Local embedding clustering** is v1.1, and conditional: the deterministic path in
  `packages/workflow/src/clustering/deterministic.ts` stands unless escalation metrics
  justify replacing it. Those metrics are recorded now
  (`clustering/escalate.ts`), which is the point. The P18 evaluation of a pinned local
  embedding model against a prespecified protocol rejected adoption on the authored
  corpus (weighted clustering error rose from 36 to 49). On P06's real-model findings it
  cut the error by only 7% (25% required), on a corpus below the evidence minimum, so the
  deterministic path stays; see [qa/p18](qa/p18/README.md).
