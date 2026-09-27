# P06 on subscription models (protocol 2.0.0): interim, paused by the Claude usage window

**Status: started, paused.** The protocol ([PROTOCOL.md](PROTOCOL.md)) was committed in 9fbd2de before any run. The driver then ran on September 27, 2026 from 23:00 CEST:

| Run | Run id | Outcome | Requests | Known tokens (in/out) | Unknown-usage attempts | Wall clock |
|---|---|---|---|---|---|---|
| premise-v1/single/r1 | run-caed40f7-8b03-4762-9196-d3e0a9b57979 | completed | 4 | 13,415 / 1,334 | 2 | 2,042 s |
| premise-v1/heterogeneous/r1 | run-408bbcaf-28ac-4e6f-986e-9d7758cfd382 | **interrupted** during discovery; resumes with the next driver invocation | — | — | — | — |

13 runs have not started.

**Why it stopped.** Claude Code reported that the owner's Claude subscription had used 94% of its five-hour window (`rate_limit_event`, `allowed_warning`), and model calls were being throttled. In the completed run, auditor-a's discovery and the planner each timed out once at 600 s and succeeded on the second attempt. That throttling explains the two unknown-usage attempts and most of the 34-minute wall clock.

The driver was stopped by hand at that point, to leave the owner's window for their own work. The interrupted run is resumed, never restarted, as the protocol requires.

No result is analysed until the schedule completes or a budget stops it. Version 1's interim results ([qa/p06](../p06/README.md)) are not pooled with these.

## Resume

After the five-hour window resets, run from the repository root:

```bash
pnpm build
caffeinate -is node packages/testing/dist/src/premise-evaluation/cli.js run \
  --protocol docs/qa/p06-subscription/protocol.json \
  --state .runs/p06-subscription --evidence docs/qa/p06-subscription/evidence
```

The ledger and run state are local only, in `.runs/p06-subscription`; keep that folder. The driver stops at the first incomplete run, so it is safe to invoke repeatedly. To finish sooner without exhausting a usage window, pass `--max-runs N`.

When the schedule is done, run `cli.js analyse` with the same `--protocol` and `--evidence`, then record the results here.
