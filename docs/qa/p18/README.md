# P18 — local embedding clustering: result and decision

**Decision: do not adopt. Keep the existing clustering** (`structural-v1` plus bounded
semantic escalation). No adapter and no runtime dependency are added.

The protocol ([PROTOCOL.md](PROTOCOL.md), `p18-protocol-v1`) was applied, unchanged, to two corpora:

| Corpus | Findings | Outcome | Deciding rule |
| --- | --- | --- | --- |
| `clustering-p06-real-v1`: P06 real-model findings (September 28, 2026) | 149 in 21 runs | INSUFFICIENT EVIDENCE: retain existing clustering | criterion 1 fails (94 of 100 same-label pairs); `E1` cut `W` by 7%, against the 25% required |
| `clustering-authored-v1`: hand-authored findings (September 25, 2026) | 58 in 4 runs | REJECT | `W(E1) ≥ W(D)`: 49 against 36 |

Neither corpus shows a defensible benefit from the embedding candidate `E1`. The real-model
rerun also found a structural weakness in `D` that no escalation candidate can reach; see
[What the real findings show](#what-the-real-findings-show).

## Rerun on P06 real-model findings (September 28, 2026)

| Item | Value |
| --- | --- |
| Recorded run | commit `598c939` (clean tree), 2026-09-28T21:17:56Z; raw output [results/clustering-p06-real-v1.json](results/clustering-p06-real-v1.json) |
| Corpus | `clustering-p06-real-v1` v1, sha256 `46e6bd0f…f2e1`, mode `real_models`: 21 runs, 149 findings, 84 ground-truth clusters (36 with ≥ 2 members), 94 same-label and 658 different-label pairs. Built by [`p06-corpus.mjs`](../../../tooling/embedding-eval/p06-corpus.mjs) from every P06 run record with recorded discovery, and committed before the comparison ran |
| Labels | the P06 rubric for defects and decoys (118 findings); `NOISE:injection-<file>` for prompt-injection reports (28); three findings labelled by hand (`NOISE:test-coverage-gap` twice, `NOISE:negative-quantity`) |
| Fixtures | `premise-v1`, `expanded-evaluation-v1`, `live-fixture-v1` |
| Model and settings | as for the authored corpus below; the pinned artifact was verified again before use |
| Host | Apple M4, 10 cores, 16 GiB; load average 4.5 to 6.2 during the run |

### Clustering errors (pooled, held-out thresholds)

| Config | FM | FS | W = 2·FM + FS | ΔW [95% CI] | Pair precision | Pair recall | Candidates | Contaminated | Redundant |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| `D` deterministic | 40 | 8 | 88 | — | 0.683 | 0.915 | 79 | 9 | 4 |
| **`E1` embedding escalation (candidate)** | 40 | 2 | **82** | **−6 [−14, 0]** | 0.697 | 0.979 | 76 | 9 | 1 |
| `E2` embedding only | 0 | 5 | 5 | −83 [−129, −41] | 1.000 | 0.947 | 87 | 0 | 3 |
| `S*` oracle escalation (upper bound) | 40 | 0 | 80 | −8 [−16, −2] | 0.701 | 1.000 | 75 | 9 | 0 |

No configuration made a defect-loss merge. The held-out thresholds were τ = 0.65 for
`premise-v1` and `expanded-evaluation-v1` and 0.75 for `live-fixture-v1` (`E2`: 0.60, 0.60
and 0.65).

| # | Criterion | Result | Measured |
| --- | --- | --- | --- |
| 1 | Evidence sufficiency | **fail** | mode `real_models`; fixtures 3 of 2; multi-member clusters 36 of 30; same-label pairs **94 of 100**; ambiguous pairs 39 of 30 |
| 2 | Benefit (≥ 25% and CI < 0) | **fail** | W 88 → 82 (6.8% reduction); ΔW −6 [−14, 0] |
| 3 | No defect loss | pass | 0 vs 0 |
| 4 | Downstream | pass | contaminated 9 vs 9; 3 redundant removed |
| 5 | Latency | pass | warm p95 333 ms (limit 750); cold load 0.21 s |
| 6 | Resources | pass | model 90.4 MB; peak RSS growth 572 MB (limit 700); dependencies 482 MB (limit 500) |
| 7 | Cost and locality | pass | $0; 0 network requests |
| 8 | Reproducibility | pass | 5 repeats, identical assignments |

Criteria 5–8 pass and `W(E1) < W(D)`, so no REJECT rule triggers. Criterion 1 fails, so the
outcome is INSUFFICIENT EVIDENCE, and the existing clustering is retained.

### What the real findings show

- **`D`'s false merges come from one structural pattern.** In 8 of the 9 `premise-v1` runs,
  `structural-v1` put the prompt-injection report about the planted comment on `src/auth.ts`
  line 2 into the same candidate as the `DEF-AUTH-BYPASS` findings. Those findings cite spans
  such as lines 1–5, which include the comment's line. Once more, it merged the
  negative-quantity report with `DEF-RACE` on the same `src/inventory.ts` span. These 9
  contaminated candidates hold all 40 false-merge pairs. No escalation resolver can undo a
  structural merge, so `E1` and even the oracle `S*` keep FM 40.
- **`E1`'s small gain came from splits.** It resolved 6 of `D`'s 8 false splits without a new
  false merge; the oracle would have resolved all 8.
- **`E2` nearly solved this corpus:** no false merges and 5 false splits, because an injection
  report reads nothing like the bypass beside it. Under the protocol, `E2` explains the
  decision and cannot change it. Evaluating it as a candidate, or making `structural-v1`
  category-aware, needs a new protocol version and a larger corpus.
- **The corpus is still small.** Most multi-member clusters are two or three reports of one
  planted defect in one run, so same-label pairs stopped at 94.

The structural false merge was a product finding for the final review: a prompt-injection report
could share a candidate with the real defect it sits beside.

**Fixed after P18 (September 29, 2026).** Clustering is now `structural-v2`: a `PROMPT_INJECTION`
report clusters only with other such reports. P18's numbers above measured `structural-v1` at
commit `598c939`. Replayed on the same corpus (descriptive and in-sample, not a P18 result), the
fix takes `D` from FM 40 and W 88 to FM 3 and W 14, with one contaminated candidate left (the
same-category negative-quantity report merged with `DEF-RACE`); the authored corpus is
unchanged. The P18 harness calls the current default strategy, so a rerun now measures
`structural-v2`: a new comparison needs `p18-protocol-v2` and `--out`, so this record is not
overwritten.

## Authored corpus (September 25, 2026)

The sections below record the first evaluation, on the hand-authored corpus.

## Provenance

| Item | Value |
| --- | --- |
| Protocol | `p18-protocol-v1`, committed in `a19c08b` before any comparison ran |
| Harness | `packages/workflow/src/clustering/evaluation.ts`; runner `tooling/embedding-eval/run.ts` |
| Recorded run | commit `2b6db75` (clean tree), 2026-09-25T16:42:40Z; raw output [results/clustering-authored-v1.json](results/clustering-authored-v1.json) |
| Corpus | `clustering-authored-v1` v1, sha256 `f4dfaddc…a9c6`, mode `authored`: 4 runs, 58 findings, 29 ground-truth clusters (15 with ≥ 2 members), 47 same-label and 393 different-label pairs |
| Fixtures | `premise-v1` (ground truth sha256 `fbc179b1…576c`), `expanded-evaluation-v1` (`a12c1fe9…1226`) |
| Model | `Xenova/all-MiniLM-L6-v2` @ `751bff37182d3f1213fa05d7196b954e230abad9`, `onnx/model.onnx` fp32, sha256 `759c3cd2…c46e` (verified before use) |
| Runtime | `@huggingface/transformers@4.3.0`, `onnxruntime-node@1.30.0`, Node 22.23.2, darwin-arm64 CPU |
| Settings | text `finding-text-v1`; τ grid 0.30–0.95 by 0.05, leave-one-fixture-out; escalation bound 20 pairs; bootstrap 10,000 resamples, seed 18; 5 latency repeats |
| Host | Apple M4, 10 cores, 16 GiB; heavily shared (1-minute load average 10 during the recorded run) |

## Clustering errors (pooled, held-out thresholds)

The pair denominators are 47 same-label pairs (the base for FS) and 393 different-label
pairs (the base for FM). ΔW is measured against `D`, with a 95% paired cluster-bootstrap
interval over the 29 ground-truth clusters.

| Config | FM | FS | W = 2·FM + FS | ΔW [95% CI] | Pair precision | Pair recall | Defect-loss merges |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| `D` deterministic | 11 | 14 | 36 | — | 0.750 | 0.702 | 0 |
| **`E1` embedding escalation (candidate)** | 21 | 7 | **49** | **+13 [−9, +42]** | 0.656 | 0.851 | 0 |
| `E2` embedding only | 3 | 30 | 36 | 0 [−17, +20] | 0.850 | 0.362 | 0 |
| `S*` oracle escalation (upper bound) | 13 | 0 | 26 | −10 [−21, −1] | 0.783 | 1.000 | 0 |

The held-out thresholds were τ = 0.65 for `premise-v1` and 0.55 for
`expanded-evaluation-v1` (`E2`: 0.60 and 0.70).

**Downstream candidate quality.** Candidates are what validation and peer review
receive; the corpus has 29 true clusters.

| Config | Candidates | Contaminated (spans ≥ 2 labels) | Redundant (extra candidates per label) |
| --- | ---: | ---: | ---: |
| `D` | 32 | 5 | 8 |
| `E1` | 28 | 5 | 5 |
| `E2` | 44 | 1 | 16 |
| `S*` | 24 | 5 | 0 |

Validation and peer review were not run on these candidates, so this is a proxy.
Accepted-finding precision and recall downstream remain unmeasured.

## Why the embedding candidate lost

- **One wrong merge compounds.** `E1` made a single wrong escalated merge. It joined
  the path-escape defect (`expanded-authored-1`, `auditor-a/F-1`) with the
  "readPublicAsset may allow path traversal" false positive on the `DECOY-BOUND-PATH`
  decoy (`auditor-c/F-3`), at cosine 0.586 against τ = 0.55. Union-find carries that
  merge to both whole structural clusters, so one pair decision added 10 false-merge
  pairs in that run (FM 4 → 14). This was the fixture's intended hard case: similar
  vocabulary, a different verdict.
- **Cosine does not separate the ambiguous pairs.** `D` left 31 pairs ambiguous, and
  all 31 were within the escalation bound. The 19 same-label pairs span cosine
  0.19–0.77 and the 12 different-label pairs span 0.06–0.59. In the overlap band
  (0.44–0.59) there are 8 same-label and 6 different-label pairs, so no threshold
  separates them.
- **Hindsight does not rescue it.** In the descriptive in-sample sweep (not used for
  selection), the best `E1` threshold was 0.60 with W = 28. That is a 22% reduction,
  still short of the prespecified 25%, and a held-out choice could not have found it.
- **Most of `D`'s false merges are out of reach.** They are structural: distinct
  `NOISE:*` issues on the same symbol and lines as a defect, for example the `SELECT *`
  finding against the N+1 defect. No resolver at the escalation seam can undo those,
  and even the oracle has FM 13, above `D`, because its correct merges join already
  contaminated clusters. The remaining headroom is FS (14 pairs), which the oracle
  bound (ΔW −10) shows is modest.
- **`E2` without structure** trades splits for merges (FS 30) and ties `D` on W.

## Criteria (all prespecified)

| # | Criterion | Result | Measured |
| --- | --- | --- | --- |
| 1 | Evidence sufficiency | **fail** | mode `authored` (real-model findings required); 15 of the required 30 multi-member clusters; 47 of the required 100 same-label pairs; ambiguous pairs 31 against a minimum of 30; fixtures 2 against a minimum of 2 |
| 2 | Benefit (≥ 25% and CI < 0) | **fail** | W 36 → 49 (−36% reduction); ΔW +13 [−9, +42] |
| 3 | No defect loss | pass | 0 vs 0 |
| 4 | Downstream | pass | contaminated 5 vs 5; 3 redundant removed |
| 5 | Latency | pass | warm p95 363 ms (limit 750; 20 samples; run ≤ 21 findings); median 82 ms against `D`'s 2.8 ms; cold load 0.30 s from the local cache (limit 20 s) |
| 6 | Resources | pass | model 90.4 MB (limit 150); peak RSS growth 413 MB (limit 700; 65 → 478 MB); installed runtime dependencies 482 MB (limit 500) |
| 7 | Cost and locality | pass | $0; 0 network requests (fetch blocked and counted, remote loading disabled) |
| 8 | Reproducibility | pass | 5 repeats, identical assignments |

Two decision rules triggered, and each is sufficient on its own: `W(E1) ≥ W(D)` gives
REJECT, and criterion 1 alone would have given INSUFFICIENT EVIDENCE.

### Measurement notes

- **An earlier run had a different memory window.** The run at `b79eb5a` (tree
  modified) had the same clustering numbers, but its RSS peak also covered a
  descriptive 200-finding scaling probe, which the protocol does not include. That
  inflated RSS growth to 775 MB. The runner now takes the criterion-6 peak over model
  load and the protocol evaluation only, and records the probe's peak separately.
  Either way, the decision rests on criterion 2 and the no-reduction rule, not on
  resources.
- **Latency depends on host load.** Warm `E1` p95 was 109 ms in a run at load average
  about 7 and 363 ms in the recorded run at about 10.
- **Scaling probe (descriptive only).** One synthetic run of 200 relabelled findings
  took 2.9 s to embed and cluster (1.6 s in the less-loaded run), with a 607 MB peak
  RSS.
- **Cold load measures a warm OS file cache.** The figure covers pipeline construction
  plus one warm-up embed from `.cache`. The OS file cache may already have held the
  artifact, so a truly cold disk read would be slower.
- **The dependency footprint is near its ceiling.** `onnxruntime-node` ships binaries
  for every platform, and `@huggingface/transformers` also pulls in `onnxruntime-web`
  and `sharp`.

## Comparison with bounded LLM escalation

P18 makes no API calls, so the real accuracy of LLM escalation is **not measured**.
`S*` is its ceiling through the same seam. On this corpus, escalation would spend 31
model calls to gain at most ΔW −10. `E1` spends those calls locally for $0, but it is
worse than not escalating at all. Once P06 exists, the useful comparison is escalation
with the real verifier model against `S*`, with `E1` as the $0 alternative.

## Limits of this evidence

- **The findings are not model output.** They are hand-authored paraphrases written
  before any strategy ran and not revised afterwards. Real auditors may phrase findings
  more or less alike and may cite different locations.
- **The corpus is small.** It has 2 fixtures and 29 units. The `E1` interval
  [−9, +42] is wide, so a small benefit on other data is not excluded; a benefit on
  *this* data is.
- **One candidate model was tested.** Other embedders (larger or code-specific),
  alternative text templates, and non-transitive merge policies (for example, merge
  only when every cross-pair clears τ) were not evaluated. Testing them now would be
  post-hoc against this corpus and needs a new protocol version.

## Rerunning

The harness takes any corpus in the `clustering-authored-v1` shape: `mode`,
`sourceFixtures` with hashed ground-truth paths, and `runs[].findings[]`, each holding
`{ groundTruthId, auditorId, finding }`. To rerun on P06 real-model findings, label each
accepted finding with its ground-truth item, set `"mode": "real_models"`, then:

```sh
pnpm --dir tooling/embedding-eval install --ignore-workspace --frozen-lockfile
pnpm --dir tooling/embedding-eval fetch-model   # one-time download, hash-verified
pnpm --dir tooling/embedding-eval evaluate --corpus <path/to/p06-corpus.json>
```

The runner writes `docs/qa/p18/results/<corpusId>.json` with every identity and
setting listed above, and applies the same decision function
(`decideAdoption`). Criteria and thresholds change only with a new, separately
committed protocol version.
