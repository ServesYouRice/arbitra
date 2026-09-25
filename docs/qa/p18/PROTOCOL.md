# P18 protocol — local embedding clustering evaluation

Status: **prespecified**. This file and the corpus it names were committed before any
comparison ran. The results and the decision live in [README.md](README.md); nothing
below may be changed after results exist except by a new, separately committed protocol
version that says what changed and why.

## Question

Does a locally evaluated sentence-embedding model reduce clustering errors enough, at
acceptable latency, resource use and cost, to justify an opt-in adapter next to the
deterministic structural clustering (`structural-v1`,
`packages/workflow/src/clustering/deterministic.ts`) and the bounded semantic escalation
(`packages/workflow/src/clustering/escalate.ts`)?

## Candidate (pinned)

| Field | Value |
| --- | --- |
| Model | `Xenova/all-MiniLM-L6-v2` (ONNX export of `sentence-transformers/all-MiniLM-L6-v2`, Apache-2.0) |
| Revision | Hugging Face commit `751bff37182d3f1213fa05d7196b954e230abad9` |
| Artifact | `onnx/model.onnx`, fp32, 90,387,606 bytes, sha256 `759c3cd2b7fe7e93933ad23c4c9181b7396442a2ed746ec7c1d46192c469c46e` |
| Runtime | `@huggingface/transformers` 4.3.0 (exact), its pinned `onnxruntime-node` 1.30.0, Node 22, CPU |
| Pooling | mean pooling, L2-normalised; similarity is the cosine (dot product) |
| Input text | template `finding-text-v1`: `title + "\n" + problem + "\n" + recommendedFix` (locations excluded; structure is the deterministic strategy's job) |

The artifact hash is verified before use; a mismatch aborts the run. Inference runs
with remote model loading disabled, so the measured run makes no network request. The
model is fetched once, beforehand, into a local cache.

## Corpus

`packages/testing/corpora/clustering/authored-v1.json` (`clustering-authored-v1`,
version 1): 4 runs, 58 accepted findings from 7 authored auditors over the P05 fixtures
`premise-v1` and `expanded-evaluation-v1`, whose ground-truth files are pinned by sha256.
Each finding is labelled with the ground-truth item it reports; `NOISE:*` labels are
distinct issues outside the fixture ground truth, each its own true cluster. Ground-truth
clusters are *(run, label)*: clustering runs per audit run, so findings from different
runs are never compared.

The findings are hand-written paraphrases, **not model output**. They were written
before any strategy was run on them and were not revised after.

## Configurations

| Id | Description | Adoption-eligible |
| --- | --- | --- |
| `D` | Deterministic only: `structural-v1`, ambiguous pairs stay separate (`maximumEscalatedPairs = 0`). Baseline. | — |
| `E1` | `structural-v1`, then up to 20 ambiguous pairs (deterministic order, as `model-pipeline` does) resolved locally: merge when cosine ≥ τ, otherwise separate. Plugs into the existing `SemanticClusteringRuntime` seam with zero tokens and zero cost. | **yes (the candidate)** |
| `E2` | Embedding only: single-linkage over all pairs with cosine ≥ τ₂, no structural signals. | no, descriptive |
| `S*` | `structural-v1` + escalation of up to 20 ambiguous pairs by a ground-truth oracle. Upper bound on what any semantic resolver (LLM escalation included) can achieve through the escalation seam. | no, descriptive |

LLM escalation accuracy cannot be measured locally (no API calls in P18); `S*` bounds it
and the ambiguous-pair count is the number of model calls escalation would spend.

### Threshold selection

τ (for `E1`) and τ₂ (for `E2`) are chosen leave-one-fixture-out from the grid
0.30, 0.35, …, 0.95: for each fixture, the threshold minimising the weighted error `W`
(below) over the *other* fixtures' runs is applied to that fixture. Ties go to the higher
threshold (fewer merges). Only held-out predictions are scored.

## Measures

Over all finding pairs within a run, pooled over runs:

- **False merge (FM)**: pair in one predicted cluster, different ground-truth labels.
- **False split (FS)**: pair in different predicted clusters, same ground-truth label.
- **Weighted error `W = 2·FM + FS`** (primary). A false merge can hide a distinct issue
  from validation and peer review; a false split costs a duplicate candidate.
- **Defect-loss merges**: FM pairs whose two labels are both ground-truth *defects* (one
  real defect absorbed into another's candidate).
- Pair precision/recall, predicted candidate count, contaminated candidates (members span
  ≥ 2 labels), redundant candidates (Σ over labels of candidates containing it − 1) as the
  downstream finding-quality proxy: candidates are what validation and peer review see.
- Warm latency per run (`E1`: embed every finding of the run + cluster), median and p95
  over 5 repeats; cold model load from local cache; peak RSS and RSS growth; artifact
  size; installed runtime dependency size; cost.

**Interval.** Paired cluster bootstrap: units are ground-truth clusters; each unit
carries its internal FS pairs plus half of every FM pair it takes part in (units sum to
the totals). 10,000 resamples, mulberry32 seed 18, percentile 95% interval for
`W(E1) − W(D)`.

## Adoption criteria (all must hold for ADOPT)

1. **Evidence sufficiency.** The corpus includes real-model findings (`mode:
   "real_models"`, P06 or later), spans ≥ 2 fixtures, and has ≥ 30 multi-member
   ground-truth clusters, ≥ 100 same-label pairs and ≥ 30 `D` ambiguous pairs.
2. **Benefit.** `W(E1)` is at least 25% below `W(D)` and the 95% interval of
   `W(E1) − W(D)` lies entirely below 0.
3. **No defect loss.** `E1` defect-loss merges ≤ `D` defect-loss merges.
4. **Downstream.** `E1` contaminated candidates ≤ `D` contaminated candidates + the
   number of `D` redundant candidates it removes (it may not trade a duplicate for a
   contamination at worse than 1:1).
5. **Latency.** Warm `E1` p95 ≤ 750 ms per run of ≤ 25 findings; cold model load ≤ 20 s.
6. **Resources.** Model artifact ≤ 150 MB; peak RSS growth over the deterministic-only
   process ≤ 700 MB; installed runtime dependencies ≤ 500 MB.
7. **Cost and locality.** $0 marginal cost; zero network requests during measurement.
8. **Reproducibility.** 5 repeated `E1` runs produce identical cluster assignments.

## Decision rules

- **REJECT** if any of 5–8 fails; or `W(E1) ≥ W(D)` (no reduction observed); or `E1`
  defect-loss merges exceed `D`'s; or criterion 1 holds but 2 or 4 fails.
- **INSUFFICIENT EVIDENCE — retain existing clustering** if nothing above triggers
  REJECT but criterion 1 fails, or criterion 2's interval includes 0. On an authored-only
  corpus this is the most favourable possible outcome; the evaluation must be rerun on
  P06 real-model findings.
- **ADOPT** only when all of 1–8 hold. Adoption means an opt-in adapter (off by
  default) with pinned identity/versioning, fallback to `structural-v1` on any embedder
  failure, and regression coverage.

`E2` and `S*` never change the decision; they explain it.

## Reproducibility

The harness is `packages/workflow/src/clustering/evaluation.ts` (pluggable embedder;
the deterministic stand-in embedder exists only in tests) and the runner is
`tooling/embedding-eval/` (its own lockfile, not a workspace package, so the model
runtime never becomes a runtime dependency). Every report records the corpus id, version
and sha256, fixture ground-truth hashes, protocol version (`p18-protocol-v1`), model,
revision, artifact hash, runtime versions, text template, grid, escalation bound,
bootstrap seed/resamples and host. Rerunning on a new corpus is one command with
`--corpus <file>`.
