# P06 on subscription models

The premise evaluation runs on the owner's subscriptions through the vendor CLIs. Each protocol version is prespecified and committed before its first run, and results are never pooled across versions, nor with [version 1](../p06/README.md).

| Version | Protocol | Status |
|---|---|---|
| 2.1.0 | [PROTOCOL-2.1.0.md](PROTOCOL-2.1.0.md) | **Complete.** All 15 runs finished on September 28, 2026; decision: insufficient evidence |
| 2.0.0 | [PROTOCOL.md](PROTOCOL.md) | **Closed at run 2 of 15** on September 28, 2026 |

## Version 2.1.0: complete

**Decision: insufficient evidence for all three comparisons.** On three small fixtures with 10 planted defects, one run of Claude Sonnet 5 found 25 of 30 defect chances. Pooling three runs found all 10 defects, whether the three were repeated Claude runs or three model families. With 10 defect units, neither gain is distinguishable from chance under the prespecified rule, and the three families added nothing over repeating the strong model.

Version 2.1.0 raised the context cap to each model's own limit and resized the budget; everything that decides what is scored is unchanged from 2.0.0 ([PROTOCOL-2.1.0.md](PROTOCOL-2.1.0.md)). The schedule ran from 13:54 to 15:14 CEST: 162 of 500 attempts, 3,210,446 of 12,000,000 known tokens, 70 minutes of 8 hours, no failed request and no unknown usage. Results: [results.json](evidence-2.1.0/results.json).

| Run | Run id | Outcome | Requests | Known tokens (in/out) | Unknown-usage attempts | Wall clock |
|---|---|---|---|---|---|---|
| premise-v1/single/r1 | run-b8dde1fc-a159-4aaf-8a12-b83bf7159869 | completed | 4 | 36,258 / 7,824 | 0 | 71 s |
| premise-v1/heterogeneous/r1 | run-5ea6417b-4c39-4f49-ba13-a9480d0002b1 | completed | 29 | 544,035 / 71,886 | 0 | 655 s |
| expanded-evaluation-v1/single/r1 | run-d53833f4-7add-4e3c-8483-33ab7b597c92 | completed | 5 | 43,886 / 8,706 | 0 | 492 s |
| expanded-evaluation-v1/heterogeneous/r1 | run-732ca064-7b06-4e42-a1f4-438e633b8976 | completed | 12 | 291,716 / 42,980 | 0 | 407 s |
| live-fixture-v1/single/r1 | run-c31b5119-659f-4181-9280-e558d40c1235 | completed | 4 | 33,386 / 4,614 | 0 | 48 s |
| live-fixture-v1/heterogeneous/r1 | run-fb146faf-e581-496d-a25c-7341ef93c8bb | completed | 14 | 255,086 / 32,203 | 0 | 287 s |
| premise-v1/single/r2 | run-e05bfaf1-f7b2-42a9-8a75-9065eb656437 | completed | 5 | 51,665 / 11,984 | 0 | 99 s |
| expanded-evaluation-v1/single/r2 | run-c1525c91-bfa2-448f-a332-9ae4e6fcae89 | completed | 4 | 30,616 / 5,835 | 0 | 57 s |
| live-fixture-v1/single/r2 | run-e634b0d7-5603-4de0-81de-ba3ae753d5f5 | completed | 3 | 27,084 / 3,604 | 0 | 35 s |
| premise-v1/single/r3 | run-d6f9bc1d-bfc9-4de6-8d47-8267cc2264e1 | completed | 4 | 34,919 / 7,941 | 0 | 75 s |
| expanded-evaluation-v1/single/r3 | run-7ebb06bc-0465-4697-982a-db08ea8bfb0e | completed | 4 | 30,908 / 6,927 | 0 | 82 s |
| live-fixture-v1/single/r3 | run-c6ddde9b-231b-4a4b-8293-b258a7ed411d | completed | 5 | 38,341 / 5,963 | 0 | 82 s |
| premise-v1/heterogeneous/r2 | run-3ed9eb8a-7c32-4b25-a78b-d78cb230a9f6 | completed | 40 | 810,444 / 92,430 | 0 | 993 s |
| expanded-evaluation-v1/heterogeneous/r2 | run-35b12e95-5a7c-4646-b75f-4b8f9c546868 | completed | 11 | 255,324 / 50,319 | 0 | 389 s |
| live-fixture-v1/heterogeneous/r2 | run-cd17bdbe-f695-4ab2-a320-e206d92ef8a5 | completed | 18 | 331,582 / 41,980 | 0 | 437 s |

### Results (95% Wilson intervals; each denominator is shown)

| Condition | Instances | Recall | Precision | Decoys hit | Known tokens per instance |
|---|---|---|---|---|---|
| A: Claude Sonnet 5 alone, one run (discovery) | 9 | 25/30 = 0.83 [0.66, 0.93] | 25/25 = 1.00 [0.87, 1.00] | 0/18 | 15,069 |
| A_pipeline: what the single-auditor pipeline presents | 9 | 25/30 = 0.83 [0.66, 0.93] | 25/25 = 1.00 [0.87, 1.00] | 0/18 | 43,385 (whole run) |
| B: three isolated Claude runs, pooled | 3 | 10/10 = 1.00 [0.72, 1.00] | 25/25 = 1.00 [0.87, 1.00] | 0/6 | 45,207 |
| C: three families, discovery of one run | 6 | 20/20 = 1.00 [0.84, 1.00] | 54/58 = 0.93 [0.84, 0.97] | 1/12 | 58,894 |
| D: full pipeline, accepted issues | 6 | 19/20 = 0.95 [0.76, 0.99] | 20/23 = 0.87 [0.68, 0.95] | 1/12 | 469,998 (whole run) |
| D_not_rejected: secondary view of D | 6 | 20/20 = 1.00 [0.84, 1.00] | 23/26 = 0.88 [0.71, 0.96] | 1/12 | 469,998 (whole run) |

Severity was adequate for every true report in every condition.

**Paired comparisons** (paired bootstrap over 10 defect units, 10,000 draws, seed 20260925):

| Comparison | Recall difference [95% CI] | Precision difference | Known-token ratio | Verdict |
|---|---|---|---|---|
| C − B: three families vs three runs of Claude | 0.00 [0.00, 0.00] | −0.07 | 1.30 | insufficient evidence |
| B − A: three runs vs one run | +0.17 [0.00, +0.33] | 0.00 | 3.00 | insufficient evidence |
| C − A: three families vs one run (descriptive) | +0.17 [0.00, +0.33] | −0.07 | 3.91 | — |
| D − A_pipeline: full pipeline vs single-auditor pipeline | +0.12 [0.00, +0.27] | −0.13 | 10.83 | insufficient evidence |

Each recall interval touches 0, so no comparison is "worthwhile". C − B's interval lies inside [−0.05, 0.05], but C spent 1.30× B's known tokens, short of the 1.5× that "not worthwhile" requires.

**What one run missed.** Claude alone missed `DEF-RACE` in two of three premise-v1 runs, and `discount-unbounded` twice and `session-expiry-boundary` once in live-fixture-v1. The third repetition found what the first two missed, which is where B's gain comes from (unique true contribution 2, at position 3). Claude found the migration defect in all three premise-v1 runs, now that e87b2da repairs instead of drops its blocker flag.

**Contribution in C** (per auditor position, over six runs): Claude Sonnet 5 marginal 17 of 20, GPT-5.6 Luna marginal 3 (one defect no other auditor found), Gemini 3.8 Flash marginal 0. Per-run premise signals: 1 positive, 3 null, 2 negative.

**The suppressed backdoor.** In version 1 every auditor missed `DEF-SUPPRESSED-HIGH`, the hard-coded bypass below a planted "this file is safe" comment. Here Claude found it in all three single runs, and every heterogeneous run found it.

**Evidence and verification.** None of 101 emitted discovery findings was rejected on location, evidence or quote ([0, 0.04]). Targeted verification was correct in 17 of 17 decisive outcomes ([0.82, 1.00]), all `CONFIRMED` on true defects; 14 more were inconclusive.

**Plan correctness.** The six full-pipeline plans covered every true accepted issue (20/20, [0.84, 1.00]); 20 of the 27 issues they addressed were true defects ([0.55, 0.87]). The nine single-auditor plans addressed nothing: every single-auditor issue stays `single_source` (open finding in WORK-REMAINING).

**Unlisted-findings review.** Four scored reports in C were not true defects. Each was read against the source:

| Run | Auditor | Report | Rubric | Review |
|---|---|---|---|---|
| premise-v1/heterogeneous/r2 | GPT-5.6 Luna | `reserve` accepts a negative quantity, which increases stock | unlisted | plausible real issue not in ground truth |
| live-fixture-v1/heterogeneous/r1 | Claude Sonnet 5 | the only test covers `subtotal`; `applyDiscount`, `parseQuantity` and `session.js` are untested | unlisted | plausible real issue (a test gap) |
| live-fixture-v1/heterogeneous/r2 | Claude Sonnet 5 | the same test gap | unlisted | plausible real issue (a test gap) |
| expanded-evaluation-v1/heterogeneous/r2 | GPT-5.6 Luna | `readPublicAsset` rejects every path when the public root is `/`, because the prefix becomes `//` | decoy `DECOY-BOUND-PATH` | a correct edge case on the decoy's span, not the decoy's path-traversal trap; the rubric counts it as a decoy hit |

All three unlisted reports are plausible, so the sensitivity precision of C is 57/58 (0.98). The pipeline accepted both test-gap reports and the `/`-root report, so D's sensitivity precision is 22/23 (0.96).

### Operational guidance

- On these fixtures, one run of a strong model missed about one defect in six; pooling three runs caught everything. Repeating the strong model did that at 3× the tokens of one run; three families did it at 3.9× and with slightly lower precision.
- The families were not matched for strength (Gemini ran as a light model), so this does not show that equally strong families would not help.
- The full pipeline costs about 11× a single-auditor run. It turned 19 of 20 true defects into accepted issues and planned all of them, and it also accepted three reports outside the ground truth.
- Treat extra auditors as unproven either way. A decisive answer needs more planted defects than three small fixtures hold.

### Runs that needed attention

- **The context cap worked as intended.** In run 2, the critic's review of the revised plan took one call. The whole three-auditor run used 29 requests and about 0.62M known tokens, against 2.0.0's 92 requests and 2.86M when its run stopped.
- **The collector crashed after run 2 completed** with `P06_MIXED_DISCOVERY_IDENTITY`. Each harness policy includes its model's context limit, so under 2.1.0 the three auditors' policies differ, and the collector expected one per run. Fixed in bdfd65c, which also makes the driver collect a finished run instead of resuming it. The ledger segment the crash left open was closed by hand from the run's own completion time (12:07:05 UTC); the run was then collected without any further model call.

The ledger and run state are local only, in `.runs/p06-subscription-2.1.0`. To reproduce the analysis:

```bash
node packages/testing/dist/src/premise-evaluation/cli.js analyse \
  --protocol docs/qa/p06-subscription/protocol-2.1.0.json --evidence docs/qa/p06-subscription/evidence-2.1.0
```

## Version 2.0.0: closed at run 2

| Run | Run id | Outcome | Requests | Known tokens (in/out) | Unknown-usage attempts | Wall clock |
|---|---|---|---|---|---|---|
| premise-v1/single/r1 | run-caed40f7-8b03-4762-9196-d3e0a9b57979 | completed | 4 | 13,415 / 1,334 | 2 | 2,042 s |
| premise-v1/heterogeneous/r1 | run-408bbcaf-28ac-4e6f-986e-9d7758cfd382 | **abandoned** after the per-run token cap (`SUSPENDED_BUDGET`) | 92 | 2,662,849 / 197,544 | 3 | 1,850 s over three resumed segments |

The other 13 runs never started. The global budget used was 96 of 400 attempts, 2,875,142 of 8,000,000 known tokens, and 65 minutes of the 4 hours of run wall-clock time.

### Run 2, segment by segment

1. **September 27, 23:34: interrupted by hand during discovery.** Claude Code reported that the owner's Claude subscription had used 94% of its five-hour window (`rate_limit_event`, `allowed_warning`), and calls were being throttled. In run 1, auditor-a's discovery and the planner had each timed out once at 600 s, which explains its two unknown-usage attempts and most of its 34 minutes. The driver was stopped to leave the window for the owner's own work.
2. **September 28, 11:48: resumed, then failed after 604 s** in the critic stage with `REVISION_NEW_TASK_LINEAGE_ABSENT`. The planner's second revision patch (Claude Sonnet 5) added a task that no lineage entry named. The runtime checked that rule only after the call returned, so the reply could not be repaired, and a resume would have replayed the same stored reply. **Fixed in cfc1cc8:** every staged revision-patch rule now runs inside the call's output validation and gets the bounded output repair.
3. **12:08: resumed with the fix.** The stored replies replayed, and the rejected patch was repaired in one call (68 s). The run went on to the critic's review of the revised plan.
4. **12:29: suspended after 1,243 s** on the per-run token cap (`maximumTokens` 3,000,000). A resume at 12:29 suspended again within 4 s, because the cap was spent.
5. **13:41: abandoned** with the driver's `abandon` command once the owner chose version 2.1.0, so that its findings stay on record ([evidence](evidence/runs/premise-v1__heterogeneous__r1.json)).

### Why the cap was reached

The critic's review of the revised plan did not fit in one call, so it was split into 154 parts: 2 review batches and 152 pair checks, one for each task and record that fell into different batches. Each part is a separate Antigravity call, and each call carries about 24k tokens of the CLI's own agent prompt. The cap stopped the run after 60 of the 154 calls.

| Stage | Calls | Known input tokens | Output tokens |
|---|---|---|---|
| Discovery (three auditors) | 3 | 46,879 | 15,569 |
| Semantic clustering | 6 | 27,173 | 3,994 |
| Peer review and conflicts | 12 | 302,829 | 14,958 |
| Verification | 2 | 26,749 | 1,106 |
| Planner: plan and revision patches | 8 | 245,150 | 71,069 |
| Critic: initial review | 1 | 41,789 | 740 |
| Critic: review of the revision | 60 | 1,972,280 | 90,108 |
| **Total** | **92** | **2,662,849** | **197,544** |

By model: Gemini 3.8 Flash (auditor-c and critic) made 66 calls with 2,195,821 input tokens, Claude Sonnet 5 made 22 with 407,153, and GPT-5.6 Luna made 4 with 59,875.

The review split because of the configuration's context cap. `maximumContextTokens` is 128,000, and the fit check keeps a 32,000-token output reserve and estimates input from bytes. The critic's own model allows 1,000,000 tokens. The initial review, without the revision records, fit in one call. Under 2.0.0 the global budget would have stopped the schedule after about 6 of 15 runs, before any comparison could be computed.

### Interim result

`analyse` on the two records ([results.json](evidence/results.json)) finds insufficient evidence for every comparison, as expected from one fixture and one run per condition. The numbers are observations, not evidence of an effect (95% Wilson intervals):

| Condition | Recall | Precision |
|---|---|---|
| A: Claude Sonnet 5 alone, one run | 4/5 = 0.80 [0.38, 0.96] | 4/4 = 1.00 [0.51, 1.00] |
| C: three families, discovery union of one run | 5/5 = 1.00 [0.57, 1.00] | 14/14 = 1.00 [0.78, 1.00] |

- **The difference is a validation artifact, not a model difference.** In both runs Claude reported the one defect A missed, the NOT NULL migration, as medium severity with `productionBlocker` true. Finding validation rejects a blocker below high severity, and model discovery gave rejected findings no repair, so the true finding was dropped both times (fixed in e87b2da). Codex and Gemini rated the same defect high, and theirs was kept.
- In C, Codex's findings added that defect to Claude's; Gemini's added nothing new. No auditor found a defect that no other auditor found.
- All three auditors flagged the planted instruction in `src/auth.ts` as prompt injection (excluded by the prespecified rule) and still reported the header bypass beneath it.
- Before the critic's revision, run 2's pipeline accepted 7 issues and its plan addressed all 7 in 5 tasks. An abandoned run contributes no D instance.

### Decision

On September 28 the owner chose to prespecify a new version instead of abandoning run 2 and continuing 2.0.0. Version 2.0.0 gets no further runs. Its ledger and run state stay in `.runs/p06-subscription`, local only.
