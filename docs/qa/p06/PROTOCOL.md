# P06 premise evaluation: prespecified protocol

Protocol `arbitra-p06-premise@1.0.0`. It was written and committed before any evaluation
run. The machine-readable version is [protocol.json](protocol.json). The driver runs exactly that
file (`packages/testing/src/premise-evaluation/`), and it refuses a ledger or saved record from
any other protocol identity. Results go in [README.md](README.md). Any later change to the
protocol, rubric or decision rule needs a new protocol version, and results from different
versions are never pooled.

| Input | sha256 |
|---|---|
| `docs/qa/p06/protocol.json` | `5e7a323a22913d9f17d1d8cbbd179e3a8302e5fafd1f8a356b8ac86771652d48` |
| `docs/qa/p06/configs/audit-mixed-providers.json` | `b9a032947447356d6277db8a665edb81d640bf51c312216624287fc995562a34` |
| `docs/qa/p06/bindings.json` | `faf79d0bca10d1edb6f1b6c1ab584550ee609d08309ab94cfe2b3589e161fb0e` |
| `docs/qa/p06/ground-truth/live-fixture-v1.json` | `3464c1df7a792acffe95017f7b86311ef469e280626d10c32415effb9d4d83a6` |
| `packages/testing/corpora/premise/ground-truth.json` | `fbc179b1a5bc3dc945c067b98dc244a75b71d17522e697b2ef3751bb8d29576c` |
| `packages/testing/corpora/expanded/ground-truth.json` | `a12c1fe9fdf9439cc0c1cc89bba0c48531cd88c2025cebc9f36abeacfee81226` |

## Question

For an Audit, is it worth adding auditors? In particular, do heterogeneous auditors find
defects that repeated isolated runs of one strong model miss, and does the full
reconciliation and verification pipeline improve on a single-auditor pipeline? A negative
or null answer counts as a valid result.

**Scope limit, stated in advance.** Only a free-tier Gemini key is usable, so every auditor
belongs to one family: `gemini-3.1-flash-lite` on the native endpoint and on the
OpenAI-compatible endpoint, plus `gemini-3.5-flash-lite` on the native endpoint. Condition C
therefore compares model **variants and endpoints within one family**. It is not a comparison
of model families. This evaluation cannot confirm or refute the premise that different model
families are complementary, and no result below should be read that way.

## Models and configuration

The configuration comes from `tooling/live/configure.mjs` with [bindings.json](bindings.json),
applied to `examples/model-backed/audit-mixed-providers.json` (preset `audit-deep`,
`auditDepth: deep`, `consensusPolicy: full`, `maxConsensusRounds: 2`,
`verification.maxModelQuestionsPerRound: 2`, canonical harness).

| Profile | Model | Transport / endpoint | Independence group |
|---|---|---|---|
| auditor-a | gemini-3.1-flash-lite | gemini-native | `gemini-3.1-flash-lite` |
| auditor-b | gemini-3.5-flash-lite | gemini-native | `gemini-3.5-flash-lite` |
| auditor-c | gemini-3.1-flash-lite | openai-chat (Gemini OpenAI-compatible endpoint) | `gemini-3.1-flash-lite` |

Roles: planner auditor-a, verifier auditor-b, critic auditor-c. auditor-a and auditor-c run
the same model, so they share one independence group. A second endpoint is not a second
source of independence. The runtime therefore sees two independence groups among the three
auditors.

The single-auditor configuration is derived in code (`singleAuditorConfiguration`) from the
same file. It keeps only auditor-a, with the same profile, endpoint, depth, verification
settings and execution limits. It uses the shipped single-auditor preset `diff-fast`, and
auditor-a fills both the planner and verifier roles, so no second model takes part.

Execution limits for every run:

- `maximumRetries` 5 and `maximumOutputRepairs` 2
- `maximumOutputTokens` 8000 and `timeoutMs` 180000
- rate limit 6 rpm per provider with `maxConcurrent` 1
- per-run `maximumTokens` 3,000,000

The run cap is a reservation ceiling, not expected use. The pilot (below) showed that each
failed 503 attempt is charged at its admission estimate of about 59k tokens, so six retries
alone used 350k of an earlier 600k cap.

## Fixtures

Three repositories, each with ground truth and decoys:

| Fixture | Source (copied) | Defects | Decoys | Excluded from checkout |
|---|---|---|---|---|
| `premise-v1` | `packages/testing/corpora/premise/repo` | 5 (authorization, N+1, race, migration, payment idempotency) | 3 | none |
| `expanded-evaluation-v1` | `packages/testing/corpora/expanded/repo` | 2 (path escape, hard-coded admin bypass) | 2 | none |
| `live-fixture-v1` | `tooling/live/fixture-repo` | 3 (unbounded discount, quantity parsing, session expiry boundary) | 1 | `README.md`, which names the grading file |

The total is 10 defects and 6 decoys. `live-fixture-v1` ground truth
(`ground-truth/live-fixture-v1.json`) is the P03 fixture's `fixture-ground-truth.json`
restated in the premise-scorer format. Its items and meanings are unchanged.

**Keeping answers out of model context.** Each run audits a fresh checkout that contains only
the fixture's source files, committed with a fixed identity and date so every repetition
audits the same commit. The ground truth, rubric, protocol and configuration stay outside the
checkout. Before every start and resume, the driver fails with `P06_GROUND_TRUTH_LEAK` if any
checkout file is named like ground truth or rubric, or contains a ground-truth item id,
detection criterion or rationale. The run state directory sits beside the checkout, not
inside it.

**Ground-truth review.** Before this protocol, the ground truth was re-reviewed against the
source in a separate session from the one that authored it. That review is not independent
human review; it is a second reading by the evaluating agent. Every defect was confirmed:

- the support header returns `true` before the role check
- one profile query per user
- non-atomic read-check-write
- a `NOT NULL` column without a default or backfill
- a capture retried without an idempotency key
- `resolve` without a containment check
- a hard-coded header value grants admin
- `percent` is not bounded to 0-100
- `parseInt` without validation
- `>` where the documented contract needs `>=`

Every decoy was confirmed as correct code:

- `timingSafeEqual` after a length check
- a parameterized query
- publication under a stable unique id
- containment checked against the owned root
- a role read from session state
- a tested `subtotal`

Real issues that exist but are not listed, such as the unbounded `SELECT id FROM users` or
`SELECT *`, are expected. The unlisted-findings review below handles them.

## Conditions

| Id | Condition | Source of the reported set |
|---|---|---|
| A | Strong single-model baseline: one auditor, one run | auditor-a's grounded discovery findings (`findings-auditor-a`) in one `single` run |
| A_pipeline | What the single-auditor pipeline presents | canonical issues with disposition `accepted` or `single_source` whose verification is not `REJECTED` |
| B | Repeated isolated runs of that same model | union of A over the fixture's `single` repetitions. Auditors are the repetitions, with one model identity and one independence group. Repeated calls are not counted as model families. |
| C | Heterogeneous auditors (same family, see scope limit) | union of the three auditors' grounded discovery findings in one `heterogeneous` run |
| D | Full reconciliation/verification pipeline | canonical issues with disposition `accepted` in that run (what the planner receives) |
| D_not_rejected | Secondary view of D | canonical issues neither `rejected` nor verification-`REJECTED` |

B and C each use three discovery passes, so they compare equal numbers of passes. A counts
every `single` repetition as one instance.

## Schedule, repetitions and budgets

The runs follow `protocol.json` `schedule`, in order:

1. Round 1, per fixture: `single` r1, then `heterogeneous` r1.
2. `single` r2 for each fixture.
3. `single` r3 for each fixture.
4. `heterogeneous` r2 for each fixture.

That is 15 runs: 9 single and 6 heterogeneous. Because of this order, a quota-truncated
evaluation still has a balanced first round.

The global budget covers all runs, as recorded in their durable traces:

- at most 260 provider attempts, counting every retry and repair
- at most 2,500,000 known tokens (input plus output)
- at most 4 hours of summed run wall-clock time

No run starts once a limit is reached. A run that ends without `COMPLETED` (for example after
repeated 503 "high demand" responses) is left in the ledger. The next driver invocation, a
fresh process, resumes it with `Orchestrator.resume` and never restarts it. The driver stops
at the first incomplete run so it does not spend quota against an outage.

The ledger also records runs that never finish, and they are reported as missing, never
imputed. The free-tier quota is shared with the concurrent P03 live acceptance.

**Pilot, excluded from all analysis.** Before this protocol was written, two runs on a copy of
`live-fixture-v1` calibrated budgets and exposed failure modes:

- One `single` run: 6 attempts, completed.
- One `heterogeneous` run: 9 attempts. It failed on six consecutive 503 responses during peer
  review. On resume it was suspended because the budget had been charged at admission
  estimates, which is why the per-run cap above was raised.

Those runs are not part of any result.

## Scoring criteria

**Matching rule.** The rule is deterministic and fixed in `protocol.json`, under each fixture's
`rubric`:

- A finding **matches a defect** when both of the following hold:
  - one of its locations overlaps the defect's rubric span (checkout path and line range);
  - its title, problem or recommended fix matches the defect's case-insensitive keyword
    pattern, which states the defect's mechanism.

  Evidence quotes are code and are not keyword-matched.
- A finding **hits a decoy** when a location overlaps the decoy's span and it matches no
  defect.
- Any other finding is **unlisted**. For the primary metrics, an unlisted finding counts as a
  false positive.
- A canonical issue carries the union of its source findings' matches.
- The Audit protocol requires `PROMPT_INJECTION` reports for instruction-shaped repository
  text, and two fixtures contain such text on purpose. A finding in that category that
  matches no defect is excluded from both numerator and denominator, and is counted
  separately.

**Unlisted-findings review.** This review is secondary and does not change any primary number.
Every unlisted finding is read against the source after the runs. Each one is classified as
either "plausible real issue not in ground truth" or "incorrect or noise", and a
sensitivity precision is reported.

**Metrics.** Every proportion is reported with its numerator, denominator and a 95% Wilson
interval.

- **Recall:** detected defects divided by defects, per instance, pooled over instances.
- **Precision:** true reports divided by scored reports.
- **False positives:** decoy hits, unlisted reports, and decoys hit divided by decoys.
- **Contribution** (`scorePremiseRun`, per auditor position): unique true contribution and
  marginal true contribution.
- **Evidence:** discovery findings rejected by the runtime's location or evidence validation
  or by the quote check, divided by findings emitted, plus the count of true defects lost to
  that rejection.
- **Severity:** true reports whose severity meets the rubric's `minimumSeverity`. These
  minimums are the evaluator's judgement, recorded in advance.
- **Verification accuracy:** targeted-verification outcomes against ground truth. `CONFIRMED`
  on a true defect and `REJECTED` on a decoy or unlisted issue count as correct.
  `STILL_NEEDS_VERIFICATION` counts as inconclusive, outside the denominator.
- **Plan correctness:**
  - the share of issues the plan's tasks address that are true defects;
  - the share of true accepted issues the plan addresses.
- **Cost and latency:** provider attempts, known input and output tokens, attempts with
  unknown usage (never counted as zero), summed attempt duration and run wall-clock time. USD
  cost is unknown on the free tier and reported as unavailable.

**Uncertainty for comparisons.** Comparisons use a paired percentile bootstrap: 10,000
iterations, seed 20260925, 95% interval. The resampled units are the ground-truth defects of
fixtures both conditions observed. A unit's value is the share of that condition's instances
that detected the defect. Each comparison also reports the precision difference and the
ratio of known tokens.

Units within a fixture share code and runs, so the intervals are optimistic. With 10 defects,
only large effects can be distinguished from noise.

## Decision rule

The rule is applied to three comparisons:

- C − B: heterogeneous auditors versus repeated runs of the same model
- B − A: repeated runs versus one run
- D − A_pipeline: full pipeline versus single-auditor pipeline

Each comparison gets one verdict:

1. **insufficient_evidence** when fewer than 10 paired ground-truth defects are available.
2. **worthwhile** when the recall-difference interval lies entirely above 0 and the precision
   difference is at least −0.10.
3. **not_worthwhile** when either of these holds:
   - the interval lies entirely below 0;
   - the interval lies within [−0.05, 0.05] and the left condition uses at least 1.5× the
     known tokens.
4. **insufficient_evidence** in every other case.

The README states the resulting decision about when extra auditors are worthwhile. It
repeats the scope limit: the multi-family premise itself remains untested.

## Persistence

Saved per completed run: `evidence/runs/<fixture>__<condition>__r<n>.json`. This file holds
the discovery findings, validation rejections, canonical issues, verification results, plan
and critic summaries, per-node usage, and identity (snapshot digest, git head, protocol,
harness, and per-auditor model and transport identity taken from the run's own traces).

`analyse` imports the evidence into the P05 durable corpus at `evidence/corpus`:

- **Ground truth:** each fixture's ground truth as an immutable version.
- **Run provenance:** one record per run.
- **Canonical-issue observations:** for every canonical issue, a real-world-outcome
  observation, plus an independence observation for multi-auditor runs. Each records the
  pipeline's own decision as judgment version 0 and the rubric's ground-truth ruling as
  adjudication version 1.
- **Repetition set:** one independence set per fixture for the repeated single-model runs,
  with one model identity.

It then exports and reconstructs the redacted corpus reports and writes `evidence/results.json`.
The ledger and run state stay under `.runs/p06`, which is not committed.
