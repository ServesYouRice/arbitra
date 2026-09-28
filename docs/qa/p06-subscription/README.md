# P06 on subscription models (protocol 2.0.0): interim, stopped at run 2 by the per-run token cap

**Status: started; stopped at run 2. A protocol decision is needed before any further run.** The protocol ([PROTOCOL.md](PROTOCOL.md)) was committed in 9fbd2de before any run. The driver ran on September 27, 2026 from 23:00 CEST and was resumed on September 28.

| Run | Run id | Outcome | Requests | Known tokens (in/out) | Unknown-usage attempts | Wall clock |
|---|---|---|---|---|---|---|
| premise-v1/single/r1 | run-caed40f7-8b03-4762-9196-d3e0a9b57979 | completed | 4 | 13,415 / 1,334 | 2 | 2,042 s |
| premise-v1/heterogeneous/r1 | run-408bbcaf-28ac-4e6f-986e-9d7758cfd382 | **suspended** on the per-run token cap (`SUSPENDED_BUDGET`) | 92 | 2,662,849 / 197,544 | 3 | 1,850 s over three resumed segments |

13 runs have not started. The global budget used so far is 96 of 400 attempts, 2,875,142 of 8,000,000 known tokens, and 65 minutes of the 4 hours of run wall-clock time.

No result is analysed until the schedule completes or a budget stops it. Version 1's interim results ([qa/p06](../p06/README.md)) are not pooled with these.

## Run 2, segment by segment

1. **September 27, 23:34: interrupted by hand during discovery.** Claude Code reported that the owner's Claude subscription had used 94% of its five-hour window (`rate_limit_event`, `allowed_warning`), and calls were being throttled. In run 1, auditor-a's discovery and the planner had each timed out once at 600 s, which explains its two unknown-usage attempts and most of its 34 minutes. The driver was stopped to leave the window for the owner's own work.
2. **September 28, 11:48: resumed, then failed after 604 s** in the critic stage with `REVISION_NEW_TASK_LINEAGE_ABSENT`. The planner's second revision patch (Claude Sonnet 5) added a task that no lineage entry named. The runtime checked that rule only after the call returned, so the reply could not be repaired, and a resume would have replayed the same stored reply. **Fixed in cfc1cc8:** every staged revision-patch rule now runs inside the call's output validation and gets the bounded output repair. A regression test covers it, and the runtime suite passed (514 tests).
3. **12:08: resumed with the fix.** The stored replies replayed, and the rejected patch was repaired in one call (68 s). The run went on to the critic's review of the revised plan.
4. **12:29: suspended after 1,243 s** on the per-run token cap (`maximumTokens` 3,000,000). A resume at 12:29 suspended again within 4 s, as expected, because the cap is spent.

## Why the cap was reached

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

The review split because of the configuration's context cap. `maximumContextTokens` is 128,000, and the fit check keeps a 32,000-token output reserve and estimates input from bytes. The critic's own model allows 1,000,000 tokens. The initial review, without the revision records, fit in one call.

## What this means for the rest of the schedule

Under 2.0.0, any heterogeneous run whose revision review splits will fan out the same way and stop at the per-run cap. At about 3 million tokens per such run, the global budget allows about two more. The schedule would then stop after about 6 of its 15 runs, before the second and third single-model repetitions. Without them, C − B and B − A cannot be computed.

The protocol cannot change within a version. The options are:

- **Continue 2.0.0:** retire run 2 with the driver's `abandon` command, which keeps its discovery scored and its failure on record, then resume. The budget will probably stop the schedule before any comparison can be computed.
- **Prespecify 2.1.0 before any further run:** raise `maximumContextTokens` so that each model's own limit applies and the critic reviews in one call, and size the budgets from this run. The schedule starts fresh, and 2.0.0's runs stay on record, unpooled.

Either way, the fan-out is also a product finding. A staged critic review costs one call per cross-batch task and record pair, which is expensive on CLI transports that add a fixed prompt to every call.

## Resume

Resuming premise-v1/heterogeneous/r1 under 2.0.0 suspends at once until it is abandoned or the protocol changes. The commands, for when a decision is made:

```bash
pnpm build
caffeinate -is node packages/testing/dist/src/premise-evaluation/cli.js run \
  --protocol docs/qa/p06-subscription/protocol.json \
  --state .runs/p06-subscription --evidence docs/qa/p06-subscription/evidence
node packages/testing/dist/src/premise-evaluation/cli.js abandon \
  --protocol docs/qa/p06-subscription/protocol.json \
  --state .runs/p06-subscription --evidence docs/qa/p06-subscription/evidence \
  --key premise-v1/heterogeneous/r1 --reason "<why>"
```

The ledger and run state are local only, in `.runs/p06-subscription`; keep that folder. The driver stops at the first incomplete run, so it is safe to invoke repeatedly. To finish sooner without exhausting a usage window, pass `--max-runs N`.

When the schedule is done, run `cli.js analyse` with the same `--protocol` and `--evidence`, then record the results here.
