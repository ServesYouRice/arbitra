# P06 on subscription models

The premise evaluation runs on the owner's subscriptions through the vendor CLIs. Each protocol version is prespecified and committed before its first run, and results are never pooled across versions, nor with [version 1](../p06/README.md).

| Version | Protocol | Status |
|---|---|---|
| 2.1.0 | [PROTOCOL-2.1.0.md](PROTOCOL-2.1.0.md) | **Current.** Prespecified on September 28, 2026, before any run |
| 2.0.0 | [PROTOCOL.md](PROTOCOL.md) | **Closed at run 2 of 15** on September 28, 2026 |

## Version 2.1.0

Version 2.1.0 raises the context cap to each model's own limit, so the critic reviews a revised plan in one call, and resizes the budget from 2.0.0's run 2. It runs on the runtime with the three fixes 2.0.0 exposed. Everything that decides what is scored is unchanged ([PROTOCOL-2.1.0.md](PROTOCOL-2.1.0.md)).

The schedule started on September 28 at 13:54 CEST. Results are recorded here as it advances.

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

- **The context cap worked as intended.** The critic's review of the revised plan took one call, and the whole three-auditor run used 29 requests and about 0.62M known tokens, against 2.0.0's 92 requests and 2.86M when its run stopped.
- **The collector crashed after run 2 completed** with `P06_MIXED_DISCOVERY_IDENTITY`. Each harness policy includes its model's context limit, so under 2.1.0 the three auditors' policies differ, and the collector expected one per run. Fixed in bdfd65c, which also makes the driver collect a finished run instead of resuming it. The ledger segment the crash left open was closed by hand from the run's own completion time (12:07:05 UTC); the run was then collected without any further model call.

To run or resume, from the repository root:

```bash
pnpm build
caffeinate -is node packages/testing/dist/src/premise-evaluation/cli.js run \
  --protocol docs/qa/p06-subscription/protocol-2.1.0.json \
  --state .runs/p06-subscription-2.1.0 --evidence docs/qa/p06-subscription/evidence-2.1.0
```

The ledger and run state are local only, in `.runs/p06-subscription-2.1.0`; keep that folder. The driver stops at the first incomplete run, so it is safe to invoke repeatedly; `--max-runs N` limits one invocation. When the schedule is done, run `cli.js analyse` with the same `--protocol` and `--evidence`, then record the results here.

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
