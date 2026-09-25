# P18 — local embedding clustering: result and decision

**Decision: REJECT. Keep the existing clustering** (`structural-v1` plus bounded
semantic escalation). No adapter and no runtime dependency are added.

The rule that decided it, prespecified in [PROTOCOL.md](PROTOCOL.md): the embedding
candidate `E1` did not reduce the weighted error at all. `W` rose from 36 to 49.
The evidence-sufficiency criterion also fails, so this corpus could not have supported
adoption even with a positive result. **Rerun this evaluation on P06 real-model findings
before treating the question as closed**; see [Rerunning](#rerunning).

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
